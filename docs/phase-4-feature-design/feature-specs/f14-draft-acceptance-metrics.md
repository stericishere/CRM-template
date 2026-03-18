# Feature Spec — F-14: Draft Acceptance Metrics

**Feature:** F-14 Draft Acceptance Metrics
**Phase:** 3 (Operational Memory & Follow-ups)
**Size:** S (2–3 days)
**PRD Functions:** LL-02, LL-09
**Architecture module:** `modules/learning-optimization`
**User stories:** US-F14-01 through US-F14-04
**Depends on:** F-10 (Learning Signal Capture — produces `draft_edit_signals` records), F-02 (WhatsApp Message Pipeline — delivers inbound messages for reply detection)
**Required by:** F-15 (Learning Loop & Communication Rules — Phase 4, consumes `client_replied` and `client_reply_latency_minutes`)

---

## 1. Component Breakdown

### 1.1 Next.js API routes — `app/api/workspaces/[workspaceId]/metrics/`

| File | Responsibility |
|------|----------------|
| `acceptance/route.ts` | `GET` endpoint. Returns draft acceptance rate aggregation for the workspace. Supports `?days=7|30|90` query param for date range filter. Includes per-scenario breakdown. |
| `replies/route.ts` | `GET` endpoint. Returns client reply rate and latency metrics for the workspace. Supports `?days=7|30|90`. Includes per-scenario breakdown. |

### 1.2 Reply tracking logic — `supabase/functions/process-message/`

