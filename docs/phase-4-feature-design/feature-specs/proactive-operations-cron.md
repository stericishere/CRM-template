# Architecture: Time-Sensitive Operations — Morning Scan + Event-Driven Timers

**Supersedes:** Proactive Operations Architecture v1 (cron-based per-job design)
**Status:** Architecture decision — eng-reviewed 2026-03-19
**Depends on:** Core messaging (Sprint 1), AI drafting + booking (Sprint 2)
**Ships in:** Sprint 3 (Pattern A morning scan + Pattern B timers) and Sprint 4 (journal, compaction)
**References:** PRD v2.1 SS9.6, SS9.7, SS13.5; Architecture v1.0 SS5, SS6; OpenClaw Cron/Heartbeat Research
**Timezone:** Hardcoded UTC+8 (Hong Kong). Multi-timezone support deferred.

**Core insight:** Separate day-scale operations (morning scan against live data) from minute-scale operations (event-driven timers with cancellation). Never poll for what you can compute at event time.

---

## 1. The two timing patterns

Every time-sensitive operation in the system falls into one of two categories:

### Pattern A: Morning scan against live data

**When to use:** The deadline is implicit in existing data (booking times, last interaction dates). The correct action depends on the current state of the data at check time. Scheduling a future action when the event happens would create stale entries that need cleanup when the underlying data changes.

**How it works:** A single daily cron at 9 AM HK fires a coordinator Edge Function. The coordinator queries active workspaces and fans out per-workspace Edge Function calls. Each per-workspace function queries live tables for everything that needs attention *today*. If a booking was rescheduled, the query simply won't find it. If a client was marked inactive, they won't match. No stale scheduled actions. No cleanup.

**Operations in this pattern:**

| Operation | Query logic | Action |
|---|---|---|
| Day-init: stale conversation sweep | Conversations where state = `awaiting_client_reply` AND last outbound message > 24h ago | Transition → `follow_up_pending`, cancel pending `stale_conversation` timer |
| Appointment reminder | Bookings where `start_time` is tomorrow AND `reminder_sent_at IS NULL` AND `status = 'confirmed'` | Verify against Google Calendar → fill template → ProposedAction |
| Follow-up (3-day no-reply) | Conversations where `last_client_message_at <= NOW() - follow_up_check_days` AND `state IN ('awaiting_client_reply', 'follow_up_pending')` AND `follow_up_attempt_count < max` AND no outbound message in last `follow_up_check_days` | `scanAndPropose()` → Client Worker → contextual follow-up draft → ProposedAction |
| Booking confirmation check | Bookings where `start_time` within `confirmation_check_days` AND `confirmation_status = 'pending'` | `scanAndPropose()` → Client Worker → confirmation request → ProposedAction |
| Inactivity detection | Clients where `last_interaction_at <= NOW() - inactivity_days` AND `lifecycle_status NOT IN ('inactive', 'review_complete')` | ProposedAction (tier: auto, type: `lifecycle_transition`) → execute immediately, audit logged |
| Daily journal | Aggregate today's stats + LLM narrative | Write `daily_journal` record |

### Pattern B: Event-driven timers with cancellation

**When to use:** The deadline is short (minutes to hours, not days), the trigger is a specific event, and the system needs to act *when time expires* rather than at the next daily scan.

**How it works:** When the triggering event occurs, call the `create_or_reset_timer` RPC function to write a row to `pending_timer` with `trigger_at = NOW() + duration`. A scanner (every 3 minutes) finds expired timers and executes their actions in batches of 10. When a cancellation event occurs, call `cancel_timer` RPC.

**Operations in this pattern:**

| Operation | Trigger event | Duration | Cancel when | Action on expiry |
|---|---|---|---|---|
| Stale conversation timeout | Staff sends reply, conversation enters `awaiting_client_reply` | 24 hours | Client messages back, booking confirmed, staff resolves, morning scan handles | Transition state → `follow_up_pending` |
| Draft review re-notification | AI draft ready, conversation enters `awaiting_staff_review` | 1 hour | Staff acts on draft (approve, edit, reject, regenerate) | INSERT to `staff_notifications` → Realtime broadcast |

---

## 2. Pattern A: Morning scan specification

### 2.1 Fan-out coordinator

```
pg_cron fires at 1:00 UTC (9 AM HK)
    │
    v
Edge Function: cron-morning-coordinator (<5s, lightweight)
    │
    ├─ Query: SELECT workspace_id FROM workspaces
    │         WHERE onboarding_status = 'complete'
    │
    ├─ For each workspace, fire-and-forget:
    │   fetch('/functions/v1/cron-morning-scan', {
    │     body: { workspace_id },
    │     headers: { Authorization: service_role }
    │   })
    │
    v
Each workspace gets its own Edge Function invocation
    ├─ Own execution time budget
    ├─ Own LLM calls
    └─ Independent failure (workspace A failing doesn't block B)
```

**Why fan-out:** A single Edge Function processing all workspaces sequentially would timeout on LLM calls (follow-up drafts, journal narrative). The coordinator is cheap — one query + N fetch calls. Each per-workspace function has the full execution time limit.

### 2.2 Per-workspace scan structure

```
cron-morning-scan (per workspace)
    │
    ├─→ Step 0: Day-init — stale conversation sweep
    ├─→ Scan 1: Appointment reminders
    ├─→ Scan 2: Follow-up candidates        ─┐
    ├─→ Scan 3: Booking confirmation checks  ─┤ via shared scanAndPropose()
    ├─→ Scan 4: Inactivity detection
    └─→ Scan 5: Daily journal
    │
    v
Write cron_run_log entry (status: success | partial_failure | failed)
```

