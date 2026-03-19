# Feature Spec — F-11: Daily Memory Compaction

**Feature:** F-11 Daily Memory Compaction
**Phase:** 3 (Operational Memory & Follow-ups)
**Size:** L (5–8 days)
**PRD Functions:** CS-05, CS-06
**Architecture module:** `jobs/DailyCompactionJob`, `modules/conversation/CompactConversation`
**ADR dependencies:** ADR-3 (daily scheduled compaction, not reactive), ADR-2 (compaction reads/writes scoped to one client)
**User stories:** US-F11-01 through US-F11-06
**Depends on:** F-05 (conversations and messages must exist), F-13 (extraction_status checked by flush-before-compact)
**Required by:** F-12 (COS Operations relies on compact summaries for contextually rich follow-up drafts)

---

## 1. Component Breakdown

### 1.1 Edge Function — `supabase/functions/daily-cron/`

The `daily-cron` Edge Function is the single entry point for all daily scheduled work. F-11 adds the compaction phase to this function. The compaction phase runs **before** F-12's COS operations phase so that compact summaries are fresh when Client Workers generate follow-up drafts.

| File | Responsibility |
|------|----------------|
| `index.ts` | Edge Function entry point. Receives workspace_id from pg_cron invocation payload. Delegates to phase handlers in order: compaction first, then COS operations (F-12). |
| `compaction.ts` | Orchestrator. Identifies active clients, runs flush-before-compact check, dispatches per-client compaction, logs run summary. |
| `compactClient.ts` | Single-client compaction unit. Loads existing summary + new messages, calls LLM, writes versioned Memory record + updates client.summary in a transaction. |

### 1.2 Shared modules — `supabase/functions/_shared/`

| File | Responsibility |
|------|----------------|
| `compaction-prompt.ts` | Compaction system prompt template. Instructs the LLM to merge existing summary with new messages into a ~2,000-token third-person factual summary. Includes priority ordering rules (preferences > milestones > unresolved topics > style > history). |
| `llm-client.ts` | OpenRouter client using OpenAI-compatible SDK. Used by compaction with `FLASH_MODEL` env var. Logs usage to `llm_usage` table. |
| `types/memory.ts` | TypeScript types for the `memories` table rows and compaction inputs/outputs. |

### 1.3 Database additions

| Object | Type | Purpose |
|--------|------|---------|
| `memories` table | Existing (Architecture §9.1) | Stores versioned compact summaries |
| `clients.summary` column | Existing | Latest compact summary text for context assembly |
| `clients.last_compacted_at` column | **New** | Timestamp of last successful compaction for this client. Used for activity detection and idempotency. |
| `compaction_runs` table | **New** | Audit log of daily compaction job executions per workspace |
| pg_cron job `daily-compaction-{workspace_id}` | **New** | Per-workspace scheduled invocation at 03:00 local time |

---

## 2. Data Model

### 2.1 `memories` table (existing — Architecture §9.1)

```sql
-- Already defined in architecture-final.md. Reproduced for reference.
CREATE TABLE memories (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID          NOT NULL REFERENCES workspaces(id),
  client_id     UUID          NOT NULL REFERENCES clients(id),
  type          TEXT          NOT NULL,       -- 'compact_summary', 'daily_log'
  content       TEXT          NOT NULL,
  version       INTEGER       NOT NULL DEFAULT 1,
  period_date   DATE,                         -- date this memory covers (workspace TZ)
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_client_type ON memories(client_id, type, version DESC);
```

### 2.2 New column on `clients`

```sql
ALTER TABLE clients ADD COLUMN last_compacted_at TIMESTAMPTZ;

-- Index for activity detection query: find clients with messages since last compaction
CREATE INDEX idx_clients_last_compacted
  ON clients (workspace_id, last_compacted_at)
  WHERE deleted_at IS NULL;
```

### 2.3 `compaction_runs` table (new)

```sql
CREATE TABLE compaction_runs (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID          NOT NULL REFERENCES workspaces(id),
  run_date        DATE          NOT NULL,          -- local date in workspace TZ
  started_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  status          TEXT          NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed')),
  total_clients   INTEGER       NOT NULL DEFAULT 0,
  active_candidates INTEGER     NOT NULL DEFAULT 0,
  compacted       INTEGER       NOT NULL DEFAULT 0,
  deferred        INTEGER       NOT NULL DEFAULT 0,
  failed          INTEGER       NOT NULL DEFAULT 0,
  skipped_no_activity INTEGER   NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Idempotency: one compaction run per workspace per day
CREATE UNIQUE INDEX idx_compaction_runs_workspace_date
  ON compaction_runs (workspace_id, run_date);
```