Reply tracking is embedded in the inbound message processing pipeline (F-02's `process-message` Edge Function). When a new inbound message arrives, the pipeline checks for a recent outbound signal to backfill.

| File | Responsibility |
|------|----------------|
| `reply-tracker.ts` | On inbound message receipt, queries for the most recent `draft_edit_signals` record in the same conversation with `staff_action IN ('sent_as_is', 'edited_and_sent')` and `client_replied IS NULL`. If found and within observation window, backfills `client_replied = true` and `client_reply_latency_minutes`. |

### 1.3 Observation window closer — `supabase/functions/daily-cron/`

| File | Responsibility |
|------|----------------|
| `close-observation-windows.ts` | Runs as part of the daily-cron Edge Function. Queries for `draft_edit_signals` with `client_replied IS NULL` and `created_at < now() - interval '72 hours'`. Sets `client_replied = false` for all matching records. |

### 1.4 Settings page component — `app/(staff)/settings/ai-performance/`

| File | Responsibility |
|------|----------------|
| `page.tsx` | Server component. Fetches metrics from both API endpoints. Renders acceptance rate summary, reply rate summary, and expandable per-scenario breakdown. |
| `MetricsCard.tsx` | Client component. Displays a single metric card (rate, count, label). Handles "Not enough data yet" state. |
| `ScenarioBreakdown.tsx` | Client component. Expandable table showing per-scenario counts and rates. Displays "insufficient data" for scenario types with < 5 signals. |
| `DateRangePicker.tsx` | Client component. Toggles between 7/30/90-day windows. Updates URL search params. |

---

## 2. Data Model

### 2.1 Schema changes to `draft_edit_signals`

The existing `draft_edit_signals` table (Architecture §9.1) needs two new nullable columns for reply tracking:

```sql
ALTER TABLE draft_edit_signals
  ADD COLUMN client_replied BOOLEAN,
  ADD COLUMN client_reply_latency_minutes INTEGER,
  ADD COLUMN conversation_id UUID REFERENCES conversations(id),
  ADD COLUMN scenario_type TEXT;

-- Index for reply tracking: find signals awaiting reply backfill
CREATE INDEX idx_signals_pending_reply
  ON draft_edit_signals (conversation_id, created_at DESC)
  WHERE client_replied IS NULL
    AND staff_action IN ('sent_as_is', 'edited_and_sent');

-- Index for observation window closer
CREATE INDEX idx_signals_observation_window
  ON draft_edit_signals (created_at)
  WHERE client_replied IS NULL
    AND staff_action IN ('sent_as_is', 'edited_and_sent');

-- Index for metrics aggregation
CREATE INDEX idx_signals_workspace_metrics
  ON draft_edit_signals (workspace_id, created_at DESC);
```

### 2.2 Column semantics

| Column | Type | Set by | When |
|--------|------|--------|------|
| `staff_action` | TEXT NOT NULL | F-10 | At draft send/discard/regeneration time |
| `client_replied` | BOOLEAN (nullable) | F-14 reply tracker | `true` on inbound match; `false` after 72h window; `null` while window is open |
| `client_reply_latency_minutes` | INTEGER (nullable) | F-14 reply tracker | Rounded minutes from `reviewed_at` to inbound message timestamp; `null` if no reply |
| `conversation_id` | UUID | F-10 | At signal creation time (links signal to conversation for reply matching) |
| `scenario_type` | TEXT (nullable) | F-10 | At signal creation time (from `drafts.intent_classified`) |

---

## 3. SQL Aggregation — Acceptance Rates

### 3.1 Acceptance rate query

```sql
-- Acceptance rate for a workspace within a date range
SELECT
  COUNT(*) FILTER (WHERE staff_action = 'sent_as_is') AS sent_as_is_count,
  COUNT(*) FILTER (WHERE staff_action = 'edited_and_sent') AS edited_and_sent_count,
  COUNT(*) FILTER (WHERE staff_action = 'regenerated') AS regenerated_count,
  COUNT(*) FILTER (WHERE staff_action = 'discarded') AS discarded_count,
  COUNT(*) AS total_signals,
  CASE
    WHEN COUNT(*) = 0 THEN NULL
    ELSE ROUND(
      (COUNT(*) FILTER (WHERE staff_action IN ('sent_as_is', 'edited_and_sent'))::NUMERIC
       / COUNT(*)::NUMERIC) * 100,
      1
    )
  END AS acceptance_rate_pct
FROM draft_edit_signals
WHERE workspace_id = $1
  AND created_at >= now() - ($2 || ' days')::INTERVAL;
```

### 3.2 Per-scenario breakdown query

```sql
SELECT
  scenario_type,
  COUNT(*) FILTER (WHERE staff_action = 'sent_as_is') AS sent_as_is,
  COUNT(*) FILTER (WHERE staff_action = 'edited_and_sent') AS edited_and_sent,
  COUNT(*) FILTER (WHERE staff_action = 'regenerated') AS regenerated,
  COUNT(*) FILTER (WHERE staff_action = 'discarded') AS discarded,
  COUNT(*) AS total
FROM draft_edit_signals
WHERE workspace_id = $1
  AND created_at >= now() - ($2 || ' days')::INTERVAL
  AND scenario_type IS NOT NULL
GROUP BY scenario_type
ORDER BY total DESC;
```

---

## 4. Client Reply Detection

### 4.1 Reply matching logic — `reply-tracker.ts`

When the `process-message` Edge Function processes an inbound message:

```typescript
async function trackClientReply(
  supabase: SupabaseClient,
  conversationId: string,
  inboundTimestamp: Date
): Promise<void> {
  // Find the most recent sent signal in this conversation
  // that hasn't been reply-tracked yet
  const { data: signal } = await supabase
    .from('draft_edit_signals')
    .select('id, created_at')
    .eq('conversation_id', conversationId)
    .in('staff_action', ['sent_as_is', 'edited_and_sent'])
    .is('client_replied', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!signal) return;

  // Check if within observation window (72 hours)
  const signalTime = new Date(signal.created_at);
  const hoursSinceSend = (inboundTimestamp.getTime() - signalTime.getTime()) / (1000 * 60 * 60);
  if (hoursSinceSend > 72) return;

  // Calculate latency from reviewed_at (dispatch time), not created_at
  // Get the draft's reviewed_at timestamp
  const { data: signalFull } = await supabase
    .from('draft_edit_signals')
    .select('id, created_at')
    .eq('id', signal.id)
    .single();

  // Use the draft's reviewed_at for latency calculation
  const { data: draft } = await supabase
    .from('drafts')
    .select('reviewed_at')
    .eq('id', (await supabase.from('draft_edit_signals').select('draft_id').eq('id', signal.id).single()).data?.draft_id)
    .single();

  const dispatchTime = draft?.reviewed_at
    ? new Date(draft.reviewed_at)
    : signalTime;

  const latencyMinutes = Math.round(
    (inboundTimestamp.getTime() - dispatchTime.getTime()) / (1000 * 60)
  );

  // Backfill the signal
  await supabase
    .from('draft_edit_signals')
    .update({
      client_replied: true,
      client_reply_latency_minutes: Math.max(0, latencyMinutes),
    })
    .eq('id', signal.id);
}
```

### 4.2 Key matching rules

| Rule | Rationale |
|------|-----------|
| Match by `conversation_id`, not just `client_id` | Prevents cross-thread contamination (US-F14-02) |
| Only match signals with `staff_action IN ('sent_as_is', 'edited_and_sent')` | Discarded and regenerated drafts were never sent |
| Only match signals with `client_replied IS NULL` | Already-tracked signals are not modified |
| Only the most recent signal is matched | Multiple sent messages: only the latest gets the reply attribution (US-F14-02) |
| Observation window: 72 hours from signal `created_at` | Balances practical reply patterns with false negative risk |

### 4.3 Latency calculation

- **Start time:** `drafts.reviewed_at` (when staff dispatched the message), not `draft_edit_signals.created_at` (when the signal was recorded).
- **End time:** The inbound message `created_at` timestamp.
- **Rounding:** `Math.round()` to nearest whole minute. Sub-minute replies round to 0.
- **Null:** `client_reply_latency_minutes` remains null when `client_replied = false`.

---

## 5. Reply Latency Aggregation

### 5.1 Metrics query

```sql
SELECT
  COUNT(*) FILTER (WHERE client_replied = true) AS replied_count,
  COUNT(*) FILTER (WHERE client_replied = false) AS no_reply_count,
  COUNT(*) FILTER (WHERE client_replied IS NULL
    AND staff_action IN ('sent_as_is', 'edited_and_sent')) AS pending_count,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY client_reply_latency_minutes)
    FILTER (WHERE client_replied = true) AS median_reply_latency_minutes,
  PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY client_reply_latency_minutes)
    FILTER (WHERE client_replied = true) AS p90_reply_latency_minutes
FROM draft_edit_signals
WHERE workspace_id = $1
  AND created_at >= now() - ($2 || ' days')::INTERVAL;
```

### 5.2 Per-scenario latency breakdown

```sql
SELECT
  scenario_type,
  COUNT(*) FILTER (WHERE client_replied = true) AS replied_count,
  CASE
    WHEN COUNT(*) FILTER (WHERE client_replied = true) < 5 THEN NULL
    ELSE PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY client_reply_latency_minutes)
      FILTER (WHERE client_replied = true)
  END AS median_reply_latency_minutes
FROM draft_edit_signals
WHERE workspace_id = $1
  AND created_at >= now() - ($2 || ' days')::INTERVAL
  AND scenario_type IS NOT NULL
GROUP BY scenario_type
ORDER BY replied_count DESC;
```

Scenario types with fewer than 5 replied signals return `NULL` for median latency (displayed as "insufficient data" in the UI).

---

## 6. Settings Page Display

### 6.1 API response format — `GET /api/workspaces/:id/metrics/acceptance`

```typescript
type AcceptanceMetricsResponse = {
  period_days: number;
  total_signals: number;
  acceptance_rate_pct: number | null; // null if total_signals < 10
  sent_as_is_count: number;
  edited_and_sent_count: number;
  regenerated_count: number;
  discarded_count: number;
  insufficient_data: boolean; // true if total_signals < 10
  scenario_breakdown: Array<{
    scenario_type: string;
    sent_as_is: number;
    edited_and_sent: number;
    regenerated: number;
    discarded: number;
    total: number;
  }>;
};
```

### 6.2 API response format — `GET /api/workspaces/:id/metrics/replies`

```typescript
type ReplyMetricsResponse = {
  period_days: number;
  replied_count: number;
  no_reply_count: number;
  pending_count: number;
  reply_rate_pct: number | null; // null if (replied + no_reply) < 10
  median_reply_latency_minutes: number | null;
  p90_reply_latency_minutes: number | null;
  insufficient_data: boolean;
  scenario_breakdown: Array<{
    scenario_type: string;
    replied_count: number;
    median_reply_latency_minutes: number | null; // null if replied_count < 5
  }>;
};
```

### 6.3 UI states

| State | Condition | Display |
|-------|-----------|---------|
| Normal | `total_signals >= 10` | Full metrics with percentages and counts |
| Insufficient data | `total_signals < 10` | Raw counts shown; rate displays "Not enough data yet"; message: "Metrics become meaningful after ~10 drafts have been reviewed" |
| No data | `total_signals = 0` | All counts show 0; rates show "--"; no scenario breakdown |
| Pending signals tooltip | `pending_count > 0` | Tooltip: "X messages sent within the last 72 hours are still awaiting client reply" |

### 6.4 Latency formatting

| Range | Display format |
|-------|---------------|
| 0–59 minutes | "{N} min" |
| 60–1439 minutes | "{H}h {M}m" (e.g., "2h 15m") |
| 1440+ minutes | "{D}d {H}h" (e.g., "1d 3h") |

---

## 7. Edge Cases

### 7.1 Insufficient data

- The 10-signal threshold gates the acceptance rate percentage display (not the raw counts). Even with 3 signals, staff sees the individual counts. The percentage is shown as "Not enough data yet."
- Per-scenario breakdown shows "insufficient data" per row for scenario types with < 5 replied signals in the latency column.

### 7.2 Pending signals

- Signals with `client_replied IS NULL` are excluded from reply rate calculations. They are counted separately as `pending_count` and displayed with a tooltip.
- This prevents recent messages (< 72h) from deflating the reply rate.

### 7.3 Observation window edge cases

- **Client replies after 72h:** Signal is not retroactively updated. The late reply is processed normally by the message pipeline but does not backfill the old signal.
- **Multiple sent messages, one reply:** Only the most recent sent signal in the conversation is updated (US-F14-02). Earlier signals remain with `client_replied IS NULL` until their observation window closes, at which point they are marked `false`.

### 7.4 Regenerated signals

- Each regeneration event creates its own signal with `staff_action = 'regenerated'`. The final sent version creates a separate signal with `sent_as_is` or `edited_and_sent`.
- Regenerated and discarded signals never receive reply tracking (they were never sent).

### 7.5 Cross-workspace isolation

- All queries include `WHERE workspace_id = $1`.
- The API route validates that the JWT workspace matches the route parameter.
- A 403 is returned if a user attempts to access another workspace's metrics.

### 7.6 Pre-F-14 signals (backfill decision)

- Signals created by F-10 before F-14 is deployed will have `client_replied IS NULL`, `client_reply_latency_minutes IS NULL`, `conversation_id IS NULL`, `scenario_type IS NULL`.
- Signals older than 72 hours at deploy time: the daily-cron observation window closer will set `client_replied = false` on the first run after deployment. These are not retroactively backfilled.
- This is acceptable for MVP. A one-time migration could be built later if historical data is needed.

---

## 8. Acceptance Criteria to Tasks

### Task 1: Database migrations (US-F14-01, US-F14-02, US-F14-03)
- [ ] Add `client_replied` (BOOLEAN nullable) column to `draft_edit_signals`
- [ ] Add `client_reply_latency_minutes` (INTEGER nullable) column to `draft_edit_signals`
- [ ] Add `conversation_id` (UUID FK) column to `draft_edit_signals`
- [ ] Add `scenario_type` (TEXT nullable) column to `draft_edit_signals`
- [ ] Create index `idx_signals_pending_reply`
- [ ] Create index `idx_signals_observation_window`
- [ ] Create index `idx_signals_workspace_metrics`

### Task 2: Reply tracker — `reply-tracker.ts` (US-F14-02, US-F14-03)
- [ ] Implement `trackClientReply` function in process-message pipeline
- [ ] Match by conversation_id + most recent sent signal with null reply
- [ ] Calculate latency from `drafts.reviewed_at` (not signal created_at)
- [ ] Round latency to nearest minute
- [ ] Respect 72h observation window
- [ ] Ignore discarded and regenerated signals

### Task 3: Observation window closer (US-F14-02)
- [ ] Add `close-observation-windows.ts` to daily-cron Edge Function
- [ ] Query signals with `client_replied IS NULL` and `created_at < now() - 72h`
- [ ] Batch update: `SET client_replied = false`
- [ ] Log count of closed windows per run

### Task 4: Acceptance rate API — `acceptance/route.ts` (US-F14-01)
- [ ] Implement `GET /api/workspaces/:id/metrics/acceptance`
- [ ] Accept `?days=7|30|90` query param (default 30)
- [ ] Return workspace-scoped aggregation with all four action counts
- [ ] Return per-scenario breakdown
- [ ] Return `null` acceptance rate when total_signals < 10
- [ ] Validate workspace_id matches JWT

### Task 5: Reply metrics API — `replies/route.ts` (US-F14-03)
- [ ] Implement `GET /api/workspaces/:id/metrics/replies`
- [ ] Accept `?days=7|30|90` query param (default 30)
- [ ] Return replied_count, no_reply_count, pending_count
- [ ] Calculate median and p90 using `PERCENTILE_CONT`
- [ ] Return per-scenario breakdown with "insufficient data" for < 5 signals
- [ ] Validate workspace_id matches JWT

### Task 6: Settings page — AI Performance (US-F14-04)
- [ ] Create `app/(staff)/settings/ai-performance/page.tsx`
- [ ] Implement MetricsCard component with normal / insufficient / no-data states
- [ ] Implement DateRangePicker (7/30/90 days)
- [ ] Implement ScenarioBreakdown expandable table
- [ ] Format latency as "X min" / "Xh Ym" / "Xd Yh"
- [ ] Pending signals tooltip
- [ ] Page is read-only, data refreshes at page load
- [ ] Cross-workspace access returns 403

### Task 7: Update F-10 signal recording (prerequisite)
- [ ] Ensure F-10 writes `conversation_id` and `scenario_type` when creating `draft_edit_signals`
- [ ] `scenario_type` comes from `drafts.intent_classified`
- [ ] Backfill `conversation_id` from the draft's conversation for existing records (migration)

### Task 8: Integration tests
- [ ] Acceptance rate calculates correctly for all four action types
- [ ] Zero-signal workspace returns null rate (not 0%)
- [ ] Date range filter restricts to correct window
- [ ] Reply tracker backfills on inbound message receipt
- [ ] Multiple sent messages: only latest gets reply attribution
- [ ] 72h window closer marks unreplied signals as false
- [ ] Cross-conversation reply does not pollute other threads
- [ ] Per-scenario breakdown sums to workspace totals
- [ ] Insufficient data threshold (< 10 total, < 5 per scenario) correctly applied
