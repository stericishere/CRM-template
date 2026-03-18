# Feature Spec — F-04: Staff Notifications & Audit Foundation

**Feature:** F-04
**Phase:** 1 (Core Messaging & Onboarding)
**Size:** M (3–5 days)
**PRD Functions:** NT-01, NT-02, AG-06
**User Stories:** US-F04-01 through US-F04-05
**Architecture modules:** `agent-governance` (AuditEvent), Supabase Realtime (notifications)
**Last updated:** March 2026

---

## Architecture alignment note

The final locked architecture (`docs/phase-3-architecture/architecture-final.md`, ADR decision table §20) explicitly defers Web Push / VAPID notifications to **post-MVP**:

> "Web Push notifications — Supabase Realtime sufficient for MVP (staff app must be open). When staff requests background notifications."

This spec implements **Phase 1** scope: Supabase Realtime-driven in-app notifications and unread badges. The service worker / VAPID / OS push path is documented in §8 (Post-MVP Extension) for forward planning but is **not implemented in this feature**.

User stories US-F04-01 and US-F04-02 describe push notification behaviour that extends beyond Phase 1 scope. The scenarios that require the app to be closed or backgrounded (OS-level push) are deferred. All other AC in those stories (in-app toast, badge update, latency of notification to a staff member with the app open) are covered by the Realtime path.

---

## 1. Overview

F-04 delivers two foundational capabilities that every later feature depends on:

1. **Real-time staff alerting** — within 5 seconds of an inbound WhatsApp message arriving, a staff member with the app open receives an in-app toast notification and the unread badge increments. This is driven by Supabase Realtime (Postgres Changes) without any additional infrastructure.
2. **Audit event foundation** — every state-changing mutation in the system writes an immutable `audit_events` record (INSERT-only RLS, no UPDATE or DELETE policy). This is the governance baseline consumed by F-06 (Approval Workflow) and all future compliance and debugging tooling.

The dual-notification pattern from the final architecture means staff sees two Realtime events per inbound message:
- **Event 1 (~1s):** New message stored → Realtime `INSERT` on `messages` table → in-app toast + badge increment.
- **Event 2 (~5–15s):** Draft ready → Realtime `INSERT` on `drafts` table → "Draft ready" indicator on conversation.

---

## 2. Component Breakdown

### 2.1 `AuditEvent` entity (`lib/audit/AuditEvent.ts`)

Immutable value object. Constructed by application use cases; never mutated after creation. Validates `action_type` against the defined enum at construction time. Serializes to the `audit_events` table schema from the final architecture.

Note: The final architecture uses `id` (not `event_id`) and `target_type` (not `target_entity`) and `created_at` (not `timestamp`). These field names match `architecture-final.md §9` exactly.

### 2.2 `AuditService` (`lib/audit/AuditService.ts`)

Single service responsible for the fire-and-log pattern:

- `logEvent(event: AuditEvent): Promise<void>` — executes `INSERT INTO audit_events` using the Supabase service-role client (bypasses RLS; only the server writes audit events).
- All call sites wrap this with a **non-blocking try/catch**: audit failures never propagate to the primary mutation path.
- On write failure: serializes the full event payload to the structured error logger. Enqueues a retry message to the `audit_retry` pgmq queue (3 attempts, exponential backoff). After 3 failures, moves to `audit_dlq`.

### 2.3 `SupabaseAuditRepository` (called directly from `AuditService` via Supabase client)

No separate repository class is needed in the flat module structure of the final architecture. `AuditService` uses the Supabase service-role client directly:

```typescript
const { error } = await supabase
  .from('audit_events')
  .insert(event.toRow());
```

For manager queries, the staff-facing Supabase client (with RLS) can SELECT from `audit_events` scoped to their workspace via the `staff_read_own_workspace` RLS policy.

### 2.4 Supabase Realtime notification channel

No server-side notification service is needed for Phase 1. Notifications are driven by Supabase Realtime Postgres Changes:

- The `messages` table has `workspace_id` denormalized (required for Realtime filter column — cannot JOIN).
- The `drafts` table has `workspace_id` denormalized.
- Staff app subscribes to both channels on inbox mount.
- The staff app processes Realtime events to drive in-app toasts, badge counts, and conversation list ordering.

### 2.5 `useInboxRealtime` hook (`app/hooks/useInboxRealtime.ts`)