### 2.4 Version monotonicity constraint

```sql
-- Ensure version numbers are unique per client per type
CREATE UNIQUE INDEX idx_memories_client_type_version
  ON memories (client_id, type, version);
```

---

## 3. pg_cron Scheduling per Workspace Timezone

### 3.1 Scheduling strategy

pg_cron runs on UTC. To schedule a job at 03:00 in each workspace's local timezone, the system uses a **dispatcher pattern**:

1. A single pg_cron job runs every hour at minute 0.
2. The dispatcher queries for workspaces whose local time is currently 03:00 (within the hour).
3. For each matching workspace, it invokes the `daily-cron` Edge Function via `pg_net`.

```sql
-- Master dispatcher: runs every hour, finds workspaces whose local 03:00 is now
SELECT cron.schedule(
  'daily-cron-dispatcher',
  '0 * * * *',    -- every hour at minute 0
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/daily-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('workspace_id', w.id, 'phase', 'compaction')
  )
  FROM workspaces w
  WHERE w.onboarding_status = 'complete'
    AND EXTRACT(HOUR FROM now() AT TIME ZONE w.timezone) = 3
    AND NOT EXISTS (
      SELECT 1 FROM compaction_runs cr
      WHERE cr.workspace_id = w.id
        AND cr.run_date = (now() AT TIME ZONE w.timezone)::date
    );
  $$
);
```

### 3.2 DST handling

The `AT TIME ZONE` conversion handles DST automatically. During a "spring forward" skip (02:00 jumps to 03:00), the hour 03 still exists and the job fires normally. During a "fall back" (03:00 occurs twice), the `NOT EXISTS` check on `compaction_runs` prevents a duplicate run.

### 3.3 Timezone change

When a workspace updates its timezone, no migration is needed. The next hourly dispatcher tick simply evaluates the new timezone value. The `NOT EXISTS` guard prevents double-firing on transition days.

---

## 4. LLM Call — Claude Haiku for Summarization

### 4.1 Model selection

| Parameter | Value |
|-----------|-------|
| Model | `claude-haiku-3-20240307` (or latest Haiku) |
| Max output tokens | 1,500 |
| Temperature | 0.2 (low creativity, high faithfulness) |
| Cost estimate | ~$0.0005 per compaction (2K input + 1.5K output at Haiku pricing) |

### 4.2 System prompt template — `compaction-prompt.ts`

```typescript
const COMPACTION_SYSTEM_PROMPT = `You are a CRM memory compaction engine. Your job is to merge an existing client summary with new conversation messages to produce an updated summary.

Rules:
1. Write in third person, factual tone (e.g., "Alice prefers morning appointments").
2. Target approximately 2,000 tokens. Prioritize information in this order:
   - Client preferences and stated requirements
   - Relationship milestones and key decisions
   - Unresolved topics and pending items
   - Communication style observations
   - Historical context (oldest items are the first to drop when space is tight)
3. Do NOT duplicate information already captured in structured records (follow-ups, bookings, notes). You may reference them briefly (e.g., "has an upcoming fitting appointment") but the structured records are the authoritative source.
4. Preserve concrete details: names, dates, amounts, specific preferences. Drop vague filler.
5. If the existing summary is null/empty, create an initial summary from the messages alone.
6. Output ONLY the updated summary text. No preamble, no markdown headers, no commentary.`;
```

### 4.3 User message structure

```typescript
type CompactionInput = {
  existing_summary: string | null;
  new_messages: Array<{
    direction: 'inbound' | 'outbound';
    content: string;
    timestamp: string;
    sender_type: 'client' | 'staff' | 'system';
  }>;
  client_name: string;
  workspace_timezone: string;
  current_date: string; // ISO date in workspace TZ
};
```

The user message is formatted as:

```
Client: {client_name}
Date: {current_date}

=== EXISTING SUMMARY ===
{existing_summary or "None (first compaction)"}

=== NEW MESSAGES SINCE LAST COMPACTION ===
[{timestamp}] {direction} ({sender_type}): {content}
...

Produce the updated compact summary.
```

### 4.4 LLM usage logging

After every compaction LLM call, log to `llm_usage`:

```typescript
await logLLMUsage(supabase, {
  workspaceId,
  clientId,
  edgeFunctionName: 'daily-cron',
  model: 'claude-haiku-3-20240307',
  tokensIn: response.usage.input_tokens,
  tokensOut: response.usage.output_tokens,
  latencyMs,
  costUsd: calculateCost('haiku', response.usage),
});
```

---

## 5. Flush-Before-Compact Check

### 5.1 Invariant

Before compacting a client's messages, the system verifies that all async AI extractions from F-13 have completed. This ensures that structured records (follow-ups, promises, proposed client updates) have been extracted from notes before the raw message content is summarized away.

### 5.2 Check query

```sql
-- Returns TRUE if the client has any pending (in-flight) note extractions
SELECT EXISTS (
  SELECT 1 FROM notes
  WHERE client_id = $1
    AND workspace_id = $2
    AND extraction_status = 'pending'
) AS has_pending_extractions;
```

### 5.3 Decision logic

| `extraction_status` | Blocks compaction? | Rationale |
|---------------------|-------------------|-----------|
| `pending` | **Yes** — defer client to next cycle | Extraction is in-flight; structured records not yet written |
| `complete` | No | All structured records written |
| `failed` | No | Best-effort extraction exhausted; raw note text will be included in compaction input |
| `not_applicable` | No | Source type does not need extraction (e.g., merge_history) |

### 5.4 Deferral behavior

- When a client is deferred, their `last_compacted_at` is **not** updated.
- On the next cycle, the client will be re-identified as having activity (messages since `last_compacted_at`), and all messages since the last **successful** compaction are included.
- The deferral is logged in the `compaction_runs` record (increments `deferred` counter) and a per-client log entry records the reason.

---

## 6. What Survives vs What's Summarized Away

### 6.1 Survives compaction (not affected)

These are stored in their own tables and are loaded independently in context assembly:

| Record type | Table | Loaded by context assembly slot |
|-------------|-------|---------------------------------|
| Client profile fields | `clients` | Slot: client profile (~500 tokens) |
| Notes | `notes` | Slot: active items (~1,000 tokens, last 5) |
| Follow-ups (incl. promises) | `follow_ups` | Slot: active items |
| Bookings | `bookings` | Slot: active items |
| Knowledge chunks | `knowledge_chunks` | Slot: knowledge (~2,000 tokens) |
| Communication rules | `workspaces.communication_profile` | Slot: communication rules (~500 tokens) |
| Lifecycle status | `clients.lifecycle_status` | Slot: client profile |
| Tags and preferences | `clients.tags`, `clients.preferences` | Slot: client profile |

### 6.2 Summarized away (replaced by compact summary)

| Content type | Where it was | What happens |
|-------------|-------------|--------------|
| Individual message content | `messages.content` | Absorbed into compact summary. Messages remain in DB but are not loaded into context beyond the last 10. |
| Exact conversation wording | Messages | Distilled into factual summary |
| Tool call details | Draft processing logs | Not included in compaction input |
| Draft iterations | `drafts` table | Not included in compaction input |
| Previous compact summary version | `memories` (version N) | Replaced by version N+1. Previous version retained for audit but not loaded. |

### 6.3 Compaction input assembly

```typescript
async function assembleCompactionInput(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string,
  lastCompactedAt: Date | null
): Promise<CompactionInput> {
  // 1. Load existing compact summary (latest version)
  const { data: latestMemory } = await supabase
    .from('memories')
    .select('content, version')
    .eq('client_id', clientId)
    .eq('type', 'compact_summary')
    .order('version', { ascending: false })
    .limit(1)
    .single();

  // 2. Load all messages since last compaction
  let query = supabase
    .from('messages')
    .select('direction, content, created_at, sender_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (lastCompactedAt) {
    query = query.gt('created_at', lastCompactedAt.toISOString());
  }

  const { data: newMessages } = await query;

  // 3. Load client name and workspace timezone
  const { data: client } = await supabase
    .from('clients')
    .select('full_name')
    .eq('id', clientId)
    .single();

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('timezone')
    .eq('id', workspaceId)
    .single();

  return {
    existing_summary: latestMemory?.content ?? null,
    new_messages: newMessages ?? [],
    client_name: client?.full_name ?? 'Unknown',
    workspace_timezone: workspace?.timezone ?? 'UTC',
    current_date: new Date().toLocaleDateString('en-CA', {
      timeZone: workspace?.timezone ?? 'UTC',
    }),
  };
}
```

