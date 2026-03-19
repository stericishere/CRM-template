# Architecture: Proactive Operations (Cron Jobs + Follow-Up Timers)

**Feature:** System health checks, appointment reminders, follow-up triggers, memory compaction
**Depends on:** Core messaging (Phase 1), AI drafting + booking (Phase 2)
**Ships in:** Phase 3 (Sprint 3)
**References:** PRD v2.1 SS9.6, SS9.7, SS13.5; Architecture v1.0 SS5, SS6; OpenClaw Cron/Heartbeat Research

---

## 1. Design overview

### 1.1 Core principle

Proactive operations separate **triage** (cheap, deterministic database queries) from **execution** (LLM-powered drafting). The cron layer identifies what needs attention. The Client Worker layer drafts contextual responses. Staff approves everything.

### 1.2 Four cron jobs

| Job | Schedule | LLM | Purpose |
|---|---|---|---|
| System heartbeat | Every 2 hours | No | Infrastructure health monitoring |
| Appointment reminder | Daily 9 AM workspace TZ | No (template fill) | Remind clients about tomorrow's appointments |
| Follow-up trigger | Hourly scan | Yes (Client Worker) | Follow up with open clients 72h after last message |
| Memory compaction | Daily 3 AM workspace TZ | Yes (summarization) | Compact conversation memory |

### 1.3 Infrastructure

All cron jobs use the same pipeline:

```
pg_cron (Postgres scheduler, built into Supabase)
    |
    +-> SELECT net.http_post() to Supabase Edge Function
              |
              +-> Job logic (SQL queries, API calls)
              +-> If action needed: create ProposedAction OR queue Client Worker
              +-> Audit log entry
```

Why pg_cron + Edge Functions (not BullMQ scheduled jobs):
- pg_cron is native to Supabase -- zero additional infrastructure
- Triggers Edge Functions via pg_net HTTP calls
- Schedule persistence is automatic in Postgres
- Works even if the application server is temporarily down
- Edge Functions are serverless -- no long-running process

---

## 2. Data model additions

### 2.1 New fields on existing tables

**Conversation table -- add:**

| Field | Type | Description |
|---|---|---|
| `follow_up_trigger_at` | Timestamp (nullable) | When to trigger follow-up. NULL = no pending. Set to `last_client_message_at + 72h` when conversation is open. Reset on new client message. Cleared on booking or dismissal. |
| `follow_up_attempt_count` | Integer | Default 0. Incremented each time a follow-up is sent. |

**Workspace table -- add:**

| Field | Type | Description |
|---|---|---|
| `last_heartbeat_at` | Timestamp (nullable) | Last successful health check |
| `follow_up_delay_hours` | Integer | Default 72. Configurable per workspace. |
| `follow_up_max_attempts` | Integer | Default 3. Stop after N unanswered follow-ups. |
| `follow_up_cooldown_hours` | Integer | Default 168 (7 days). Between follow-up attempts after the first. |
| `reminder_mode` | Enum | `template` (default), `ai_draft` |

**Booking table -- add:**

| Field | Type | Description |
|---|---|---|
| `reminder_sent_at` | Timestamp (nullable) | When the reminder was sent. NULL = not yet sent. |

### 2.2 New table: cron_run_log

Track every cron execution for observability.

| Field | Type | Description |
|---|---|---|
| `run_id` | UUID | Primary key |
| `workspace_id` | UUID | FK |
| `job_type` | Enum | `heartbeat`, `appointment_reminder`, `follow_up_trigger`, `memory_compaction` |
| `started_at` | Timestamp | |
| `completed_at` | Timestamp (nullable) | |
| `status` | Enum | `running`, `completed`, `failed`, `skipped` |
| `items_found` | Integer | How many clients/bookings matched the query |
| `items_actioned` | Integer | How many ProposedActions or Client Worker calls created |
| `error_message` | Text (nullable) | |
| `metadata` | JSON | Job-specific details |

---

## 3. Job 1: System heartbeat

### 3.1 Specification

| Property | Value |
|---|---|
| Schedule | Every 2 hours |
| LLM | No |
| Edge Function | `cron-heartbeat` |
| Duration target | < 5 seconds |

### 3.2 Flow