Each scan runs in its own try-catch. If Scan 2 fails, Scans 1, 3, 4, 5 still complete.

### 2.3 Step 0: Day-init — stale conversation sweep

No LLM. State transition + timer cleanup.

This catches any conversations that the event-driven 24h timer missed (timer failure, race conditions) and also serves as a safety net.

```sql
-- Find conversations stale > 24h that the timer should have caught
SELECT conv.conversation_id
FROM conversations conv
JOIN messages m ON m.conversation_id = conv.conversation_id
WHERE conv.workspace_id = $1
  AND conv.state = 'awaiting_client_reply'
  AND m.direction = 'outbound'
  AND m.timestamp = (
    SELECT MAX(m2.timestamp) FROM messages m2
    WHERE m2.conversation_id = conv.conversation_id
      AND m2.direction = 'outbound'
  )
  AND m.timestamp <= NOW() - INTERVAL '24 hours';
```

For each result:
1. Call `transitionConversation(convId, 'timeout_24h')` → state becomes `follow_up_pending`.
2. Cancel any pending `stale_conversation` timer via `cancel_timer` RPC (reason: `morning_scan_handled`).
3. Write audit event with trigger source `morning_scan`.

Per-conversation error isolation: each conversation is processed in its own try-catch. One conversation failing doesn't block the sweep for others.

### 2.4 Scan 1: Appointment reminders

No LLM (unless `reminder_mode = 'ai_draft'`). Template fill.

```sql
SELECT b.booking_id, b.appointment_type, b.start_time,
       c.full_name, c.phone_number, c.preferences,
       w.business_name, w.vertical_config
FROM bookings b
JOIN clients c ON b.client_id = c.client_id
JOIN workspaces w ON b.workspace_id = w.workspace_id
WHERE b.workspace_id = $1
  AND b.start_time >= (CURRENT_DATE + INTERVAL '1 day')::timestamp
  AND b.start_time <  (CURRENT_DATE + INTERVAL '2 days')::timestamp
  AND b.status = 'confirmed'
  AND b.reminder_sent_at IS NULL;
```

For each result:
1. If Google Calendar connected: verify event exists and time unchanged. Skip + flag discrepancy if not.
2. Fill template with variables (`{client_name}`, `{appointment_type}`, `{time}`).
3. If `workspace.reminder_mode = 'ai_draft'`: queue Client Worker instead of template fill.
4. Create ProposedAction (tier: review).

### 2.5 Scan 2: Follow-up candidates (3-day no-reply)

LLM: Yes — Client Worker drafts contextual follow-up via `scanAndPropose()`.

```sql
SELECT c.client_id, c.full_name, c.phone_number,
       conv.conversation_id, conv.last_client_message_at,
       conv.follow_up_attempt_count, conv.state
FROM conversations conv
JOIN clients c ON conv.client_id = c.client_id
WHERE conv.workspace_id = $1
  AND conv.state IN ('awaiting_client_reply', 'follow_up_pending')
  AND conv.last_client_message_at <= NOW() - (
    SELECT follow_up_check_days FROM workspaces WHERE workspace_id = $1
  ) * INTERVAL '1 day'
  AND conv.follow_up_attempt_count < (
    SELECT follow_up_max_attempts FROM workspaces WHERE workspace_id = $1
  )
  -- No outbound message in the check window either
  AND NOT EXISTS (
    SELECT 1 FROM messages m
    WHERE m.conversation_id = conv.conversation_id
      AND m.direction = 'outbound'
      AND m.timestamp > NOW() - (
        SELECT follow_up_check_days FROM workspaces WHERE workspace_id = $1
      ) * INTERVAL '1 day'
  )
ORDER BY conv.last_client_message_at ASC;
```

No LIMIT — all qualifying conversations are processed.

For each result: `scanAndPropose()` handles the Client Worker invocation → ProposedAction creation pipeline.

Staff actions on the ProposedAction: Approve → send + increment `follow_up_attempt_count` | Edit + send | Dismiss | Mark inactive.

**Escalation ladder:** Each morning scan picks up clients again if they still qualify. After attempt 1 is sent, the client won't match again for another `follow_up_check_days` (because the outbound message resets the "no outbound in last N days" check). After max attempts, the inactivity scan catches them.

### 2.6 Scan 3: Booking confirmation check

LLM: Yes — Client Worker via `scanAndPropose()`.

```sql
SELECT b.booking_id, b.appointment_type, b.start_time,
       c.client_id, c.full_name, c.phone_number,
       conv.conversation_id
FROM bookings b
JOIN clients c ON b.client_id = c.client_id
LEFT JOIN conversations conv ON conv.client_id = c.client_id
  AND conv.workspace_id = b.workspace_id
WHERE b.workspace_id = $1
  AND b.start_time >= (CURRENT_DATE + INTERVAL '1 day')::timestamp
  AND b.start_time <  (CURRENT_DATE + (
    SELECT confirmation_check_days FROM workspaces WHERE workspace_id = $1
  ) * INTERVAL '1 day')::timestamp
  AND b.status = 'confirmed'
  AND b.confirmation_status = 'pending';
```

For each result: `scanAndPropose()` → Client Worker drafts confirmation request → ProposedAction (tier: review).

### 2.7 Scan 4: Inactivity detection

No LLM. Atomic CTE for state transition.

```sql
WITH newly_inactive AS (
  UPDATE clients
  SET lifecycle_status = 'inactive',
      updated_at = NOW()
  WHERE workspace_id = $1
    AND lifecycle_status NOT IN ('inactive', 'review_complete')
    AND last_interaction_at <= NOW() - (
      SELECT inactivity_days FROM workspaces WHERE workspace_id = $1
    ) * INTERVAL '1 day'
  RETURNING client_id
)
UPDATE conversations
SET state = 'idle',
    follow_up_attempt_count = 0
WHERE client_id IN (SELECT client_id FROM newly_inactive)
  AND state != 'idle';
```