---

## 7. Compaction Pipeline — Per-Client Flow

### 7.1 `compactClient` function

```typescript
async function compactClient(
  supabase: SupabaseClient,
  llmClient: OpenAI,  // OpenRouter via OpenAI SDK
  workspaceId: string,
  clientId: string,
  lastCompactedAt: Date | null,
  existingVersion: number | null
): Promise<CompactionResult> {
  // Step 1: Flush-before-compact check
  const hasPending = await checkPendingExtractions(supabase, workspaceId, clientId);
  if (hasPending) {
    return { status: 'deferred', reason: 'pending_extractions' };
  }

  // Step 2: Assemble compaction input
  const input = await assembleCompactionInput(supabase, workspaceId, clientId, lastCompactedAt);

  // Step 3: LLM summarization call
  const startMs = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-haiku-3-20240307',
    max_tokens: 1500,
    temperature: 0.2,
    system: COMPACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: formatCompactionUserMessage(input) }],
  });
  const latencyMs = Date.now() - startMs;

  const summaryText = response.content[0]?.type === 'text'
    ? response.content[0].text
    : null;

  // Step 4: Validate response
  if (!summaryText || summaryText.length < 50) {
    return { status: 'failed', reason: 'empty_or_malformed', rawResponse: summaryText };
  }

  const newVersion = (existingVersion ?? 0) + 1;
  const periodDate = input.current_date;

  // Step 5: Atomic write — Memory INSERT + client summary UPDATE
  const { error } = await supabase.rpc('write_compaction_result', {
    p_workspace_id: workspaceId,
    p_client_id: clientId,
    p_content: summaryText,
    p_version: newVersion,
    p_period_date: periodDate,
  });

  if (error) {
    return { status: 'failed', reason: 'db_write_failed', error: error.message };
  }

  // Step 6: Log LLM usage
  await logLLMUsage(supabase, {
    workspaceId,
    clientId,
    edgeFunctionName: 'daily-cron',
    model: 'claude-haiku-3-20240307',
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
    latencyMs,
    costUsd: calculateCost('haiku', response.usage),
  });

  return { status: 'compacted', version: newVersion };
}
```

### 7.2 Atomic write function (Postgres RPC)

```sql
CREATE OR REPLACE FUNCTION write_compaction_result(
  p_workspace_id UUID,
  p_client_id UUID,
  p_content TEXT,
  p_version INTEGER,
  p_period_date DATE
) RETURNS VOID AS $$
BEGIN
  -- Insert new Memory record
  INSERT INTO memories (workspace_id, client_id, type, content, version, period_date)
  VALUES (p_workspace_id, p_client_id, 'compact_summary', p_content, p_version, p_period_date);

  -- Update client summary + last_compacted_at
  UPDATE clients
  SET summary = p_content,
      last_compacted_at = now(),
      updated_at = now()
  WHERE id = p_client_id
    AND workspace_id = p_workspace_id;
END;
$$ LANGUAGE plpgsql;
```

Both operations run in a single transaction. If either fails, both are rolled back.

---

## 8. Edge Cases

### 8.1 LLM failure

- **Transient error (timeout, rate limit, 500):** Client's compaction is marked as failed. The client retains their previous compact summary. The compaction job continues to process other clients. The client is retried on the next daily cycle (activity since `last_compacted_at` still qualifies them).
- **Malformed response:** Rejected if response is empty, under 50 characters, or contains obvious error patterns (e.g., "I cannot", "As an AI"). Treated as a failed compaction.
- **All LLM calls fail (outage):** Job completes with `compacted=0, failed=N`. Alert-level log entry emitted. All clients retain their previous summaries and are retried the next day.

### 8.2 No activity

- Clients with no messages since `last_compacted_at` are excluded from the candidate list before any LLM call. No Memory record is created. No cost incurred.
- A client with zero messages ever (created but never messaged) is never a compaction candidate.

### 8.3 Concurrent compaction

- **Same workspace, same day:** The `UNIQUE INDEX` on `compaction_runs (workspace_id, run_date)` prevents a second run. If the dispatcher fires twice (e.g., scheduler restart), the second attempt fails the uniqueness check and is silently skipped.
- **Same client, overlapping workers:** The per-client compaction operates within a single Edge Function invocation (sequential processing). There is no concurrent per-client compaction. If the Edge Function crashes mid-run, the next day's run picks up unprocessed clients (their `last_compacted_at` was not updated).