React hook that owns the Realtime subscription lifecycle:

- Subscribes to `INSERT` events on `messages` filtered by `workspace_id = eq.{workspaceId}`.
- Subscribes to `INSERT` events on `drafts` filtered by `workspace_id = eq.{workspaceId}`.
- On new message event: calls `onNewMessage(payload)` → increments badge, moves conversation to top, shows toast.
- On new draft event: calls `onDraftReady(payload)` → shows "Draft ready" indicator.
- Reconnection: Supabase Realtime client handles reconnection automatically; hook surfaces `status` (`SUBSCRIBED | CONNECTING | DISCONNECTED`) for UI fallback.
- Polling fallback: if `status === 'DISCONNECTED'` for > 10 seconds, falls back to `GET /api/notifications/unread-count` every 15 seconds and logs the failure.

### 2.6 `useUnreadCount` hook (`app/hooks/useUnreadCount.ts`)

Manages server-authoritative unread counts:

- Fetches from `GET /api/notifications/unread-count` on mount (authoritative, not from local cache).
- Updates local state from Realtime events (`INSERT` on `messages` where `direction = 'inbound'`).
- Resets to 0 for a conversation when `PATCH /api/conversations/:id/read` is called.
- Updates browser tab title: `(N) Inbox` when `N > 0`; plain `Inbox` when zero.

### 2.7 In-app toast component (`app/components/NotificationToast.tsx`)

Simple UI component rendered at the root layout level. Receives new-message events from `useInboxRealtime`. Shows the client display name / phone and message preview (first 100 characters, or "New media message" if no text). Tapping the toast navigates to the conversation thread. Auto-dismisses after 5 seconds. Suppresses duplicate toasts for the same conversation within 10 seconds.

---

## 3. Data Model

### 3.1 `audit_events` table

Taken verbatim from `architecture-final.md §9` (schema section). Reproduced here for implementation reference:

```sql
CREATE TABLE audit_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL,
  actor_type    TEXT        NOT NULL,   -- 'ai', 'staff', 'system'
  actor_id      UUID,                   -- NULL for system actors
  action_type   TEXT        NOT NULL,
  target_type   TEXT        NOT NULL,   -- 'message', 'client', 'booking', etc.
  target_id     UUID,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_workspace
  ON audit_events (workspace_id, created_at DESC);
```

**Row Level Security (INSERT-only immutability via policy omission):**

```sql
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- Staff may SELECT within their workspace only
CREATE POLICY "staff_read_own_workspace" ON audit_events
  FOR SELECT USING (workspace_id = auth.workspace_id());

-- No INSERT, UPDATE, or DELETE policies for authenticated role.
-- Only service role (Edge Functions) writes audit events.
-- Any application-layer attempt to UPDATE or DELETE returns permission denied.
```