For each transitioned client: create ProposedAction (tier: auto, type: `lifecycle_transition`). Auto tier executes immediately but is visible, auditable, and reversible through the same approval pipeline.

Write audit event via `transitionConversation()` for each conversation state change.

### 2.8 Scan 5: Daily journal

LLM: Yes — one cheap summarization call per workspace.

#### 2.8.1 Stats aggregation (pure SQL, no LLM)

```typescript
type DailyJournal = {
  journal_id: string;
  workspace_id: string;
  date: Date;
  stats: {
    clients_interacted: number;
    new_clients: number;
    messages_inbound: number;
    messages_outbound: number;
    drafts_generated: number;
    drafts_sent_as_is: number;
    drafts_edited: number;
    drafts_discarded: number;
    bookings_created: number;
    bookings_cancelled: number;
    bookings_completed: number;
    follow_ups_sent: number;
    follow_ups_dismissed: number;
    clients_marked_inactive: number;
  };
  narrative: string;           // LLM-generated summary
  learning_snapshot: {
    acceptance_rate_today: number;
    common_edit_categories: string[];
    new_patterns_detected: string[];
    rules_promoted_today: string[];
  };
  alerts: string[];            // System alerts from the day
  created_at: Timestamp;
};
```

#### 2.8.2 Journal generation flow

```
Aggregate stats from today's records (pure SQL, no LLM)
    │
    v
Compile learning loop snapshot (SQL aggregation on draft_edit_signals)
    │
    v
Collect any system alerts from today (from heartbeat checks)
    │
    v
One LLM call: generate narrative summary from stats + snapshot (cheap model)
    │
    v
Write DailyJournal record (unique constraint on workspace_id + date)
```

**What the journal enables:**
- Staff opens the app tomorrow → sees "Yesterday's summary" card with the narrative.
- COS can reference the journal when prioritizing today's work.
- Over weeks, journals show trends: acceptance rate improving, common edit patterns shifting, client volume growing.

### 2.9 Shared `scanAndPropose()` helper

Scans 2 and 3 share the same pipeline: query candidates → Client Worker invocation → ProposedAction creation. Extracted to avoid DRY violation.

```typescript
type ScanConfig = {
  candidates: Array<{ clientId: string; conversationId: string; [key: string]: unknown }>;
  proposalType: string;       // 'follow_up' | 'booking_confirmation'
  reason: string;             // '3day_no_response' | 'confirmation_check'
  tier: 'auto' | 'review' | 'human_only';
  metadata?: Record<string, unknown>;
};

async function scanAndPropose(
  workspaceId: string,
  config: ScanConfig
): Promise<{ found: number; actioned: number }> {
  // For each candidate:
  //   1. Queue Client Worker invocation (full client context)
  //   2. Client Worker drafts message
  //   3. Create ProposedAction with config.tier, config.reason
  // Returns counts for cron_run_log
}
```

Each scan owns its query and metadata. The helper owns the pipeline.

---

## 3. Pattern B: Event-driven timer specification

### 3.1 The `pending_timer` table

```sql
CREATE TABLE pending_timer (
  timer_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(workspace_id),
  timer_type    TEXT NOT NULL,          -- 'stale_conversation' | 'draft_review_nudge'
  trigger_at    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'fired', 'cancelled', 'error')),

  -- Context for the handler
  target_entity TEXT NOT NULL,          -- 'conversation' | 'draft'
  target_id     UUID NOT NULL,
  payload       JSONB,                  -- Handler-specific data

  -- Lifecycle
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fired_at      TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT,                   -- 'client_messaged' | 'staff_acted' | 'booking_confirmed' | 'morning_scan_handled'
  error_details JSONB,                  -- Populated when status = 'error'

  -- Deduplication: one active timer per target per type
  UNIQUE (target_id, timer_type) WHERE status = 'pending'
);

-- RLS: service-write, workspace-read
ALTER TABLE pending_timer ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can manage timers"
  ON pending_timer FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Workspace members can read own timers"
  ON pending_timer FOR SELECT
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

CREATE INDEX idx_pending_timer_scan
  ON pending_timer (trigger_at)
  WHERE status = 'pending';
```

### 3.2 Timer lifecycle via RPC functions

The Supabase JS client's `.upsert()` does not support partial unique indexes (cannot pass `WHERE status = 'pending'` in `onConflict`). Timer operations use RPC functions with raw SQL.