### 8.4 Very long message history

- If a client has hundreds of messages since last compaction (e.g., compaction was deferred for several days), the message list is truncated to the most recent 200 messages before being sent to the LLM. A log warning is emitted noting the truncation.
- Token budget for compaction input: ~8,000 tokens max (existing summary ~2K + messages ~6K). If the input exceeds this, oldest messages in the window are dropped.

### 8.5 Edge Function timeout

- The `daily-cron` Edge Function has a 150-second timeout (Supabase Pro tier). For a workspace with many active clients (50+), the function processes clients sequentially. If it times out:
  - Clients already compacted have durable committed transactions.
  - Unprocessed clients are picked up on the next cycle.
  - The `compaction_runs` record will have `status = 'running'` indefinitely. A cleanup query (run by the dispatcher before starting) marks stale `running` records from previous days as `failed`.

### 8.6 First compaction for a new client

- `existing_summary` is null. The LLM receives only the messages and produces an initial summary at version 1.
- `last_compacted_at` is null, so the activity query includes all messages for this client.

---

## 9. Acceptance Criteria to Tasks

### Task 1: Database migrations (US-F11-01, US-F11-04)
- [ ] Add `last_compacted_at` column to `clients` table
- [ ] Add index `idx_clients_last_compacted`
- [ ] Create `compaction_runs` table with unique constraint on `(workspace_id, run_date)`
- [ ] Add unique index `idx_memories_client_type_version` on `memories`
- [ ] Create `write_compaction_result` Postgres RPC function

### Task 2: pg_cron dispatcher setup (US-F11-01)
- [ ] Create `daily-cron-dispatcher` pg_cron job (hourly, finds workspaces at 03:00 local)
- [ ] Verify DST handling with `AT TIME ZONE` conversion
- [ ] Verify idempotency guard (`NOT EXISTS` on `compaction_runs`)
- [ ] Test timezone change takes effect on next cycle

### Task 3: Compaction orchestrator — `compaction.ts` (US-F11-01, US-F11-05)
- [ ] Query active clients: `messages.created_at > clients.last_compacted_at`
- [ ] Skip clients with no activity (no messages since last compaction)
- [ ] Create `compaction_runs` record at start, update at end with counts
- [ ] Sequential per-client processing with error containment
- [ ] Log run summary: total_clients, active_candidates, compacted, deferred, failed, skipped

### Task 4: Flush-before-compact check (US-F11-02)
- [ ] Query `notes` table for `extraction_status = 'pending'` per client
- [ ] Defer client if any pending extractions exist
- [ ] Log deferral reason per client (client_id, workspace_id, reason, pending count)
- [ ] Verify failed extractions do NOT block compaction

### Task 5: LLM summarization call (US-F11-03)
- [ ] Implement `compaction-prompt.ts` with system prompt and priority ordering
- [ ] Implement `assembleCompactionInput` — load existing summary + new messages
- [ ] Call Claude Haiku with temperature 0.2, max_tokens 1500
- [ ] Validate response: non-empty, > 50 chars, no error patterns
- [ ] Log LLM usage to `llm_usage` table

### Task 6: Versioned Memory write (US-F11-04)
- [ ] Implement atomic `write_compaction_result` RPC call (Memory INSERT + client.summary UPDATE)
- [ ] Verify version is monotonically increasing (existing version + 1)
- [ ] Verify rollback on partial failure
- [ ] First compaction creates version 1 when no existing Memory exists

### Task 7: Error handling and resilience (US-F11-06)
- [ ] Per-client error containment: one failure does not abort the job
- [ ] LLM timeout/error: mark client as failed, retain previous summary
- [ ] Malformed response: reject, log raw response for debugging
- [ ] DB write failure: rollback, log generated summary for manual recovery
- [ ] All-fail scenario: job completes, alert-level log emitted
- [ ] Stale `running` compaction_runs records from previous days cleaned up on next dispatch

### Task 8: Integration tests
- [ ] Compaction runs at correct timezone-local hour
- [ ] Multiple workspaces in different timezones compact independently
- [ ] Flush-before-compact defers client with pending extractions
- [ ] Deferred client is retried next cycle with full message window
- [ ] Skip-no-activity: no LLM call for inactive clients
- [ ] Version increments correctly across multiple compaction cycles
- [ ] LLM failure does not corrupt existing summary
- [ ] Idempotency: same-day rerun is silently skipped