```
pg_cron fires every 2h
    |
    v
Edge Function: cron-heartbeat
    |
    +-> Check 1: WhatsApp connection
    |     Ping Baileys server / check last webhook received timestamp
    |     If no webhook in last 30 min -> status = "degraded"
    |     If no webhook in last 2h -> status = "disconnected"
    |     Write workspace.whatsapp_connection_status
    |
    +-> Check 2: Message pipeline health
    |     Query pgmq: count messages in queue older than 5 minutes
    |     Query DLQ: count messages in dead letter queue
    |     If queue depth > 50 OR DLQ > 0 -> flag alert
    |
    +-> Check 3: LLM availability
    |     HTTP HEAD to OpenRouter /api/v1/models (or configured provider)
    |     If timeout or 5xx -> flag alert
    |
    +-> Check 4: Calendar connection
    |     If calendar_config is set: attempt lightweight API call
    |     If auth expired -> flag for re-auth
    |
    v
    Write workspace.last_heartbeat_at = NOW()
    |
    v
    If any alerts flagged:
        Insert notification record -> staff app shows alert banner
    |
    v
    Write cron_run_log entry
```

---

## 4. Job 2: Appointment reminder

### 4.1 Specification

| Property | Value |
|---|---|
| Schedule | Daily at 9 AM workspace timezone |
| LLM | No -- template fill only |
| Edge Function | `cron-appointment-reminder` |
| Duration target | < 30 seconds |

### 4.2 Flow

```
pg_cron fires daily at 9 AM (per workspace TZ)
    |
    v
Edge Function: cron-appointment-reminder
    |
    v
Query: bookings for tomorrow where reminder not sent
    |
    v
For each booking: fill template
    |
    |  Template: "Hey {client_name}! Just a friendly reminder --
    |  you have your {appointment_type} appointment tomorrow
    |  at {time}. See you then!"
    |
    v
Create ProposedAction for each
    |  actionType: "message_send"
    |  tier: "review"
    |  payload: { clientId, content, bookingId, type: "appointment_reminder" }
    |
    v
Staff sees reminder cards in Today's View
    |  One-tap approve, or edit before sending
    |
    v
On approval:
    |  Send via WhatsApp
    |  Set booking.reminder_sent_at = NOW()
    |  Audit log: reminder_sent
```

### 4.3 Template system

Default templates pre-created during onboarding. Template variables: `{client_name}`, `{appointment_type}`, `{time}`, `{business_name}`.

### 4.4 Opt-in AI drafting

If `workspace.reminder_mode = "ai_draft"`, the Edge Function queues Client Worker invocations instead of filling templates. The Client Worker drafts personalized reminders using full client context.

---

## 5. Job 3: Follow-up trigger

### 5.1 Specification

| Property | Value |
|---|---|
| Schedule | Hourly scan (pg_cron) |
| LLM | Yes -- Client Worker drafts contextual follow-up |
| Edge Function | `cron-followup-trigger` |
| Duration target | < 60 seconds for scan; Client Worker calls async |

### 5.2 The per-client timer model

Event-driven timer per client:

```
Client sends message -> staff replies -> no booking made
    |
    v
follow_up_trigger_at = last_client_message_at + 72 hours
    |
    +-> Client messages again within 72h?
    |     follow_up_trigger_at = NOW() + 72h (reset)
    |
    +-> Client books appointment?
    |     follow_up_trigger_at = NULL (cleared)
    |
    +-> 72h passes with no response?
          -> hourly scanner picks it up
```

### 5.3 Timer lifecycle

**Timer starts** when staff sends a reply and no active booking exists.
**Timer resets** when client sends a new message.
**Timer clears** on booking, dismissal, inactive marking, or max attempts reached.

### 5.4 Scanner flow

```
pg_cron fires every hour
    |
    v
Query: conversations with expired timers
    |
    |  (Most hours this returns 0 rows -- no LLM cost)
    |
    v
For each triggered client:
    |
    +-> Queue Client Worker invocation
    |     Full context: compact summary, recent messages, preferences
    |
    v
Client Worker drafts contextual follow-up
    |
    v
ProposedAction created (tier: review)
    |
    v
Staff sees follow-up card in Today's View
    +-> Approve -> send, increment attempt_count
    +-> Edit + send -> send modified, increment attempt_count
    +-> Dismiss -> clear timer
    +-> Snooze 48h -> follow_up_trigger_at = NOW() + 48h
    +-> Mark inactive -> clear timer, lifecycle -> inactive
```