```sql
-- Create or reset a timer. Uses ON CONFLICT with partial index.
CREATE OR REPLACE FUNCTION create_or_reset_timer(
  p_workspace_id UUID,
  p_timer_type TEXT,
  p_target_entity TEXT,
  p_target_id UUID,
  p_trigger_at TIMESTAMPTZ,
  p_payload JSONB DEFAULT NULL
) RETURNS void AS $$
BEGIN
  INSERT INTO pending_timer (workspace_id, timer_type, target_entity, target_id, trigger_at, payload)
  VALUES (p_workspace_id, p_timer_type, p_target_entity, p_target_id, p_trigger_at, p_payload)
  ON CONFLICT (target_id, timer_type) WHERE status = 'pending'
  DO UPDATE SET trigger_at = EXCLUDED.trigger_at,
               payload = EXCLUDED.payload;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cancel a pending timer.
CREATE OR REPLACE FUNCTION cancel_timer(
  p_target_id UUID,
  p_timer_type TEXT,
  p_reason TEXT
) RETURNS void AS $$
BEGIN
  UPDATE pending_timer
  SET status = 'cancelled',
      cancelled_at = NOW(),
      cancel_reason = p_reason
  WHERE target_id = p_target_id
    AND timer_type = p_timer_type
    AND status = 'pending';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 3.3 Best-effort timer helpers (TypeScript)

Timer operations in hot paths (process-message, send action) are fire-and-forget. Failures are logged, not thrown. The timer handler's re-check guard is the safety net.

```typescript
async function bestEffortStartTimer(
  workspaceId: string,
  timerType: 'stale_conversation' | 'draft_review_nudge',
  targetEntity: string,
  targetId: string,
  durationMs: number,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    await supabase.rpc('create_or_reset_timer', {
      p_workspace_id: workspaceId,
      p_timer_type: timerType,
      p_target_entity: targetEntity,
      p_target_id: targetId,
      p_trigger_at: new Date(Date.now() + durationMs).toISOString(),
      p_payload: payload ?? null,
    });
  } catch (err) {
    console.error(`[timer] Failed to start ${timerType} for ${targetId}:`, err);
    // Non-fatal — morning scan day-init catches missed timers
  }
}

async function bestEffortCancelTimer(
  targetId: string,
  timerType: string,
  reason: string
): Promise<void> {
  try {
    await supabase.rpc('cancel_timer', {
      p_target_id: targetId,
      p_timer_type: timerType,
      p_reason: reason,
    });
  } catch (err) {
    console.error(`[timer] Failed to cancel ${timerType} for ${targetId}:`, err);
    // Non-fatal — handler re-checks state before acting
  }
}
```

### 3.4 Timer scanner

pg_cron every 3 minutes. Processes expired timers in batches of 10 via `Promise.allSettled()`.

```typescript
// Edge Function: cron-timer-scanner

const { data: expired } = await supabase
  .from('pending_timer')
  .select('*')
  .eq('status', 'pending')
  .lte('trigger_at', new Date().toISOString())
  .order('trigger_at', { ascending: true })
  .limit(50);

// Process in batches of 10 to cap concurrent DB connections
const BATCH_SIZE = 10;
for (let i = 0; i < (expired?.length ?? 0); i += BATCH_SIZE) {
  const batch = expired!.slice(i, i + BATCH_SIZE);
  await Promise.allSettled(batch.map(timer => processTimer(timer)));
}

async function processTimer(timer: PendingTimer): Promise<void> {
  // Optimistic lock — mark as fired before dispatch
  const { error } = await supabase
    .from('pending_timer')
    .update({ status: 'fired', fired_at: new Date().toISOString() })
    .eq('timer_id', timer.timer_id)
    .eq('status', 'pending');

  if (error) return; // Another scanner instance got it

  try {
    switch (timer.timer_type) {
      case 'stale_conversation':
        await handleStaleConversation(timer);
        break;
      case 'draft_review_nudge':
        await handleDraftReviewNudge(timer);
        break;
    }
  } catch (err) {
    // Mark as error — visible in heartbeat alerts
    await supabase
      .from('pending_timer')
      .update({
        status: 'error',
        error_details: { message: err.message, stack: err.stack },
      })
      .eq('timer_id', timer.timer_id);

    // Log to cron_run_log for observability
    console.error(`[timer] Handler failed for ${timer.timer_type}:`, err);
  }
}
```

### 3.5 Timer type: Stale conversation (24h timeout)

**Trigger:** Staff sends reply → conversation enters `awaiting_client_reply`.

```typescript
// In the message send flow (actions.ts)
async function afterStaffSends(conv: Conversation): Promise<void> {
  if (conv.state === 'awaiting_client_reply') {
    await bestEffortStartTimer(
      conv.workspaceId,
      'stale_conversation',
      'conversation',
      conv.conversationId,
      24 * 60 * 60 * 1000  // 24 hours
    );
  }
}
```

**Cancel events:**
- Client messages back → `bestEffortCancelTimer(convId, 'stale_conversation', 'client_messaged')`
- Booking confirmed → `bestEffortCancelTimer(convId, 'stale_conversation', 'booking_confirmed')`
- Staff resolves conversation → `bestEffortCancelTimer(convId, 'stale_conversation', 'staff_resolved')`
- Morning scan day-init handles it → `cancel_timer(convId, 'stale_conversation', 'morning_scan_handled')`

**On expiry:**

```typescript
async function handleStaleConversation(timer: PendingTimer): Promise<void> {
  // Re-check: is the conversation still in awaiting_client_reply?
  const conv = await repo.getConversation(timer.target_id);
  if (conv.state !== 'awaiting_client_reply') return;

  // Transition state via utility (enforces valid transitions, writes audit event)
  await transitionConversation(timer.target_id, 'timeout_24h', 'timer');
}
```

Note: this doesn't draft a follow-up. It just transitions state. The morning scan picks up `follow_up_pending` conversations and decides whether to draft a follow-up.

### 3.6 Timer type: Draft review re-notification (1h)

**Trigger:** AI draft ready → conversation enters `awaiting_staff_review`.

```typescript
async function afterDraftCreated(conv: Conversation, draftId: string): Promise<void> {
  await bestEffortStartTimer(
    conv.workspaceId,
    'draft_review_nudge',
    'draft',
    draftId,
    60 * 60 * 1000  // 1 hour
  );
}
```

**Cancel events:**
- Staff approves, edits, rejects, or regenerates → `bestEffortCancelTimer(draftId, 'draft_review_nudge', 'staff_acted')`

**On expiry:**

```typescript
async function handleDraftReviewNudge(timer: PendingTimer): Promise<void> {
  const draft = await repo.getDraft(timer.target_id);
  if (draft.status !== 'pending') return;

  // Insert notification record → Supabase Realtime broadcasts to staff app
  await supabase.from('staff_notifications').insert({
    workspace_id: timer.workspace_id,
    type: 'draft_review_reminder',
    title: 'Draft waiting for review',
    body: `Reply to ${draft.clientName} is ready — tap to review`,
    metadata: { draftId: draft.draftId },
  });
}
```

### 3.7 Timer creation hooks

Timers are created/cancelled as side effects of existing operations via best-effort helpers:

| Existing operation | Timer action |
|---|---|
| Staff approves and sends a message | `bestEffortStartTimer('stale_conversation', 24h)` if conversation enters `awaiting_client_reply` |
| AI draft generated and saved | `bestEffortStartTimer('draft_review_nudge', 1h)` |
| Client sends inbound message | `bestEffortCancelTimer(convId, 'stale_conversation', 'client_messaged')` |
| Staff acts on draft (approve/edit/reject) | `bestEffortCancelTimer(draftId, 'draft_review_nudge', 'staff_acted')` |
| Booking confirmed | `bestEffortCancelTimer(convId, 'stale_conversation', 'booking_confirmed')` |
| Morning scan day-init transitions conversation | `cancel_timer(convId, 'stale_conversation', 'morning_scan_handled')` |

---

## 4. Conversation state machine

### 4.1 Valid states

```sql
ALTER TABLE conversations
ADD CONSTRAINT chk_conversation_state
CHECK (state IN ('idle', 'awaiting_staff_review', 'awaiting_client_reply', 'follow_up_pending'));
```

### 4.2 Transition map

```
                 ┌──────────────────────────────────────────┐
                 │                                          │
                 v                                          │
    ┌────────────────────┐                                  │
    │       idle         │                                  │
    └────────┬───────────┘                                  │
             │ inbound_message                              │
             v                                              │
    ┌────────────────────┐                                  │
    │ awaiting_staff_    │──── staff_resolves ───────────────┘
    │ review             │
    └────────┬───────────┘
             │ staff_sends
             v
    ┌────────────────────┐
    │ awaiting_client_   │──── client_messages ──→ idle
    │ reply              │──── staff_resolves ───→ idle
    └────────┬───────────┘
             │ timeout_24h (timer or morning scan)
             v
    ┌────────────────────┐
    │ follow_up_pending  │──── client_messages ──→ idle
    │                    │──── staff_resolves ───→ idle
    │                    │──── follow_up_sent ──→ awaiting_client_reply
    └────────────────────┘