`auth.workspace_id()` is a PostgreSQL function that extracts `workspace_id` from the JWT claim (defined in the final architecture's auth setup). No cross-tenant leakage is possible through the RLS SELECT policy.

**`metadata` JSONB shape (convention, not enforced at DB layer):**

```typescript
type AuditMetadata = {
  session_key?: string;           // 'workspace:{id}:client:{id}'
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  draft_content_hash?: string;    // for draft_generated events
  [key: string]: unknown;         // extensible per action_type
};
```

**`action_type` values** (enforced at application layer in `AuditEvent.ts`):

```typescript
export const AUDIT_ACTION_TYPES = [
  // Proposed addition for US-F04-05 — requires PM alignment before sprint (see OQ-1)
  'message_received',
  // From PRD §12.13
  'draft_generated',
  'message_sent',
  'client_updated',
  'booking_created',
  'booking_cancelled',
  'note_added',
  'followup_created',
  'followup_completed',
  'draft_regenerated',
  'client_merged',
  'knowledge_updated',
  'sop_updated',
] as const;

export type AuditActionType = typeof AUDIT_ACTION_TYPES[number];
```

### 3.2 pgmq audit retry queues

No new infrastructure. Uses the pgmq extension already required by F-02 (message pipeline):

```sql
SELECT pgmq.create('audit_retry');
SELECT pgmq.create('audit_dlq');
```

A pg_cron job (or the `process-message` Edge Function) processes `audit_retry` messages: re-attempt INSERT into `audit_events`. After 3 failures (tracked via pgmq `read_ct`), move to `audit_dlq` for manual inspection.

### 3.3 No `push_subscriptions` table (Phase 1)

Web Push subscriptions are a post-MVP concern. No `push_subscriptions` table is created in this feature. See §8 for the post-MVP extension plan.

### 3.4 No `notification_preferences` table (Phase 1)

Per-staff routing preferences (quiet hours, filter by type) are post-MVP per PRD §10.7. Phase 1 sends all workspace-level Realtime events to all subscribed staff. No `notification_preferences` table is created.

---

## 4. API Endpoints

### 4.1 `GET /api/notifications/unread-count`

Returns the current server-authoritative unread message count for the authenticated staff member's workspace.

**Auth:** Supabase JWT (workspace scoped via `auth.workspace_id()`).

**Response:**
```typescript
{
  total: number;
  byConversation: Array<{
    conversationId: string;
    clientName: string;
    unreadCount: number;
    lastMessageAt: string; // ISO 8601
  }>;
}
```

**Implementation:** Single SQL query on `messages` table:

```sql
SELECT
  c.id AS conversation_id,
  cl.display_name AS client_name,
  COUNT(m.id) AS unread_count,
  MAX(m.created_at) AS last_message_at
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
JOIN clients cl ON cl.id = c.client_id
WHERE m.workspace_id = auth.workspace_id()
  AND m.direction = 'inbound'
  AND m.is_read = false
GROUP BY c.id, cl.display_name
ORDER BY last_message_at DESC;
```

### 4.2 `PATCH /api/conversations/:conversationId/read`

Marks all inbound messages in a conversation as read.

**Auth:** Supabase JWT.

**Request body:** none.

**Response:** `200 OK` with `{ unreadCount: 0, conversationId: string }`.

**Implementation:**

```sql
UPDATE messages
SET is_read = true
WHERE conversation_id = $conversationId
  AND workspace_id = auth.workspace_id()
  AND direction = 'inbound'
  AND is_read = false;
```

This UPDATE is picked up by Supabase Realtime on other open tabs (`UPDATE` event on `messages`), keeping badge counts consistent across multiple browser tabs for the same staff member.

### 4.3 Supabase Realtime channels (client-side, not REST)

Two channels subscribed in `useInboxRealtime`:

**Channel 1: New inbound messages**

```typescript
supabase
  .channel(`workspace:${workspaceId}:messages`)
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'messages',
    filter: `workspace_id=eq.${workspaceId}`,
  }, handleNewMessage)
  .subscribe();
```

**Channel 2: Draft ready**

```typescript
supabase
  .channel(`workspace:${workspaceId}:drafts`)
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'drafts',
    filter: `workspace_id=eq.${workspaceId}`,
  }, handleDraftReady)
  .subscribe();
```

Both channels filter on `workspace_id` using the denormalized column — Realtime cannot JOIN; the column must exist on the filtered table.

---

## 5. Key Implementation Details

### 5.1 Audit fire-and-log pattern

Every Edge Function or API route that performs a mutation follows this pattern. The primary write always completes first; the audit write is non-blocking:

```typescript
// 1. Primary mutation — always runs, always awaited
const result = await supabase
  .from('messages')
  .insert(messageRow)
  .select()
  .single();

if (result.error) throw result.error;

// 2. Audit log — fire-and-forget, never throws to caller
auditService.logEvent({
  workspaceId,
  actorType: 'system',
  actorId: null,
  actionType: 'message_received',
  targetType: 'message',
  targetId: result.data.id,
  metadata: { sessionKey, after: messageRow },
}).catch((err) => {
  console.error('[audit_write_failed]', {
    error: err.message,
    workspaceId,
    actionType: 'message_received',
    targetId: result.data.id,
    payload: JSON.stringify(messageRow),
  });
  // Enqueue for retry via pgmq
  supabase.rpc('pgmq_send', {
    queue_name: 'audit_retry',
    msg: { event: auditEventPayload, attempt: 1 },
  });
});

return result.data;
```

The `catch` is always present. There is no code path where an audit write failure propagates to the caller or to the end user.

### 5.2 Realtime notification latency path (< 5-second target)

End-to-end latency budget for in-app notification (PRD §16.3):

```
T=0    Client sends WhatsApp message → Meta webhook fires
T+~0.3s  Edge Function (whatsapp-webhook) receives POST, verifies HMAC, deduplicates wamid
T+~0.5s  Raw message stored to `messages` table → Supabase Realtime emits INSERT event
T+~1s    Staff browser receives Realtime event → in-app toast shown, badge incremented
T=1s     Notification delivered ← well within 5-second target

[Async path — does not affect notification latency]
T+~1s    pg_net triggers `process-message` Edge Function asynchronously
T+~6-20s  LLM draft generated → `drafts` INSERT → "Draft ready" Realtime event
```

The in-app notification arrives at ~1 second because Supabase Realtime is triggered by the raw message INSERT, before the LLM pipeline runs. This is the dual-notification pattern from the final architecture.

### 5.3 Toast deduplication

Client-side deduplication for rapid messages from the same client:

```typescript
const lastToastTime = useRef<Map<string, number>>(new Map());

function handleNewMessage(payload: RealtimePayload) {
  const clientId = payload.new.client_id;
  const now = Date.now();
  const last = lastToastTime.current.get(clientId) ?? 0;

  if (now - last < 10_000) {
    // Suppress toast; badge still increments
    incrementBadge(payload.new.conversation_id);
    return;
  }

  lastToastTime.current.set(clientId, now);
  showToast(payload.new);
  incrementBadge(payload.new.conversation_id);
}
```

The badge always increments regardless of toast deduplication.

### 5.4 Audit instrumentation across mutation use cases

Every use case that writes a row calls `auditService.logEvent()` after the successful primary write. The call sites for all `action_type` values are established in this feature, with stubs for types belonging to future features. This ensures the audit table is wired into the system before downstream features (F-05 through F-09) are built.

Instrumentation map:

| `action_type` | Primary call site | Feature |
|---|---|---|
| `message_received` | `process-message` Edge Function, post-message INSERT | F-04 (pending OQ-1) |
| `draft_generated` | `process-message`, post-draft INSERT | F-05 |
| `message_sent` | `approve-action` Edge Function, post-send | F-05/F-06 |
| `client_updated` | `approve-action`, post-client UPDATE | F-03/F-06 |
| `booking_created` | `approve-action`, post-booking INSERT | F-07 |
| `booking_cancelled` | `approve-action`, post-booking UPDATE | F-07 |
| `note_added` | Note save handler | F-09 |
| `followup_created` | Follow-up save handler | F-09 |
| `followup_completed` | Follow-up update handler | F-09 |
| `draft_regenerated` | Reprompt handler | F-05 |
| `client_merged` | Client merge handler | F-09 |
| `knowledge_updated` | Knowledge index handler | F-09 |
| `sop_updated` | SOP update handler | F-01 |

F-04 implements `message_received` (pending OQ-1). All others are stubbed with a comment `// TODO: instrument in F-XX` at the eventual call site. No code is written for those stubs in this feature — just documentation of where the calls go.

### 5.5 Browser tab title badge

Updated by `useUnreadCount` hook:

```typescript
useEffect(() => {
  document.title = total > 0 ? `(${total}) Inbox` : 'Inbox';
}, [total]);
```

### 5.6 `is_read` column on `messages` table

The unread count query depends on an `is_read` boolean on the `messages` table. This column must be added to the `messages` schema (part of F-02's migration) if not already present. F-04 owns the migration that adds `is_read BOOLEAN NOT NULL DEFAULT false` if F-02 did not include it. Coordinate with F-02 engineer.

---

## 6. Edge Cases

### 6.1 Realtime channel disconnection

- Supabase Realtime client automatically reconnects with exponential backoff.
- `useInboxRealtime` exposes `status` to the UI. If `status === 'DISCONNECTED'` for > 10 seconds:
  - Show a non-intrusive banner: "Live updates paused — reconnecting…"
  - Begin polling `GET /api/notifications/unread-count` every 15 seconds.
  - On reconnect: fetch authoritative count from server to resolve any missed events. Dismiss banner.
- Missed Realtime events during disconnection are reconciled by the server-authoritative fetch on reconnect.

### 6.2 Audit write failure isolation

The primary message storage and notification have already completed before the audit write is attempted. Audit failure handling:

1. Log the full serialized event payload to structured error logs with `[audit_write_failed]` prefix.
2. Enqueue to `audit_retry` pgmq queue with the event payload.
3. pg_cron processes `audit_retry` every 60 seconds. Attempts INSERT up to 3 times (pgmq tracks `read_ct`).
4. After 3 failures, pgmq moves the message to `audit_dlq`.
5. Under no circumstances does an audit failure surface an error to the staff member or to the WhatsApp client.

### 6.3 Multiple rapid inbound messages (toast deduplication)

- Client-side 10-second dedup window (§5.3) suppresses repeated toasts for the same client.
- All messages are stored and visible in the conversation thread.
- Unread badge increments for every message regardless of toast deduplication.
- Audit events are written for every message regardless of toast deduplication.

### 6.4 Staff opens conversation thread with unread messages

On conversation open:
1. Call `PATCH /api/conversations/:id/read` → marks messages read in DB.
2. Update local unread count state to 0 for that conversation.
3. Recalculate and update browser tab title.
4. The UPDATE to `messages.is_read` propagates via Realtime `UPDATE` event to other open tabs.

### 6.5 Page reload — unread count from server

On page reload, `useUnreadCount` fetches `GET /api/notifications/unread-count` from the server before rendering badges. Local state is never used as the source of truth across page loads.

### 6.6 Concurrent tab handling

A staff member may have the inbox open in two tabs simultaneously.

- Both tabs subscribe to the same Realtime channel; both receive the same events.
- When Tab A opens a conversation and calls `PATCH /api/conversations/:id/read`, the `messages.is_read` UPDATE fires a Realtime `UPDATE` event.
- Tab B receives the `UPDATE` event and decrements its local badge count.
- This ensures badge state is consistent across tabs without a page reload.

### 6.7 `message_received` action type — pending PM alignment

US-F04-05 proposes `message_received` as a new audit action type. PRD §12.13 does not include it. This must be confirmed with PM before sprint start (OQ-1). If deferred, the `process-message` Edge Function logs a comment instead of an audit event for inbound message receipt. All other action types from PRD §12.13 are unaffected.

### 6.8 Inbound message with no text (media-only)

The Realtime toast must handle messages where `text` is null or empty. Toast body falls back to `"New media message"`. This is a client-side null check in `NotificationToast`:

```typescript
const body = message.text?.slice(0, 100) ?? 'New media message';
```

---

## 7. Acceptance Criteria to Task Mapping

### Task T-F04-01: `audit_events` table migration

Implements §3.1, §3.2.

- [ ] Create `audit_events` table with exact schema from `architecture-final.md §9`.
- [ ] Enable RLS; add `staff_read_own_workspace` SELECT policy.
- [ ] Confirm no INSERT/UPDATE/DELETE policies exist for the `authenticated` role.
- [ ] Create `audit_retry` and `audit_dlq` pgmq queues.
- [ ] Verify immutability: attempt `UPDATE audit_events SET actor_type = 'staff'` as authenticated role → permission denied error.
- [ ] Verify write: INSERT as service role → succeeds.
- [ ] Verify SELECT: authenticated staff can query their workspace; cannot see another workspace's records.

Covers AC: US-F04-04 "Audit events are immutable."

### Task T-F04-02: `AuditEvent` entity and `AuditService`

Implements §2.1, §2.2, §5.1, §5.4.

- [ ] `AuditEvent.ts` — typed entity, `AUDIT_ACTION_TYPES` const, `toRow()` serializer mapping to final schema field names (`id`, `target_type`, `created_at`).
- [ ] `AuditService.ts` — `logEvent()` with non-blocking catch, structured error log, pgmq retry enqueue.
- [ ] Unit tests: construction, `action_type` validation (reject unknown type), `toRow()` output shape.
- [ ] Integration test: `logEvent()` writes to `audit_events`; query returns correct fields.
- [ ] Integration test: `logEvent()` failure (mock DB error) → does not throw; error is logged; retry is enqueued.

Covers AC: US-F04-04 "Audit event write failure does not block the primary mutation."

### Task T-F04-03: Audit instrumentation in `process-message` Edge Function

Instruments the inbound message path. Requires OQ-1 resolution before implementing `message_received`.

- [ ] Add `auditService.logEvent()` call after successful message INSERT in `process-message`.
- [ ] `action_type: 'message_received'`, `actor_type: 'system'`, `actor_id: null` (pending OQ-1).
- [ ] `metadata.after` = normalised message payload; `metadata.session_key` = resolved session key.
- [ ] Verify: send a test inbound message → `audit_events` row created with correct fields.
- [ ] Verify: if audit INSERT fails → message is still stored, Realtime event still fires.
- [ ] Add `// TODO: instrument in F-XX` comments at future action_type call sites per §5.4 instrumentation map.

Covers AC: US-F04-04 all scenarios; US-F04-05 "Notification fails but audit event still written" and "Audit event fails but notification still dispatched."

### Task T-F04-04: Supabase Realtime notification channels

Implements §2.4, §2.5, §4.3.

- [ ] Confirm `workspace_id` is denormalized on `messages` and `drafts` tables (coordinate with F-02).
- [ ] `useInboxRealtime` hook: subscribe to `messages INSERT` and `drafts INSERT` Realtime channels filtered by `workspace_id`.
- [ ] `handleNewMessage`: increment badge, move conversation to top of list, show toast.
- [ ] `handleDraftReady`: show "Draft ready" indicator on conversation row.
- [ ] Disconnection detection: if `status === 'DISCONNECTED'` > 10 seconds, show reconnecting banner + start polling fallback.
- [ ] On reconnect: fetch authoritative unread count, dismiss banner, stop polling.
- [ ] Test: simulate Realtime disconnect → polling starts; reconnect → polling stops, banner dismissed.

Covers AC: US-F04-01 "Push notification delivered within latency target" (in-app); US-F04-03 "New inbound message increments the badge."

### Task T-F04-05: Unread badge count API and client hooks

Implements §2.6, §4.1, §4.2, §5.5, §5.6.

- [ ] `GET /api/notifications/unread-count` — server-authoritative query with correct SQL.
- [ ] `PATCH /api/conversations/:id/read` — marks messages read, returns `{ unreadCount: 0 }`.
- [ ] `useUnreadCount` hook: fetch on mount, update from Realtime events, reset on conversation open.
- [ ] Browser tab title: `(N) Inbox` when `N > 0`, plain `Inbox` at zero.
- [ ] Verify: page reload → unread counts fetched from server (not local cache).
- [ ] Verify: opening a conversation → badge resets to 0, tab title updates.
- [ ] Verify: multiple browser tabs → marking read in Tab A updates badge in Tab B (via Realtime `UPDATE` event).
- [ ] Add `is_read BOOLEAN NOT NULL DEFAULT false` column to `messages` if not present from F-02 migration.

Covers AC: US-F04-03 all scenarios.

### Task T-F04-06: In-app toast component

Implements §2.7, §5.3, §6.8.

- [ ] `NotificationToast.tsx` — renders client name, message preview (100 chars or "New media message").
- [ ] Tapping navigates to conversation thread via `router.push(/conversations/${conversationId})`.
- [ ] Auto-dismiss after 5 seconds.
- [ ] 10-second client-side dedup: suppress repeated toasts for same conversation, badge still increments.
- [ ] Renders at root layout level so it shows on all inbox sub-routes.

Covers AC: US-F04-01 "Notification while app is in the foreground"; "Multiple rapid inbound messages."

### Task T-F04-07: Audit retry processor

Implements §3.2, §6.2.

- [ ] pg_cron job (every 60 seconds): dequeue from `audit_retry`, re-attempt INSERT into `audit_events`.
- [ ] After 3 failures (check `read_ct`): move to `audit_dlq` via `pgmq.send('audit_dlq', msg)`.
- [ ] Test: enqueue a well-formed audit event to `audit_retry` → next cron run inserts it into `audit_events`.
- [ ] Test: enqueue a malformed event 3 times → moves to `audit_dlq`; `audit_events` remains unchanged.

Covers AC: US-F04-04 "Audit event write failure... retry or dead-letter mechanism."

### Task T-F04-08: End-to-end latency validation

- [ ] Instrument timing at: webhook receipt, `messages` INSERT, Realtime event received by client browser.
- [ ] Test in staging with simulated inbound message: measure T=0 to toast rendered.
- [ ] Target: < 5 seconds end-to-end. Expected actual: ~1 second.
- [ ] Log timing breakdown (webhook_received_ms, db_insert_ms, realtime_delivered_ms) in `llm_usage`-style structured log or Vercel log drain for ongoing monitoring.

Covers AC: US-F04-01 "Push notification delivered within latency target."

---

## 8. Post-MVP Extension: Web Push / VAPID (explicitly deferred)

This section documents the forward plan so it can be implemented without rearchitecting when background notifications are needed.

**Trigger:** Staff requests OS-level background notifications (app closed or minimised).

**What to add:**

1. `push_subscriptions` table: `(workspace_id, staff_id, device_fingerprint, endpoint, p256dh_key, auth_key, created_at, last_used_at)` with unique constraint on `(workspace_id, staff_id, device_fingerprint)`.
2. `POST /api/push/subscribe` and `DELETE /api/push/subscribe` endpoints.
3. `PushNotificationService` in a new Edge Function `send-push` or inline in `process-message`.
4. VAPID keys in environment config (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). Generate with `npx web-push generate-vapid-keys`. Never commit to source.
5. Service worker (`/public/sw.js`): handle `push` event → `showNotification`; handle `notificationclick` → deep-link to conversation; foreground detection to suppress OS notification in favour of in-app toast.
6. `useNotificationPermission` hook: permission state machine, user-gesture-triggered `requestPermission()`, VAPID subscribe, POST to subscription API.
7. 410/404 stale subscription cleanup in `PushNotificationService`.
8. iOS Safari: unsupported in-browser; only works when PWA is added to Home Screen (Safari 16.4+). Show one-time informational message for iOS users.

**Latency note:** The Realtime path already meets < 5-second latency. Web Push adds OS-level background delivery but introduces third-party push service latency (FCM/APNs) that is outside our control.

---

## 9. Dependencies

### Upstream (must exist before F-04 can be completed)

| Dependency | Feature | Reason |
|---|---|---|
| `messages` table with `workspace_id` column denormalized | F-02 (WhatsApp Message Pipeline) | Realtime filter requires this column on the table being subscribed |
| `drafts` table with `workspace_id` column denormalized | F-05 (AI Draft Generation) | Draft-ready Realtime channel requires same. Wire channel in F-04; events arrive once F-05 ships. |
| `workspaces` table | F-01 (Workspace Onboarding) | `audit_events.workspace_id` references this |
| pgmq extension enabled | F-02 | `audit_retry` and `audit_dlq` queues use pgmq |
| Supabase Realtime enabled in project settings | Platform | Postgres Changes must be enabled for the `messages` and `drafts` tables |
| `auth.workspace_id()` PostgreSQL function | Architecture foundation | RLS SELECT policy on `audit_events` uses this function |
| `is_read` column on `messages` | F-02 or F-04 | Unread count query depends on this; add in F-02 migration or F-04 migration with coordination |

### Downstream (features that depend on F-04)

| Feature | Dependency |
|---|---|
| F-06 (Approval Workflow & Governance) | Requires `audit_events` table, `AuditService`, and `message_received` event in place. All governance actions produce audit events. |
| F-05 (AI Draft Generation) | `draft_generated` / `draft_regenerated` call sites established here as stubs; wired in F-05 implementation |
| F-07 (Booking) | `booking_created` / `booking_cancelled` stubs |
| F-09 (Notes, Follow-ups, Knowledge) | `note_added` / `followup_created` / `followup_completed` / `knowledge_updated` / `client_merged` stubs |
| All Phase 2+ mutation use cases | Must call `auditService.logEvent()` per §5.4 instrumentation map |

### External services

| Service | Usage | Risk |
|---|---|---|
| Supabase Realtime | In-app notification delivery | Managed service; Supabase client reconnects automatically on drop |
| pgmq | Audit retry queue | Supabase-native extension; no additional infrastructure |

---

## 10. Open Questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| OQ-1 | Should `message_received` be added to the `action_type` enum? PRD §12.13 does not include it; US-F04-05 requires it for end-to-end auditability of the inbound message path. | PM + Eng | Yes — must resolve before T-F04-03 can be completed |
| OQ-2 | Does F-02's migration include `is_read BOOLEAN NOT NULL DEFAULT false` on the `messages` table? If so, T-F04-05 does not need its own migration for this column. | F-02 engineer | Yes — coordinate before T-F04-05 starts to avoid migration conflict |
| OQ-3 | Should the "Draft ready" Realtime channel (drafts INSERT) be wired in F-04 or deferred to F-05? Wiring now means no indicator fires until F-05 ships, but avoids a second channel subscription change later. | Eng | No — default: wire the channel in F-04, it simply produces no events until F-05 ships |
| OQ-4 | Should the "unreviewed AI draft" badge variant (US-F04-03: outlined style, separate count from unread messages) be scoped to Phase 1? Currently defined as a future extension point in the user story. | PM | No — deferred to F-06 unless PM upgrades priority |