### 5.5 Escalation ladder

| Attempt | Trigger delay | What happens if no response |
|---|---|---|
| 1st | 72 hours after last client message | Staff sees follow-up card |
| 2nd | `follow_up_cooldown_hours` (default 7 days) after 1st sent | Staff sees 2nd follow-up card |
| 3rd | Same cooldown after 2nd sent | Staff sees final follow-up card |
| After max | -- | Timer cleared. Lifecycle -> `inactive`. |

---

## 6. Job 4: Memory compaction

### 6.1 Specification

| Property | Value |
|---|---|
| Schedule | Daily at 3 AM workspace timezone |
| LLM | Yes -- summarization call per active client |
| Edge Function | `cron-memory-compaction` |
| Duration target | Variable (depends on active client count) |

### 6.2 Flow

```
pg_cron fires at 3 AM workspace TZ
    |
    v
Query: clients with activity since last compaction
    |
    v
For each client with new activity:
    +-> Flush-before-compact check (pending extractions?)
    +-> Load existing compact summary + new messages
    +-> LLM call: generate updated summary (FLASH_MODEL)
    +-> Write new Memory record (type: compact_summary, version: N+1)
    +-> Update client.summary
    |
    v
Write cron_run_log entry
```

---

## 7. Codebase structure

### 7.1 New Edge Functions

```
supabase/functions/
  cron-heartbeat/index.ts
  cron-appointment-reminder/index.ts
  cron-followup-trigger/index.ts
  cron-memory-compaction/index.ts
```

### 7.2 New migrations

```
supabase/migrations/
  20260319_proactive_operations.sql   # All schema changes + pg_cron schedules
```

---

## 8. pg_cron schedule definitions

```sql
-- Job 1: System heartbeat -- every 2 hours
SELECT cron.schedule('system-heartbeat', '0 */2 * * *', ...);

-- Job 2: Appointment reminder -- daily at 9 AM UTC
SELECT cron.schedule('appointment-reminder', '0 9 * * *', ...);

-- Job 3: Follow-up scanner -- every hour
SELECT cron.schedule('followup-trigger', '0 * * * *', ...);

-- Job 4: Memory compaction -- daily at 3 AM UTC
SELECT cron.schedule('memory-compaction', '0 3 * * *', ...);
```

Note: pg_cron runs in UTC. Edge Functions handle per-workspace timezone conversion.

---

## 9. Error handling

| Failure | Behaviour |
|---|---|
| Edge Function timeout | pg_net logs failure. Next cron tick retries. |
| Google Calendar API failure | Reminder skipped for that booking. Discrepancy flagged. |
| LLM unavailable (follow-up) | Timer stays set. Next hourly scan retries. |
| LLM unavailable (compaction) | Client skipped. Raw messages preserved. Next nightly run retries. |
| WhatsApp send failure | ProposedAction stays approved. Standard retry with backoff. |

---

## 10. Observability

### 10.1 cron_run_log queries

```sql
-- Last 24h run history
SELECT job_type, status, items_found, items_actioned, completed_at
FROM cron_run_log
WHERE workspace_id = $1
  AND started_at > NOW() - INTERVAL '24 hours'
ORDER BY started_at DESC;
```

### 10.2 Staff app indicators

| Indicator | Location | Source |
|---|---|---|
| WhatsApp connection status | Settings / status bar | `workspace.whatsapp_connection_status` |
| Pending reminders count | Today's View badge | ProposedAction count |
| Pending follow-ups count | Today's View badge | ProposedAction count |

---

## 11. Testing strategy

| Test | Type | What it verifies |
|---|---|---|
| Follow-up timer starts after staff sends | Unit | Timer set correctly |
| Timer resets on client message | Unit | Reset to NOW() + 72h |
| Timer clears on booking | Unit | Nullified |
| Scanner finds expired timers | Integration | SQL query correct |
| Scanner ignores max-attempt clients | Integration | Excluded |
| Reminder template fills correctly | Unit | All variables substituted |
| Reminder skips already-sent bookings | Integration | Excluded |
| ProposedAction created correctly | Integration | Correct type, tier, payload |
| Heartbeat writes status | Integration | Fields updated |