```

### 4.3 `transitionConversation()` utility

```typescript
const TRANSITION_MAP: Record<string, Record<string, string>> = {
  'idle':                    { 'inbound_message': 'awaiting_staff_review' },
  'awaiting_staff_review':   { 'staff_sends': 'awaiting_client_reply', 'staff_resolves': 'idle' },
  'awaiting_client_reply':   { 'client_messages': 'idle', 'timeout_24h': 'follow_up_pending', 'staff_resolves': 'idle' },
  'follow_up_pending':       { 'client_messages': 'idle', 'follow_up_sent': 'awaiting_client_reply', 'staff_resolves': 'idle' },
};

async function transitionConversation(
  conversationId: string,
  event: string,
  triggerSource: 'timer' | 'morning_scan' | 'staff_action' | 'inbound_message'
): Promise<void> {
  const conv = await repo.getConversation(conversationId);
  const nextState = TRANSITION_MAP[conv.state]?.[event];

  if (!nextState) {
    throw new Error(`Invalid transition: ${conv.state} + ${event}`);
  }

  await supabase
    .from('conversations')
    .update({ state: nextState })
    .eq('conversation_id', conversationId);

  // Always write audit event
  await supabase.from('audit_events').insert({
    workspace_id: conv.workspaceId,
    actor_type: 'system',
    action_type: 'conversation_state_transition',
    target_type: 'conversation',
    target_id: conversationId,
    metadata: {
      from_state: conv.state,
      to_state: nextState,
      event,
      trigger_source: triggerSource,
    },
  });
}
```

---

## 5. Memory compaction (3 AM separate cron)

Separate from the morning scan. Runs at 3 AM HK (19:00 UTC) to compact the previous day's activity.

### 5.1 Fan-out coordinator

Same pattern as morning scan — coordinator queries active workspaces, fans out per-workspace calls.

```
pg_cron fires at 19:00 UTC (3 AM HK)
    │
    v
Edge Function: cron-compaction-coordinator
    │
    v
Fan out per-workspace: cron-compaction (per workspace)
    │
    ├─ Query: clients with message activity yesterday (CURRENT_DATE - 1)
    │
    ├─ For each client with activity:
    │   ├─ Flush-before-compact: are all async note extractions complete?
    │   │   If not → skip, retry tomorrow
    │   ├─ Load existing compact_summary + yesterday's messages
    │   ├─ LLM call: generate updated compact summary (cheap model)
    │   └─ Write new Memory record (type: 'compact_summary', version N+1)
    │
    v
