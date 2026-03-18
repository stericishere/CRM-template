# Feature Spec -- F-12: COS Daily Operations & Today's View

**Feature:** F-12 COS Daily Operations & Today's View
**Phase:** 3 (Operational Memory & Follow-ups)
**Size:** XL (10--15 days)
**PRD Functions:** CO-01, CO-02, CO-03, CO-04, CO-05, CO-06, CO-07, NF-07
**Architecture modules:** `daily-cron` Edge Function (COS operations phase), `process-message` Edge Function (Client Worker follow-up drafts), Today's View API route + page
**ADR dependencies:** ADR-4 (COS identifies clients, Client Worker drafts messages), ADR-4 (No COS LLM call for MVP -- Today's View is a SQL query, not an LLM invocation)
**User stories:** US-F12-01 through US-F12-10
**Depends on:** F-11 (compact summaries for follow-up draft context), F-09 (follow-up records), F-05 (Client Worker runtime), F-07 (bookings), F-03 (client lifecycle)
**Required by:** F-04 (notification pipeline delivers COS-generated draft alerts)

---

## 0. Critical MVP Constraint: No COS LLM Call

Per `architecture-final.md` (ADR-4, Section 11.5):

> For MVP, this is unnecessary. The daily cron surfaces items via SQL queries and displays them in the "Today's View" page. The Client Worker handles follow-up draft generation with per-client context.

The user stories describe LLM-powered priority ranking (US-F12-04). **For MVP, this is replaced by deterministic SQL-based urgency heuristics.** The ranking described in US-F12-04 becomes the fallback ordering from that story's "LLM ranking failure" scenario:

| Priority tier | Item type | Sort within tier |
|---------------|-----------|-----------------|
| 1 (highest) | `same_day_unconfirmed` | Hours until appointment ASC |
| 2 | `unconfirmed_booking` | Hours until appointment ASC |
| 3 | `overdue_follow_up` | Days past due DESC |
| 4 | `stale_conversation` | Days since contact DESC |
| 5 (lowest) | `warm_lead` | Days since contact DESC |

No `COSOperationsContext` is sent to an LLM. No LLM-generated reason text. Reason strings are template-generated in application code.

Follow-up draft dispatch **does** use LLM -- it enqueues pgmq messages that invoke the `process-message` Edge Function (Client Worker) per client. This is the existing F-05 pipeline, not a COS LLM call.

---

## 1. Component Breakdown

### 1.1 Edge Function -- `supabase/functions/daily-cron/`

The `daily-cron` Edge Function already exists for F-11 compaction. F-12 adds the COS operations phase that runs **after** compaction completes (so compact summaries are fresh for Client Worker follow-up drafts).

| File | Responsibility |
|------|----------------|
| `index.ts` | Edge Function entry point. Receives `{ workspace_id, phase }` from pg_cron dispatcher. Runs compaction (F-11) first, then COS operations (F-12). Handles phase-specific invocations. |
| `cos-operations.ts` | COS orchestrator. Runs all detection queries, computes urgency scores, writes `cos_run` + `cos_action_items`, dispatches follow-up draft jobs to pgmq. |
| `queries/stale-conversations.ts` | SQL query builder for stale conversation detection (US-F12-02). |
| `queries/overdue-followups.ts` | SQL query builder for overdue follow-up surfacing (US-F12-05). Status transition `open`/`pending` -> `overdue`. |
| `queries/unconfirmed-bookings.ts` | SQL query builder for at-risk booking detection (US-F12-03). Status transition to `at_risk`. |
| `queries/warm-leads.ts` | SQL query builder for warm lead identification (US-F12-09). |
| `urgency.ts` | Deterministic urgency scoring and sorting. Assigns `urgency_score` (0--100) and generates template reason strings. |
| `dispatch.ts` | Enqueues follow-up draft requests to pgmq. Deduplicates by `client_id` + `cos_run_date`. Batches multiple action items per client into one pgmq message. |

### 1.2 Shared modules -- `supabase/functions/_shared/`

| File | Responsibility |
|------|----------------|
| `types/cos.ts` | TypeScript types for `CosRun`, `CosActionItem`, `FollowUpDraftPayload`, urgency enums. |

No new shared modules required beyond types. The `process-message` Edge Function already handles Client Worker invocations (F-05). Follow-up drafts are processed through the same path.

### 1.3 Next.js API route -- `src/app/api/today/route.ts`

Server-side API route that assembles the Today's View response. Runs SQL queries against Supabase using the service client (server-side, not browser client).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/today` | GET | Returns structured JSON for Today's View page. Queries bookings, COS action items, draft status. |
| `POST /api/today/refresh` | POST | Triggers on-demand COS re-detection (US-F12-10). Rate-limited to 1 per 5 minutes per workspace. Returns fresh results. |

### 1.4 Next.js page -- `src/app/(dashboard)/today/page.tsx`

Already exists in the codebase structure (Architecture Section 13). Renders the Today's View using data from `/api/today`.

| Component | Purpose |
|-----------|---------|
| `src/components/today/TodayBookings.tsx` | Chronological list of today's bookings with confirmation status badges. |
| `src/components/today/ActionList.tsx` | Ranked action items (overdue follow-ups, stale conversations, warm leads). |
| `src/components/today/ActionItem.tsx` | Single action item card: client name, type badge, reason, days overdue/since contact, draft status indicator, link to client thread. |
| `src/components/today/EmptyState.tsx` | "All caught up" state with next upcoming booking preview. |

### 1.5 Database additions

| Object | Type | Purpose |
|--------|------|---------|
| `cos_runs` table | **New** | Audit log of COS operation runs per workspace |
| `cos_action_items` table | **New** | Persisted ranked action items per COS run |
| pgmq queue `followup_drafts` | **New** | Queue for Client Worker follow-up draft requests |

---

## 2. Data Model

### 2.1 `cos_runs` table (new)

```sql
CREATE TABLE cos_runs (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID          NOT NULL REFERENCES workspaces(id),
  run_date        DATE          NOT NULL,          -- local date in workspace TZ
  trigger         TEXT          NOT NULL DEFAULT 'daily_cron'
                  CHECK (trigger IN ('daily_cron', 'on_demand')),
  triggered_by    UUID          REFERENCES staff(id),  -- null for daily_cron
  started_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  status          TEXT          NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed')),
  actions_found   INTEGER       NOT NULL DEFAULT 0,
  drafts_queued   INTEGER       NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Idempotency: one daily_cron run per workspace per day.
-- On-demand runs are allowed alongside the daily run.
CREATE UNIQUE INDEX idx_cos_runs_workspace_daily
  ON cos_runs (workspace_id, run_date)
  WHERE trigger = 'daily_cron';

CREATE INDEX idx_cos_runs_workspace_date
  ON cos_runs (workspace_id, run_date DESC);
```

### 2.2 `cos_action_items` table (new)

```sql
CREATE TABLE cos_action_items (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  cos_run_id      UUID          NOT NULL REFERENCES cos_runs(id) ON DELETE CASCADE,
  workspace_id    UUID          NOT NULL REFERENCES workspaces(id),
  client_id       UUID          NOT NULL REFERENCES clients(id),
  item_type       TEXT          NOT NULL
                  CHECK (item_type IN (
                    'same_day_unconfirmed',
                    'unconfirmed_booking',
                    'overdue_follow_up',
                    'stale_conversation',
                    'warm_lead'
                  )),
  urgency_score   INTEGER       NOT NULL,          -- 0-100, higher = more urgent
  rank            INTEGER       NOT NULL,           -- position in sorted list
  reason          TEXT          NOT NULL,            -- template-generated reason string
  reference_id    UUID,                              -- FK to follow_ups.id or bookings.id
  reference_type  TEXT,                              -- 'follow_up', 'booking', 'conversation'
  draft_status    TEXT          NOT NULL DEFAULT 'pending'
                  CHECK (draft_status IN ('pending', 'queued', 'generated', 'failed', 'skipped')),
  draft_id        UUID          REFERENCES drafts(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_cos_action_items_run
  ON cos_action_items (cos_run_id, rank);

CREATE INDEX idx_cos_action_items_workspace_date
  ON cos_action_items (workspace_id, created_at DESC);

-- For deduplication: prevent queueing duplicate drafts for same client on same date
CREATE INDEX idx_cos_action_items_dedup
  ON cos_action_items (workspace_id, client_id, item_type, (created_at::date));
```

### 2.3 pgmq queue for follow-up drafts

```sql
SELECT pgmq.create('followup_drafts');
SELECT pgmq.create('followup_drafts_dlq');
```

---

## 3. SQL Queries -- Detection

All detection queries are scoped by `workspace_id` and operate on structured records only. No message content is read.

### 3.1 Stale conversations (US-F12-02)

Detects conversations where the client has gone silent past the configured timeout. Also catches conversations already in `follow_up_pending` state.

```sql
-- Stale conversation detection
-- Returns conversations exceeding staleness threshold
SELECT
  c.id AS client_id,
  c.full_name AS client_name,
  conv.id AS conversation_id,
  conv.state AS conversation_state,
  conv.last_message_at,
  EXTRACT(EPOCH FROM (now() - conv.last_message_at)) / 86400 AS days_since_contact
FROM conversations conv
JOIN clients c ON c.id = conv.client_id
WHERE conv.workspace_id = $1
  AND c.deleted_at IS NULL
  AND conv.state IN ('awaiting_client_reply', 'booking_in_progress', 'follow_up_pending')
  AND (
    -- Already timed out to follow_up_pending
    conv.state = 'follow_up_pending'
    OR
    -- Still in timeout-eligible state but exceeded threshold
    (conv.state IN ('awaiting_client_reply', 'booking_in_progress')
     AND conv.last_message_at < now() - ($2 || ' hours')::interval)
  )
ORDER BY conv.last_message_at ASC;
-- $1 = workspace_id, $2 = staleness_threshold_hours (default 24)
```

### 3.2 Overdue follow-ups (US-F12-05)

Finds follow-ups past their due date. Also transitions status from `open`/`pending` to `overdue`.

```sql
-- Detection query
SELECT
  fu.id AS follow_up_id,
  fu.client_id,
  c.full_name AS client_name,
  fu.type AS follow_up_type,       -- 'follow_up', 'promise', 'reminder'
  fu.content AS follow_up_content,
  fu.due_date,
  (CURRENT_DATE - fu.due_date) AS days_past_due
FROM follow_ups fu
JOIN clients c ON c.id = fu.client_id
WHERE fu.workspace_id = $1
  AND fu.status IN ('open', 'pending', 'overdue')
  AND fu.due_date IS NOT NULL
  AND fu.due_date < CURRENT_DATE
  AND c.deleted_at IS NULL
ORDER BY fu.due_date ASC;

-- Status transition (run as part of COS operations, not a separate step)
UPDATE follow_ups
SET status = 'overdue'
WHERE workspace_id = $1
  AND status IN ('open', 'pending')
  AND due_date IS NOT NULL
  AND due_date < CURRENT_DATE;
```

### 3.3 Unconfirmed bookings (US-F12-03)

Detects bookings approaching within the confirmation reminder window that have not been confirmed.

```sql
-- Unconfirmed booking detection
SELECT
  b.id AS booking_id,
  b.client_id,
  c.full_name AS client_name,
  b.appointment_type,
  b.start_time,
  b.status AS booking_status,
  b.confirmation_status,
  EXTRACT(EPOCH FROM (b.start_time - now())) / 3600 AS hours_until_appointment,
  CASE
    WHEN b.start_time::date = (now() AT TIME ZONE $3)::date THEN 'same_day_unconfirmed'
    WHEN b.confirmation_status = 'unconfirmed' THEN 'client_unconfirmed'
    ELSE 'confirmation_pending'
  END AS reason_code
FROM bookings b
JOIN clients c ON c.id = b.client_id
WHERE b.workspace_id = $1
  AND b.status NOT IN ('cancelled', 'completed', 'no_show')
  AND b.confirmation_status IN ('pending', 'unconfirmed')
  AND b.start_time > now()
  AND b.start_time < now() + ($2 || ' hours')::interval
  AND c.deleted_at IS NULL
ORDER BY b.start_time ASC;
-- $1 = workspace_id, $2 = confirmation_window_hours (default 48), $3 = workspace timezone

-- Flag at-risk bookings (write operation during COS run)
UPDATE bookings
SET status = 'at_risk'
WHERE workspace_id = $1
  AND status = 'confirmed'
  AND confirmation_status IN ('pending', 'unconfirmed')
  AND start_time > now()
  AND start_time < now() + ($2 || ' hours')::interval;
```

### 3.4 Warm leads (US-F12-09)

Identifies clients with interest signals (lifecycle `open` or `chosen_service`, recent-ish conversation) but no booking. Must be past the staleness threshold (> 24h since last contact) but within the interest decay window.

```sql
-- Warm lead detection
SELECT
  c.id AS client_id,
  c.full_name AS client_name,
  c.lifecycle_status,
  c.last_contacted_at,
  EXTRACT(EPOCH FROM (now() - c.last_contacted_at)) / 86400 AS days_since_contact,
  (
    SELECT fu.content FROM follow_ups fu
    WHERE fu.client_id = c.id AND fu.status IN ('open', 'pending', 'overdue')
    ORDER BY fu.created_at DESC LIMIT 1
  ) AS latest_open_followup
FROM clients c
WHERE c.workspace_id = $1
  AND c.deleted_at IS NULL
  AND c.lifecycle_status IN ('open', 'chosen_service')
  -- Past staleness threshold (not an active conversation)
  AND c.last_contacted_at < now() - interval '24 hours'
  -- Within interest decay window (still warm, not cold)
  AND c.last_contacted_at > now() - ($2 || ' days')::interval
  -- No future bookings
  AND NOT EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.client_id = c.id
      AND b.workspace_id = $1
      AND b.status NOT IN ('cancelled', 'no_show')
      AND b.start_time > now()
  )
ORDER BY c.last_contacted_at DESC;
-- $1 = workspace_id, $2 = warm_lead_window_days (default 14)
```

---

## 4. Urgency Scoring and Sorting

The urgency scoring replaces the deferred LLM ranking (US-F12-04). All scores are deterministic and computed in application code.

### 4.1 Scoring function -- `urgency.ts`

```typescript
type ActionItemType =
  | 'same_day_unconfirmed'
  | 'unconfirmed_booking'
  | 'overdue_follow_up'
  | 'stale_conversation'
  | 'warm_lead';

// Base scores by type (sets the priority tier)
const BASE_SCORES: Record<ActionItemType, number> = {
  same_day_unconfirmed: 90,
  unconfirmed_booking: 70,
  overdue_follow_up: 50,
  stale_conversation: 30,
  warm_lead: 10,
};

function computeUrgencyScore(item: DetectedItem): number {
  const base = BASE_SCORES[item.type];

  switch (item.type) {
    case 'same_day_unconfirmed':
      // Closer appointment = higher urgency. Max +9 for within 1 hour.
      const hoursUntil = item.hoursUntilAppointment;
      return base + Math.min(9, Math.floor(10 / Math.max(hoursUntil, 0.5)));

    case 'unconfirmed_booking':
      // Closer appointment = higher urgency. Max +19.
      return base + Math.min(19, Math.floor(48 / Math.max(item.hoursUntilAppointment, 1)));

    case 'overdue_follow_up':
      // More days overdue = higher urgency. Max +19. Promises get +5 bonus.
      const overdueDays = Math.min(item.daysPastDue, 14);
      const promiseBonus = item.followUpType === 'promise' ? 5 : 0;
      return base + Math.min(19, overdueDays + promiseBonus);

    case 'stale_conversation':
      // More days stale + active booking context = higher urgency. Max +19.
      const staleDays = Math.min(item.daysSinceContact, 14);
      const bookingBonus = item.conversationState === 'booking_in_progress' ? 5 : 0;
      return base + Math.min(19, staleDays + bookingBonus);

    case 'warm_lead':
      // Moderate staleness = highest urgency (sweet spot: 3-7 days). Max +19.
      const daysInactive = item.daysSinceContact;
      const warmth = daysInactive <= 7 ? 19 - daysInactive : Math.max(0, 14 - daysInactive);
      return base + warmth;

    default:
      return base;
  }
}
```

### 4.2 Reason string templates

Since there is no LLM-generated reason text, reasons are template-generated:

```typescript
function generateReason(item: DetectedItem): string {
  switch (item.type) {
    case 'same_day_unconfirmed':
      return `Appointment today at ${formatTime(item.startTime)} -- confirmation pending`;

    case 'unconfirmed_booking':
      return `${item.appointmentType} on ${formatDate(item.startTime)} -- confirmation ${item.confirmationStatus}`;

    case 'overdue_follow_up':
      const typeLabel = item.followUpType === 'promise' ? 'Promise' : 'Follow-up';
      return `${typeLabel} ${item.daysPastDue} day${item.daysPastDue > 1 ? 's' : ''} overdue: "${truncate(item.followUpContent, 60)}"`;

    case 'stale_conversation':
      const stateLabel = item.conversationState === 'booking_in_progress'
        ? 'booking started' : 'conversation stale';
      return `${item.daysSinceContact} day${item.daysSinceContact > 1 ? 's' : ''} since contact -- ${stateLabel}`;

    case 'warm_lead':
      const interest = item.latestOpenFollowup
        ? `"${truncate(item.latestOpenFollowup, 50)}"` : 'showed interest';
      return `${interest} ${item.daysSinceContact} days ago -- no booking`;
  }
}
```

---

## 5. Today's View API -- `GET /api/today`

### 5.1 Route handler -- `src/app/api/today/route.ts`

```typescript
import { createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = createServerClient();

  // Authenticate and get workspace_id
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: staff } = await supabase
    .from('staff')
    .select('workspace_id')
    .eq('id', user.id)
    .single();

  if (!staff) return NextResponse.json({ error: 'No workspace' }, { status: 403 });

  const workspaceId = staff.workspace_id;

  // Fetch workspace timezone
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('timezone')
    .eq('id', workspaceId)
    .single();

  const tz = workspace?.timezone ?? 'UTC';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

  // Run queries in parallel
  const [bookingsResult, actionItemsResult, latestRunResult] = await Promise.all([
    fetchTodayBookings(supabase, workspaceId, tz),
    fetchLatestActionItems(supabase, workspaceId, today),
    fetchLatestCosRun(supabase, workspaceId, today),
  ]);

  return NextResponse.json({
    date: today,
    timezone: tz,
    cosRun: latestRunResult,
    bookings: bookingsResult,
    actionItems: actionItemsResult,
  });
}
```

### 5.2 Response schema

```typescript
type TodayViewResponse = {
  date: string;                    // ISO date, workspace local (e.g., "2026-03-18")
  timezone: string;                // IANA timezone
  cosRun: {
    id: string;
    status: 'running' | 'completed' | 'failed';
    completedAt: string | null;
    trigger: 'daily_cron' | 'on_demand';
    actionsFound: number;
    draftsQueued: number;
  } | null;                        // null if COS has not run today
  bookings: Array<{
    id: string;
    clientId: string;
    clientName: string;
    appointmentType: string;
    startTime: string;             // ISO timestamp
    endTime: string;
    status: string;
    confirmationStatus: string;
    isAtRisk: boolean;
  }>;
  actionItems: Array<{
    id: string;
    clientId: string;
    clientName: string;
    itemType: ActionItemType;
    urgencyScore: number;
    rank: number;
    reason: string;
    referenceId: string | null;
    referenceType: string | null;
    draftStatus: 'pending' | 'queued' | 'generated' | 'failed' | 'skipped';
    draftId: string | null;
    conversationId: string | null; // for linking to client thread
  }>;
};
```

### 5.3 Query helpers

```typescript
async function fetchTodayBookings(
  supabase: SupabaseClient,
  workspaceId: string,
  timezone: string
): Promise<TodayViewResponse['bookings']> {
  // Get start/end of today in workspace timezone, converted to UTC
  const { data } = await supabase.rpc('get_todays_bookings', {
    p_workspace_id: workspaceId,
    p_timezone: timezone,
  });
  return data ?? [];
}

async function fetchLatestActionItems(
  supabase: SupabaseClient,
  workspaceId: string,
  today: string
): Promise<TodayViewResponse['actionItems']> {
  const { data } = await supabase
    .from('cos_action_items')
    .select(`
      id, client_id, item_type, urgency_score, rank, reason,
      reference_id, reference_type, draft_status, draft_id,
      clients!inner(full_name),
      cos_runs!inner(run_date, status)
    `)
    .eq('workspace_id', workspaceId)
    .eq('cos_runs.run_date', today)
    .order('rank', { ascending: true })
    .limit(50);

  return (data ?? []).map(row => ({
    id: row.id,
    clientId: row.client_id,
    clientName: row.clients.full_name,
    itemType: row.item_type,
    urgencyScore: row.urgency_score,
    rank: row.rank,
    reason: row.reason,
    referenceId: row.reference_id,
    referenceType: row.reference_type,
    draftStatus: row.draft_status,
    draftId: row.draft_id,
    conversationId: null, // resolved client-side via client_id
  }));
}
```

### 5.4 Postgres RPC for today's bookings

```sql
CREATE OR REPLACE FUNCTION get_todays_bookings(
  p_workspace_id UUID,
  p_timezone TEXT
) RETURNS TABLE (
  id UUID,
  client_id UUID,
  client_name TEXT,
  appointment_type TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  status TEXT,
  confirmation_status TEXT,
  is_at_risk BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    b.id,
    b.client_id,
    c.full_name AS client_name,
    b.appointment_type,
    b.start_time,
    b.end_time,
    b.status,
    b.confirmation_status,
    (b.status = 'at_risk' OR (
      b.confirmation_status IN ('pending', 'unconfirmed')
      AND b.status NOT IN ('cancelled', 'completed', 'no_show')
    )) AS is_at_risk
  FROM bookings b
  JOIN clients c ON c.id = b.client_id
  WHERE b.workspace_id = p_workspace_id
    AND b.start_time::date = (now() AT TIME ZONE p_timezone)::date
    AND b.status NOT IN ('cancelled', 'no_show')
    AND c.deleted_at IS NULL
  ORDER BY b.start_time ASC;
END;
$$ LANGUAGE plpgsql STABLE;
```

---

## 6. Follow-up Draft Dispatch via pgmq

### 6.1 Queue message payload

When the COS identifies clients needing follow-up, it enqueues messages to the `followup_drafts` pgmq queue. The `process-message` Edge Function dequeues and processes these using the standard Client Worker pipeline.

```typescript
type FollowUpDraftPayload = {
  workspace_id: string;
  client_id: string;
  cos_run_id: string;
  draft_type: 'follow_up' | 're_engagement' | 'lead_nurture' | 'confirmation';
  action_reasons: string[];       // one or more reason strings (batched per client)
  action_item_ids: string[];      // FK to cos_action_items for status tracking
  reference_ids: Array<{          // so Client Worker knows what to reference
    type: 'follow_up' | 'booking';
    id: string;
  }>;
};
```

### 6.2 Dispatch logic -- `dispatch.ts`

```typescript
async function dispatchFollowUpDrafts(
  supabase: SupabaseClient,
  cosRunId: string,
  workspaceId: string,
  actionItems: CosActionItem[]
): Promise<number> {
  // Group action items by client_id -- one pgmq message per client
  const byClient = new Map<string, CosActionItem[]>();
  for (const item of actionItems) {
    const existing = byClient.get(item.client_id) ?? [];
    existing.push(item);
    byClient.set(item.client_id, existing);
  }

  let queued = 0;

  for (const [clientId, items] of byClient) {
    // Check deduplication: skip if a draft was already queued/generated for
    // this client today (from an earlier COS run)
    const { data: existing } = await supabase
      .from('cos_action_items')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('client_id', clientId)
      .eq('draft_status', 'generated')
      .gte('created_at', todayStartUtc(workspaceId))
      .limit(1);

    if (existing && existing.length > 0) {
      // Mark these items as skipped
      for (const item of items) {
        await supabase
          .from('cos_action_items')
          .update({ draft_status: 'skipped' })
          .eq('id', item.id);
      }
      continue;
    }

    // Determine primary draft type (highest urgency item drives the type)
    const primaryItem = items.sort((a, b) => b.urgency_score - a.urgency_score)[0];
    const draftType = mapItemTypeToDraftType(primaryItem.item_type);

    const payload: FollowUpDraftPayload = {
      workspace_id: workspaceId,
      client_id: clientId,
      cos_run_id: cosRunId,
      draft_type: draftType,
      action_reasons: items.map(i => i.reason),
      action_item_ids: items.map(i => i.id),
      reference_ids: items
        .filter(i => i.reference_id)
        .map(i => ({ type: i.reference_type as 'follow_up' | 'booking', id: i.reference_id! })),
    };

    // Enqueue to pgmq
    await supabase.rpc('pgmq_send', {
      queue_name: 'followup_drafts',
      message: payload,
    });

    // Update action items to 'queued'
    for (const item of items) {
      await supabase
        .from('cos_action_items')
        .update({ draft_status: 'queued' })
        .eq('id', item.id);
    }

    queued++;
  }

  return queued;
}

function mapItemTypeToDraftType(
  itemType: ActionItemType
): FollowUpDraftPayload['draft_type'] {
  switch (itemType) {
    case 'same_day_unconfirmed':
    case 'unconfirmed_booking':
      return 'confirmation';
    case 'overdue_follow_up':
      return 'follow_up';
    case 'stale_conversation':
      return 're_engagement';
    case 'warm_lead':
      return 'lead_nurture';
  }
}
```

### 6.3 `process-message` Edge Function -- follow-up draft handling

The existing `process-message` Edge Function is extended to dequeue from `followup_drafts` in addition to `inbound_messages`. When processing a follow-up draft request:

1. **Dequeue** from `followup_drafts` (visibility timeout = 120s, higher than inbound because LLM call is guaranteed).
2. **Context assembly** runs normally via `assembleContext(workspaceId, clientId)` -- loads compact summary, recent messages, active follow-ups, bookings.
3. **System prompt injection:** The `draft_type` and `action_reasons` are injected into the system prompt as an additional instruction block:

```typescript
function buildFollowUpSystemPromptAddition(payload: FollowUpDraftPayload): string {
  const typeInstructions: Record<string, string> = {
    follow_up: 'Generate a follow-up message addressing the overdue item(s). Be specific about what was promised or pending.',
    re_engagement: 'Generate a re-engagement message. The conversation has gone quiet. Be warm and check in without being pushy.',
    lead_nurture: 'Generate a gentle lead-nurturing message. The client showed interest but hasn\'t booked. Suggest a low-commitment next step.',
    confirmation: 'Generate an appointment confirmation reminder. Mention the appointment date, time, and type. Ask the client to confirm.',
  };

  return `
--- PROACTIVE FOLLOW-UP ---
This is a proactive follow-up, not a response to an inbound message.
Draft type: ${payload.draft_type}
Reason(s):
${payload.action_reasons.map(r => `- ${r}`).join('\n')}

${typeInstructions[payload.draft_type]}
Do NOT fabricate details not present in the client context.
---`;
}
```

4. **LLM call** generates the draft. The `inboundMessage` field in context is set to a synthetic marker: `{ content: '[PROACTIVE_FOLLOW_UP]', mediaType: null, mediaTranscription: null, timestamp: now() }`.
5. **Save draft** to `drafts` table. Update the corresponding `cos_action_items.draft_status` to `'generated'` and set `cos_action_items.draft_id`.
6. **Archive** the pgmq message.
7. **Log LLM usage** to `llm_usage` with `edge_function_name: 'process-message'`.

### 6.4 Retry and DLQ

Same pattern as `inbound_messages` (Architecture Section 8.1):

- Visibility timeout: 120 seconds (longer for follow-up drafts to accommodate LLM latency).
- Max retries: 3 (`read_ct > 3` triggers move to `followup_drafts_dlq`).
- On DLQ: update `cos_action_items.draft_status` to `'failed'`.

---

## 7. pg_cron Job Configuration

### 7.1 Dispatcher extension

F-11 already defines the `daily-cron-dispatcher` pg_cron job that fires hourly and invokes the `daily-cron` Edge Function for workspaces at their configured hour. F-12 extends this:

The dispatcher fires at the **COS operations hour** (default 07:00 local, one hour after compaction at 06:00). Rather than creating a separate pg_cron job, the existing hourly dispatcher handles both:

```sql
-- Extended dispatcher: handles both compaction (hour=3) and COS operations (hour=7)
-- Replace the F-11 dispatcher with this combined version.
SELECT cron.schedule(
  'daily-cron-dispatcher',
  '0 * * * *',    -- every hour at minute 0
  $$
  -- Compaction phase (03:00 local)
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

  -- COS operations phase (07:00 local)
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/daily-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('workspace_id', w.id, 'phase', 'cos_operations')
  )
  FROM workspaces w
  WHERE w.onboarding_status = 'complete'
    AND EXTRACT(HOUR FROM now() AT TIME ZONE w.timezone) = 7
    AND NOT EXISTS (
      SELECT 1 FROM cos_runs cr
      WHERE cr.workspace_id = w.id
        AND cr.run_date = (now() AT TIME ZONE w.timezone)::date
        AND cr.trigger = 'daily_cron'
    );
  $$
);
```

### 7.2 Follow-up draft processing poll

A safety-net pg_cron job polls the `followup_drafts` queue every minute (same pattern as `process-pending-messages` in Architecture Section 8.3):

```sql
SELECT cron.schedule(
  'process-pending-followup-drafts',
  '* * * * *',  -- every minute
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/process-message',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('queue', 'followup_drafts')
  )
  WHERE EXISTS (
    SELECT 1 FROM pgmq.read('followup_drafts', 0, 1)
  );
  $$
);
```

### 7.3 DST handling

Same as F-11 (Section 3.2 of the F-11 spec): `AT TIME ZONE` handles DST. The `NOT EXISTS` guard on `cos_runs` prevents duplicate runs during fall-back.

### 7.4 Stale run cleanup

On each COS dispatch, clean up orphaned `running` records from previous days (crashed runs):

```sql
-- Run at COS operations phase start, before creating new cos_run record
UPDATE cos_runs
SET status = 'failed',
    error_message = 'Stale: did not complete within expected window',
    completed_at = now()
WHERE workspace_id = $1
  AND status = 'running'
  AND run_date < (now() AT TIME ZONE $2)::date;
```

---

## 8. COS Operations Orchestrator -- `cos-operations.ts`

### 8.1 Main flow

```typescript
async function runCosOperations(
  supabase: SupabaseClient,
  workspaceId: string,
  trigger: 'daily_cron' | 'on_demand',
  triggeredBy?: string
): Promise<CosRunResult> {
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('timezone, vertical_config')
    .eq('id', workspaceId)
    .single();

  const tz = workspace!.timezone;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const config = extractCosConfig(workspace!.vertical_config);

  // Step 1: Create COS run record
  const { data: cosRun } = await supabase
    .from('cos_runs')
    .insert({
      workspace_id: workspaceId,
      run_date: today,
      trigger,
      triggered_by: triggeredBy ?? null,
    })
    .select('id')
    .single();

  const cosRunId = cosRun!.id;

  try {
    // Step 2: Clean up stale runs
    await cleanupStaleRuns(supabase, workspaceId, tz);

    // Step 3: Run all detection queries in parallel
    const [staleConvs, overdueFollowUps, unconfirmedBookings, warmLeads] =
      await Promise.all([
        detectStaleConversations(supabase, workspaceId, config.stalenessThresholdHours),
        detectOverdueFollowUps(supabase, workspaceId),
        detectUnconfirmedBookings(supabase, workspaceId, config.confirmationWindowHours, tz),
        detectWarmLeads(supabase, workspaceId, config.warmLeadWindowDays),
      ]);

    // Step 4: Transition statuses (follow-ups -> overdue, bookings -> at_risk)
    await transitionOverdueFollowUps(supabase, workspaceId);
    await flagAtRiskBookings(supabase, workspaceId, config.confirmationWindowHours);

    // Step 5: Compute urgency scores and sort
    const allItems = [
      ...mapUnconfirmedToItems(unconfirmedBookings),
      ...mapOverdueToItems(overdueFollowUps),
      ...mapStaleToItems(staleConvs),
      ...mapWarmLeadsToItems(warmLeads),
    ];

    const scored = allItems.map(item => ({
      ...item,
      urgency_score: computeUrgencyScore(item),
      reason: generateReason(item),
    }));

    scored.sort((a, b) => b.urgency_score - a.urgency_score);

    // Assign rank
    const ranked = scored.map((item, idx) => ({ ...item, rank: idx + 1 }));

    // Step 6: Write action items
    if (ranked.length > 0) {
      await supabase.from('cos_action_items').insert(
        ranked.map(item => ({
          cos_run_id: cosRunId,
          workspace_id: workspaceId,
          client_id: item.client_id,
          item_type: item.type,
          urgency_score: item.urgency_score,
          rank: item.rank,
          reason: item.reason,
          reference_id: item.reference_id ?? null,
          reference_type: item.reference_type ?? null,
          draft_status: 'pending',
        }))
      );
    }

    // Step 7: Dispatch follow-up drafts to pgmq
    const draftsQueued = await dispatchFollowUpDrafts(
      supabase, cosRunId, workspaceId, ranked
    );

    // Step 8: Complete the run
    await supabase
      .from('cos_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        actions_found: ranked.length,
        drafts_queued: draftsQueued,
      })
      .eq('id', cosRunId);

    // Step 9: Log audit event
    await supabase.from('audit_events').insert({
      workspace_id: workspaceId,
      actor_type: 'system',
      action_type: 'cos_run_completed',
      target_type: 'workspace',
      target_id: workspaceId,
      metadata: {
        cos_run_id: cosRunId,
        trigger,
        actions_found: ranked.length,
        drafts_queued: draftsQueued,
        breakdown: {
          unconfirmed_bookings: unconfirmedBookings.length,
          overdue_follow_ups: overdueFollowUps.length,
          stale_conversations: staleConvs.length,
          warm_leads: warmLeads.length,
        },
      },
    });

    return { status: 'completed', actionsFound: ranked.length, draftsQueued };

  } catch (error) {
    await supabase
      .from('cos_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : String(error),
      })
      .eq('id', cosRunId);

    throw error;
  }
}
```

### 8.2 COS configuration defaults

Extracted from `workspace.vertical_config` with fallbacks:

```typescript
type CosConfig = {
  stalenessThresholdHours: number;    // default: 24
  confirmationWindowHours: number;    // default: 48
  warmLeadWindowDays: number;         // default: 14
  cosRunHour: number;                 // default: 7 (07:00 local)
};

function extractCosConfig(verticalConfig: Record<string, unknown> | null): CosConfig {
  const cos = (verticalConfig as any)?.cos ?? {};
  return {
    stalenessThresholdHours: cos.staleness_threshold_hours ?? 24,
    confirmationWindowHours: cos.confirmation_window_hours ?? 48,
    warmLeadWindowDays: cos.warm_lead_window_days ?? 14,
    cosRunHour: cos.run_hour ?? 7,
  };
}
```

---

## 9. On-Demand Refresh -- `POST /api/today/refresh`

### 9.1 Route handler

```typescript
export async function POST(request: Request) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: staff } = await supabase
    .from('staff')
    .select('workspace_id')
    .eq('id', user.id)
    .single();

  const workspaceId = staff!.workspace_id;

  // Rate limit: 1 refresh per 5 minutes per workspace
  const { data: recentRun } = await supabase
    .from('cos_runs')
    .select('id, completed_at')
    .eq('workspace_id', workspaceId)
    .eq('trigger', 'on_demand')
    .gte('started_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .order('started_at', { ascending: false })
    .limit(1);

  if (recentRun && recentRun.length > 0) {
    return NextResponse.json({
      error: 'Rate limited',
      message: 'On-demand refresh available every 5 minutes',
      lastRefresh: recentRun[0].completed_at,
    }, { status: 429 });
  }

  // Invoke COS operations on-demand
  // This calls the daily-cron Edge Function with phase=cos_operations
  const { data, error } = await supabase.functions.invoke('daily-cron', {
    body: {
      workspace_id: workspaceId,
      phase: 'cos_operations',
      trigger: 'on_demand',
      triggered_by: user.id,
    },
  });

  if (error) {
    return NextResponse.json({ error: 'Refresh failed' }, { status: 500 });
  }

  // Return fresh Today's View data (same as GET /api/today)
  // ... (reuses the same query logic from GET handler)
}
```

---

## 10. Edge Cases

### 10.1 Large workspaces (> 500 clients)

- **Detection queries** are scoped by index-backed `WHERE` clauses (`workspace_id`, status fields, date ranges). Query performance is O(active items), not O(total clients). A workspace with 500 clients but only 20 needing action runs 4 queries returning ~20 rows total.
- **Action item cap:** The COS caps action items at 100 per run. If more are detected, only the top 100 by urgency score are persisted and dispatched. Remaining items are logged but not displayed. Rationale: a single staff member cannot act on more than 100 items in a day.
- **Follow-up draft staggering:** When dispatching > 10 follow-up draft requests to pgmq, messages are enqueued with staggered `delay` values (2 seconds apart) to prevent `process-message` from hitting LLM rate limits.

```typescript
// Staggered enqueue for large batches
const STAGGER_DELAY_MS = 2000;

for (let i = 0; i < messages.length; i++) {
  await supabase.rpc('pgmq_send_with_delay', {
    queue_name: 'followup_drafts',
    message: messages[i],
    delay_seconds: Math.floor((i * STAGGER_DELAY_MS) / 1000),
  });
}
```

### 10.2 Draft queue backlog

If the `followup_drafts` queue accumulates unprocessed messages (LLM outage, Edge Function failures):

- **Monitoring:** The queue depth is checked by the COS orchestrator before dispatching new drafts. If `pgmq.metrics('followup_drafts').queue_length > 50`, log a warning and skip draft dispatch for this run. Action items are still written with `draft_status = 'pending'` so they appear in the Today's View.
- **DLQ processing:** Messages that fail 3 times move to `followup_drafts_dlq`. The corresponding `cos_action_items.draft_status` is updated to `'failed'`. Staff sees "Draft failed" in the Today's View and can compose the message manually by clicking through to the client thread.
- **Backlog drain:** When the LLM comes back online, the `process-pending-followup-drafts` pg_cron job (every minute) drains the queue normally. Stale drafts (> 24 hours old in the queue) are discarded -- the next day's COS run will re-evaluate and dispatch fresh requests.

### 10.3 Today's View before COS run

If staff opens the Today's View before the daily COS run (e.g., at 06:00 when the COS runs at 07:00):

- Today's bookings are always displayed (direct query, no dependency on COS).
- The action items section shows: "Daily analysis will run at 7:00 AM. Showing yesterday's items."
- If yesterday's `cos_runs` record exists, yesterday's action items that are still unresolved (follow-up not completed, conversation still stale) are displayed with a "Yesterday" badge.

### 10.4 Multiple COS runs in one day

- **Daily cron + on-demand:** Both are allowed. The daily cron has a unique constraint preventing duplicates. On-demand runs create separate `cos_runs` records.
- **Action item visibility:** The Today's View always shows action items from the **most recent** completed COS run for today.
- **Draft deduplication:** The `dispatchFollowUpDrafts` function checks for existing queued/generated drafts before enqueuing. If the daily run already dispatched a draft for a client, an on-demand refresh will not queue another.

### 10.5 Client has multiple action types

A single client may appear in multiple detection queries (e.g., has an overdue follow-up AND a stale conversation AND a warm lead). The dispatch logic batches all items for the same client into a single pgmq message, so only one Client Worker invocation generates one cohesive draft covering all items.

### 10.6 Edge Function timeout during COS operations

The `daily-cron` Edge Function has a 150-second timeout (Supabase Pro). COS operations consist of SQL queries (fast) + pgmq enqueue (fast). No LLM call. Even for a workspace with 100 action items, the COS operations phase should complete in under 10 seconds.

If timeout occurs anyway:
- Action items already written are durable (committed transactions).
- Drafts already enqueued to pgmq are durable.
- The `cos_runs` record will be stuck in `'running'`. Cleaned up by the stale run cleanup on the next dispatch.

### 10.7 Empty workspace

If a workspace has no active clients, no follow-ups, no bookings:
- All detection queries return empty.
- The COS run completes with `actions_found = 0, drafts_queued = 0`.
- Today's View shows the empty state: "All caught up."

---

## 11. Acceptance Criteria to Tasks

### Task 1: Database migrations (US-F12-01, US-F12-08)
- [ ] Create `cos_runs` table with unique constraint on `(workspace_id, run_date)` for daily_cron
- [ ] Create `cos_action_items` table with indexes for run, workspace, and deduplication
- [ ] Create pgmq queues: `followup_drafts` and `followup_drafts_dlq`
- [ ] Create `get_todays_bookings` Postgres RPC function
- [ ] Add RLS policies for `cos_runs` and `cos_action_items` (workspace isolation)

### Task 2: pg_cron dispatcher update (US-F12-01)
- [ ] Extend `daily-cron-dispatcher` to handle COS operations phase at hour 7 (local)
- [ ] Add idempotency guard (`NOT EXISTS` on `cos_runs` for daily_cron)
- [ ] Add `process-pending-followup-drafts` pg_cron job (1-minute poll of `followup_drafts` queue)
- [ ] Verify DST handling with `AT TIME ZONE`
- [ ] Verify timezone change takes effect on next cycle

### Task 3: Detection queries (US-F12-02, US-F12-03, US-F12-05, US-F12-09)
- [ ] Implement `detectStaleConversations` -- conversations in `awaiting_client_reply`, `booking_in_progress`, or `follow_up_pending` exceeding threshold
- [ ] Implement `detectOverdueFollowUps` -- follow-ups with `due_date < CURRENT_DATE` and status `open`/`pending`/`overdue`
- [ ] Implement `detectUnconfirmedBookings` -- bookings within confirmation window with `pending`/`unconfirmed` confirmation status
- [ ] Implement `detectWarmLeads` -- lifecycle `open`/`chosen_service`, no future bookings, past staleness threshold, within interest decay window
- [ ] Implement status transitions: follow-ups `open`/`pending` -> `overdue`, bookings `confirmed` -> `at_risk`
- [ ] Audit event for each follow-up status transition

### Task 4: Urgency scoring and sorting (US-F12-04)
- [ ] Implement `computeUrgencyScore` with base scores per type and modifiers
- [ ] Implement `generateReason` with template-based reason strings
- [ ] Sort by urgency_score DESC, assign rank
- [ ] Cap at 100 action items per run

### Task 5: COS orchestrator -- `cos-operations.ts` (US-F12-01)
- [ ] Create `cos_runs` record at start, update at end with counts
- [ ] Run all 4 detection queries in parallel
- [ ] Run status transitions
- [ ] Compute scores, sort, write `cos_action_items`
- [ ] Dispatch follow-up drafts
- [ ] Stale run cleanup for orphaned `running` records
- [ ] Error handling: per-phase try/catch, COS run marked `failed` on error
- [ ] Audit event on completion

### Task 6: Follow-up draft dispatch via pgmq (US-F12-06, US-F12-07)
- [ ] Group action items by client_id (one pgmq message per client)
- [ ] Deduplication check: skip if draft already queued/generated for client today
- [ ] Map item types to draft types: `confirmation`, `follow_up`, `re_engagement`, `lead_nurture`
- [ ] Enqueue to `followup_drafts` queue with staggered delay for batches > 10
- [ ] Update `cos_action_items.draft_status` to `queued` after enqueue
- [ ] Queue backlog check: skip dispatch if queue depth > 50

### Task 7: `process-message` extension for follow-up drafts (US-F12-06, US-F12-07)
- [ ] Extend `process-message` to dequeue from `followup_drafts` queue (in addition to `inbound_messages`)
- [ ] Build follow-up system prompt addition from `FollowUpDraftPayload`
- [ ] Set synthetic inbound message marker `[PROACTIVE_FOLLOW_UP]`
- [ ] Context assembly runs normally (compact summary, recent messages, follow-ups, bookings)
- [ ] After draft generation: update `cos_action_items.draft_status` to `generated` and set `draft_id`
- [ ] On failure after 3 retries: move to DLQ, update `cos_action_items.draft_status` to `failed`
- [ ] Log LLM usage to `llm_usage` table

### Task 8: Today's View API -- `GET /api/today` (US-F12-08)
- [ ] Authenticate staff, resolve workspace_id
- [ ] Fetch workspace timezone
- [ ] Query today's bookings via `get_todays_bookings` RPC
- [ ] Query latest COS run and action items for today
- [ ] Return structured JSON matching `TodayViewResponse` schema
- [ ] Handle pre-COS state: return bookings with null cosRun
- [ ] Latency target: < 2 seconds

### Task 9: On-demand refresh -- `POST /api/today/refresh` (US-F12-10)
- [ ] Rate limit: 1 per 5 minutes per workspace (check recent `on_demand` cos_runs)
- [ ] Invoke `daily-cron` Edge Function with `phase=cos_operations, trigger=on_demand`
- [ ] Return 429 with cached results if rate limited
- [ ] On-demand runs do not re-dispatch drafts for already-handled clients

### Task 10: Today's View UI components (US-F12-08)
- [ ] `TodayBookings` component: chronological list, confirmation status badges, at-risk highlight
- [ ] `ActionList` component: ranked items grouped by type, urgency indicators
- [ ] `ActionItem` component: client name, type badge, reason text, days counter, draft status, link to thread
- [ ] `EmptyState` component: "All caught up" with next booking preview
- [ ] Pre-COS state: "Daily analysis will run at X:XX AM" message
- [ ] Realtime subscription: update draft status when `cos_action_items.draft_status` changes
- [ ] Realtime subscription: remove action items when follow-ups are completed or bookings confirmed

### Task 11: Integration tests
- [ ] COS runs at correct timezone-local hour (07:00)
- [ ] Compaction (F-11) runs before COS operations
- [ ] Stale conversations: correct threshold, excludes idle/active conversations
- [ ] Overdue follow-ups: status transition, promises included, completed excluded
- [ ] Unconfirmed bookings: within window, same-day urgency, cancelled excluded
- [ ] Warm leads: lifecycle filter, no-booking filter, interest decay window, recently active excluded
- [ ] Urgency scoring: same-day unconfirmed > overdue follow-up > stale conversation > warm lead
- [ ] Follow-up draft dispatch: one pgmq message per client (batched), deduplication works
- [ ] `process-message` processes `followup_drafts` queue and generates drafts
- [ ] Today's View API returns correct structure, handles pre-COS and post-COS states
- [ ] On-demand refresh respects rate limit
- [ ] Idempotency: same-day daily_cron rerun is skipped
- [ ] Empty workspace produces clean empty state