Write cron_run_log entry
```

### 5.2 Key details

- **Previous day only:** Query uses `m.timestamp::date = CURRENT_DATE - 1`. At 3 AM, yesterday's activity is fully settled.
- **Flush-before-compact:** If `notes.extraction_status = 'pending'` for any note from yesterday → skip that client. Retry tomorrow when extraction is complete.
- **LLM failure:** Skip client, log to cron_run_log. Client retried next night. Raw messages are preserved regardless.

---

## 6. System heartbeat

Separate from morning scan and timer scanner. Infrastructure monitoring.

**Schedule:** Every 2 hours via pg_cron (`0 */2 * * *`).

**Checks:**
1. WhatsApp connection (last webhook age)
2. pgmq queue depth + DLQ count
3. LLM provider availability (OpenRouter HEAD request)
4. Google Calendar auth status

**Output:** Updates `workspace.last_heartbeat_at` and `workspace.whatsapp_connection_status`. Creates `staff_notifications` INSERT if any check fails. Writes `cron_run_log` entry.

---

## 7. Complete cron schedule

All times in UTC, hardcoded for HK (UTC+8).

| pg_cron job | Schedule (UTC) | Local time (HK) | Edge Function | Purpose |
|---|---|---|---|---|
| `morning-scan` | `0 1 * * *` | 9:00 AM | `cron-morning-coordinator` | All day-scale operations |
| `morning-scan-retry` | `30 1 * * *` | 9:30 AM | (inline SQL check) | Re-trigger morning scan if journal missing |
| `compaction` | `0 19 * * *` | 3:00 AM (+1 day) | `cron-compaction-coordinator` | Per-client memory compaction (previous day) |
| `timer-scanner` | `*/3 * * * *` | Every 3 min | `cron-timer-scanner` | Expired event-driven timers |
| `system-heartbeat` | `0 */2 * * *` | Every 2 hours | `cron-heartbeat` | Infrastructure health |

Five crons (four primary + one retry safety net). The retry job does nothing if the morning scan succeeded.

### 7.1 Retry job

```sql
SELECT cron.schedule(
  'morning-scan-retry',
  '30 1 * * *',
  $$ DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM daily_journal
      WHERE date = CURRENT_DATE
      AND workspace_id IN (
        SELECT workspace_id FROM workspaces WHERE onboarding_status = 'complete'
      )
    ) THEN
      PERFORM net.http_post(
        url := current_setting('app.supabase_url') || '/functions/v1/cron-morning-coordinator',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || current_setting('app.service_role_key')
        ),
        body := '{"retry": true}'::jsonb
      );
    END IF;
  END $$;
  $$
);
```

---

## 8. Data model changes

### 8.1 New table: `pending_timer`

See §3.1 for full schema including RLS policies.

### 8.2 New table: `daily_journal`

```sql
CREATE TABLE daily_journal (
  journal_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(workspace_id),
  date          DATE NOT NULL,
  stats         JSONB NOT NULL,          -- Activity counts
  narrative     TEXT,                    -- LLM-generated summary
  learning_snapshot JSONB,               -- Acceptance rate, edit patterns, promotions
  alerts        JSONB,                   -- System alerts from the day
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, date)
);

-- RLS: service-write, workspace-read
ALTER TABLE daily_journal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can manage journals"
  ON daily_journal FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Workspace members can read own journals"
  ON daily_journal FOR SELECT
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
```

### 8.3 New table: `staff_notifications`

```sql
CREATE TABLE staff_notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(workspace_id),
  type            TEXT NOT NULL,         -- 'draft_review_reminder' | 'heartbeat_alert' | ...
  title           TEXT NOT NULL,
  body            TEXT,
  metadata        JSONB,                 -- Type-specific data (draftId, etc.)
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: service-write, workspace-read
ALTER TABLE staff_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can manage notifications"
  ON staff_notifications FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Workspace members can read own notifications"
  ON staff_notifications FOR SELECT
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

-- Enable Supabase Realtime for push
ALTER PUBLICATION supabase_realtime ADD TABLE staff_notifications;
```

### 8.4 New table: `cron_run_log`

```sql
CREATE TABLE cron_run_log (
  run_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID REFERENCES workspaces(workspace_id),  -- NULL for coordinator-level logs
  job_type       TEXT NOT NULL,          -- 'morning_scan' | 'compaction' | 'timer_scanner' | 'heartbeat'
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'success', 'partial_failure', 'failed')),
  items_found    INTEGER DEFAULT 0,
  items_actioned INTEGER DEFAULT 0,
  error_details  JSONB,                  -- Per-scan failure details
  metadata       JSONB                   -- Job-specific data
);
```

### 8.5 Removed fields (vs. v1)

- ~~`conversation.follow_up_trigger_at`~~ — no longer needed. Morning scan queries live data.
- ~~`workspace.follow_up_delay_hours`~~ — replaced by `workspace.follow_up_check_days`.
- ~~`workspace.follow_up_cooldown_hours`~~ — the outbound message from the first follow-up naturally creates a gap before the client re-qualifies.

### 8.6 Retained fields

- `conversation.follow_up_attempt_count` — incremented when a follow-up is sent. Compared against `workspace.follow_up_max_attempts`.
- `booking.reminder_sent_at` — prevents sending duplicate reminders.
- `workspace.last_heartbeat_at` — heartbeat tracking.
- `workspace.whatsapp_connection_status` — heartbeat tracking.
- `workspace.reminder_mode` — template vs ai_draft.
- `workspace.follow_up_max_attempts` — default 3.

### 8.7 New workspace config fields

| Field | Type | Default | Description |
|---|---|---|---|
| `follow_up_check_days` | Integer | 3 | Days since last client message before follow-up eligible |
| `confirmation_check_days` | Integer | 2 | Days before appointment to check confirmation status |
| `inactivity_days` | Integer | 30 | Days without interaction before marking inactive |
| `journal_enabled` | Boolean | true | Generate daily journal entries |

### 8.8 New index

```sql
-- Supports morning scan Scan 2 NOT EXISTS subquery at scale
CREATE INDEX idx_messages_conv_direction_ts
  ON messages (conversation_id, direction, timestamp DESC);
```

---

## 9. Integration with existing architecture

### 9.1 Morning scan → Approval boundary

All morning scan outputs that involve client-facing messages go through the existing ProposedAction system:

```
Morning scan result
    │
    ├─→ Appointment reminder → ProposedAction (tier: review)
    ├─→ Follow-up draft → ProposedAction (tier: review)
    ├─→ Confirmation check → ProposedAction (tier: review)
    ├─→ Inactivity transition → ProposedAction (tier: auto) — executes immediately, audited
    └─→ Journal entry → auto (internal record, no approval needed)
```

### 9.2 Timer scanner → State machine

Timer expiry triggers state transitions through `transitionConversation()`:

```
Timer expires
    │
    ├─→ stale_conversation → transitionConversation(convId, 'timeout_24h', 'timer')
    │     State: awaiting_client_reply → follow_up_pending
    │     (Next morning scan may pick this up for follow-up)
    │
    └─→ draft_review_nudge → INSERT staff_notifications
          (No state change, just a Realtime push)
```

### 9.3 Morning scan → Daily journal → Staff app

```
Staff opens app
    │
    v
Today's View
    │
    ├─→ "Yesterday" card (from daily_journal)
    ├─→ Reminders to review (ProposedActions from Scan 1)
    ├─→ Follow-ups to review (ProposedActions from Scan 2)
    ├─→ Confirmations to review (ProposedActions from Scan 3)
    └─→ Alerts (from staff_notifications)
```

---

## 10. Codebase structure

### 10.1 New Edge Functions

```
supabase/functions/
  cron-morning-coordinator/index.ts    # Fans out per-workspace morning scans
  cron-morning-scan/index.ts           # Per-workspace: day-init + 5 scans
  cron-timer-scanner/index.ts          # Processes expired pending_timer rows
  cron-compaction-coordinator/index.ts # Fans out per-workspace compaction
  cron-compaction/index.ts             # Per-workspace: compact previous day
  cron-heartbeat/index.ts              # Infrastructure health checks
```

### 10.2 New shared modules

```
supabase/functions/_shared/
  timer-helpers.ts                     # bestEffortStartTimer, bestEffortCancelTimer
  conversation-state.ts                # transitionConversation, TRANSITION_MAP
  scan-and-propose.ts                  # scanAndPropose shared helper
```

### 10.3 New migration

```
supabase/migrations/
  20260320_proactive_operations.sql    # All schema + pg_cron + RPC functions + indexes
```

---

## 11. Error handling

| Failure | Behaviour |
|---|---|
| Morning coordinator DB error | cron_run_log entry. Retry job fires 30 min later. |
| Per-workspace scan partial failure | Unaffected scans complete. cron_run_log status = `partial_failure`. |
| Per-conversation error in day-init | Logged, skipped. Other conversations still processed. |
| Timer handler throws | Timer status → `error` with error_details. Visible in heartbeat alerts. |
| Timer RPC failure (fire-and-forget) | Logged, not thrown. Morning scan day-init catches missed timers. |
| LLM unavailable (follow-up draft) | Scan 2 fails for that workspace. Other scans complete. Retry next morning. |
| LLM unavailable (compaction) | Client skipped. Raw messages preserved. Retry next night. |
| LLM unavailable (journal narrative) | Journal written with stats but NULL narrative. Can be backfilled. |
| Google Calendar API failure | Reminder skipped for that booking. Discrepancy flagged in staff_notifications. |

---

## 12. Testing strategy

### 12.1 Test map (59 test cases)

**Morning scan coordinator (3 tests)**
- T1: Fan-out fires per-workspace calls
- T2: 0 workspaces → no-op
- T3: DB query fails → cron_run_log

**Day-init stale sweep (3 tests)**
- T4: Transitions `awaiting_client_reply` > 24h → `follow_up_pending`
- T5: Skips conversations < 24h
- T6: Idempotent — already `follow_up_pending` → skip

**Scan 1: Appointment reminders (5 tests)**
- T7: Reminder created for confirmed booking tomorrow
- T8: GCal mismatch → flagged
- T9: No GCal → template fill
- T10: `reminder_sent_at` NOT NULL → skip (idempotent)
- T11: `reminder_mode = 'ai_draft'` → Client Worker

**Scan 2: Follow-up candidates (4 tests)**
- T12: Follow-up queued for qualifying conversation
- T13: Staff messaged in window → skip
- T14: `attempt_count >= max` → skip
- T15: 0 candidates → no action

**Scan 3: Booking confirmation (2 tests)**
- T16: Confirmation queued for pending booking
- T17: Already confirmed → skip

**Scan 4: Inactivity (3 tests)**
- T18: Inactivity transition via ProposedAction (auto tier)
- T19: Cascade cleanup of open follow-up state
- T20: Already inactive → skip

**Scan 5: Journal (4 tests)**
- T21: Stats aggregation correct
- T22: Narrative generated
- T23: Learning snapshot populated
- T24: Duplicate journal → unique constraint (idempotent)

**Scan isolation (2 tests)**
- T25: Scan 2 fails, others succeed → `partial_failure`
- T26: All fail → cron_run_log `failed`

**Morning retry (2 tests)**
- T27: Journal missing → re-trigger
- T28: Journal exists → no-op

**Timer lifecycle RPC (6 tests)**
- T29: Create new timer
- T30: Reset existing pending timer
- T31: New timer after old fired/cancelled
- T32: Cancel pending timer
- T33: Cancel with no pending → no-op
- T34: Cancel already fired → no-op

**Timer hooks (5 tests)**
- T35: Staff sends → `stale_conversation` timer created
- T36: Draft created → `draft_review_nudge` timer created
- T37: Hook failure → logged, not thrown
- T38: Client messages → cancel `stale_conversation`
- T39: Staff acts on draft → cancel `draft_review_nudge`
- T40: Booking confirmed → cancel `stale_conversation`

**Timer scanner (9 tests)**
- T41: 0 expired → no-op
- T42: N expired → batched `Promise.allSettled()`
- T43: Optimistic lock lost → skip
- T44: `stale_conversation` → transition happens
- T45: State already changed → re-check skips
- T46: Handler throws → status = `error`
- T47: `draft_review_nudge` → re-notification sent
- T48: Draft already acted on → skip
- T49: Handler throws → status = `error`

**Compaction (5 tests)**
- T50: Fan-out per workspace
- T51: Client with activity → compact
- T52: No activity → skip
- T53: Flush-before-compact pending → defer
- T54: LLM failure → skip client, log

**State machine (3 tests)**
- T55: Valid transition succeeds + audit event written
- T56: Invalid transition throws
- T57: CHECK constraint blocks bad state via direct SQL

**Interaction tests (2 tests)**
- T58: Day-init cancels pending `stale_conversation` timers
- T59: Per-conversation error isolation in day-init sweep

### 12.2 LLM test strategy

- **Unit tests:** Mock LLM client with canned responses. Fast, deterministic, CI-safe.
- **Integration tests:** Hit real LLM via OpenRouter (cheap model). Marked as `@slow` in Vitest. Two key tests:
  1. One follow-up draft end-to-end
  2. One compaction end-to-end

---

## 13. Pros and cons

### Pros

**No stale state.** The morning scan queries live tables. If a booking was rescheduled, the scan won't find it. If a client messaged back, the follow-up query excludes them.

**Natural deduplication.** The morning scan runs once per day. It either finds a client in the follow-up query or it doesn't. No risk of duplicate follow-ups from multiple timer expirations.

**Configurable without migration.** Changing follow-up delay from 3 days to 5 days is one workspace config update. No need to recalculate `trigger_at` timestamps.

**Timer table is tiny and fast.** Only short-duration timers (hours). Most fire quickly or get cancelled. The scanner index is narrow: only `pending` status rows.

**Fan-out isolates failures.** One workspace's morning scan failing doesn't affect others. Each gets its own Edge Function invocation with its own execution budget.

### Cons and mitigations

**Morning scan is a batch, not real-time.** A client who qualifies for follow-up at noon won't get one until 9 AM the next day. For an appointment-based business with days-long sales cycles, this is fine.

**Single point of failure at 9 AM.** If the coordinator fails, all day-scale operations are missed. **Solution:** Retry job fires 30 min later. Each scan is idempotent. Manual re-trigger is safe any time.

**Timer scanner latency up to 3 minutes.** Acceptable for notification-type actions. Configurable via `TIMER_SCAN_INTERVAL_MINUTES`.

**Journal LLM call is daily cost.** One cheap call per active workspace per day. Skip workspaces with zero activity. Configurable via `workspace.journal_enabled`.

**Compaction at 3 AM means today's messages aren't in the compact summary yet.** The recent messages window (~10) covers intra-day context. Compact summary is for long-term memory across days.

---

## 14. TODO (deferred)

### Timer table cleanup (30-day retention)

**What:** `DELETE FROM pending_timer WHERE status != 'pending' AND created_at < NOW() - INTERVAL '30 days'`

**Why:** At ~18K rows/year/workspace, table grows indefinitely. Partial index means query perf is unaffected, but VACUUM and storage are impacted.

**When:** Add to morning scan as a lightweight cleanup step. Not blocking for initial implementation.

---

## 15. Engineering review decisions log

Decisions from eng review on 2026-03-19:

| # | Issue | Decision |
|---|---|---|
| 1 | Supabase upsert can't use partial unique index | RPC functions `create_or_reset_timer` and `cancel_timer` |
| 2 | No push notification service exists | `staff_notifications` table + Supabase Realtime broadcast |
| 3 | RLS not specified for new tables | Service-write, workspace-read (matches existing pattern) |
| 4 | No conversation state machine | CHECK constraint + `transitionConversation()` utility |
| 5 | Timer hooks couple into hot paths | Inline fire-and-forget via `bestEffort*` helpers |
| 6 | `cron_run_log` referenced but not in data model | Added to §8.4 |
| 7 | DRY violation in Scan 2 + Scan 3 pipeline | Shared `scanAndPropose()` helper |
| 8 | Timer handler error = silent failure | Try-catch per handler, `error` status + error_details |
| 9 | Inactivity detection bypasses approval | ProposedAction with auto tier (visible, auditable) |
| 10 | LLM test strategy | Mock for unit, real OpenRouter for `@slow` integration |
| 11 | Timer + morning scan race condition | Day-init cancels pending stale_conversation timers |
| 12 | Follow-up NOT EXISTS subquery at scale | Composite index `(conversation_id, direction, timestamp DESC)` |
| 13 | 50 timers firing in parallel | Batches of 10 via `Promise.allSettled()` |

Pre-review decisions:

| # | Decision |
|---|---|
| P1 | Compaction at 3 AM HK (separate cron, previous day only) |
| P2 | Hardcode HK timezone (UTC+8) |
| P3 | Fan-out coordinator pattern for morning scan |
| P4 | Remove LIMIT 20 on follow-up scan — process all qualifying conversations |
| P5 | CTE for atomic inactivity transition |
| P6 | Morning scan day-init step catches stale conversations (safety net for 24h timer) |
| P7 | Parallel timer processing (bounded to batches of 10) |
