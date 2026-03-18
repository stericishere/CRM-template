# Feature Spec — F-06: Approval Workflow & Governance

**Feature:** F-06
**Phase:** 2 (AI Drafting & Booking)
**Size:** L (1-2 weeks)
**PRD Functions:** AG-01, AG-02, AG-03, AG-04, AG-05, AG-07, NT-03, NT-04
**User Stories:** US-F06-01 through US-F06-07
**Architecture modules:** `agent-governance` (ProposedAction, ConfirmationRequest, ApprovalPolicy, EvaluateApprovalPolicy, ExecuteApprovedAction), `agent/ToolParamInjector`
**ADR dependencies:** ADR-1 (tools return ProposedAction, not direct writes)
**Depends on:** F-04 (audit event foundation, `AuditService`), F-05 (Client Worker produces ProposedActions)
**Last updated:** March 2026

---

## Architecture alignment note

The canonical architecture (`docs/phase-3-architecture/architecture-final.md`) establishes the approval boundary as a core structural rule: **only deterministic application services may commit writes**. The LLM proposes; the system evaluates and gates; staff approves.

Key canonical decisions this spec adheres to:

- **Edge Functions, not BullMQ** -- `approve-action` is a Supabase Edge Function (Deno), called from the staff app (architecture-final.md SS 3.2).
- **pgmq for queuing** -- any retry or async work uses pgmq, not Redis/BullMQ.
- **Supabase Realtime** -- draft-ready and confirmation-ready notifications use Postgres Changes on `proposed_actions` and `drafts` tables (denormalized `workspace_id` for filtering).
- **Flat module structure** -- shared code lives in `supabase/functions/_shared/`, not in bounded-context layers.
- **Direct Anthropic SDK** -- no LLM abstraction layer; irrelevant to F-06 but noted for consistency.
- **pg_cron + pg_net** -- re-notification timer uses pg_cron, not BullMQ delayed jobs.

The MVP trust model is **fixed** (hardcoded tier assignments). All draft replies require staff review. No auto-send. No per-workspace policy customization.

---

## 1. Overview

F-06 is the enforcement layer between AI intent and real-world writes. It comprises four responsibilities:

1. **Approval policy evaluation** -- classify every `ProposedAction` from the Client Worker into one of three trust tiers (auto / review / human_only) and route accordingly.
2. **Confirmation card lifecycle** -- persist review-tier actions, render confirmation cards in the conversation thread, process staff approve/reject decisions atomically.
3. **Tool parameter injection** -- runtime override of `workspaceId` and `clientId` on every tool call, preventing LLM scope escape.
4. **Governance notifications** -- draft-ready alerts via Supabase Realtime (NT-03) and re-notification for stale pending actions via pg_cron (NT-04).

---

## 2. Component Breakdown

### 2.1 `approve-action` Edge Function (`supabase/functions/approve-action/index.ts`)

The staff-facing Edge Function that executes an approved `ProposedAction`. Called from the Next.js staff app when staff taps "Approve" or "Reject" on a confirmation card.

**Responsibilities:**

- Receive `{ proposed_action_id, decision: 'approve' | 'reject', staff_id }` from the staff app.
- Validate that the `ProposedAction` belongs to the staff member's workspace (RLS + application-level check).
- Acquire optimistic lock: `UPDATE proposed_actions SET status = $decision WHERE id = $id AND status = 'pending' RETURNING *`. If zero rows returned, the action was already acted upon or expired.
- On **approve**: dispatch to the `ActionExecutor` which routes to the correct domain write based on `actionType`. Wrap the status transition and domain write in a single database transaction. Write an `AuditEvent` on success.
- On **reject**: set `status = 'rejected'`, `reviewed_at`, `reviewed_by`. Write an `AuditEvent` with `action_type = 'proposed_action_rejected'`.
- On failure of the domain write: do not transition status. Return error to staff app. The confirmation card remains actionable.

**Latency target:** < 1 second (architecture-final.md SS 3.2).

### 2.2 Approval policy module (`supabase/functions/_shared/approval-policy.ts`)

Pure function. No side effects. Called inside `process-message` after the LLM tool execution loop completes.

```typescript
type ApprovalTier = 'auto' | 'review' | 'human_only';

function evaluateApprovalPolicy(
  action: ProposedAction,
  policy: ApprovalPolicy
): ApprovalTier;
```

The `ApprovalPolicy` is a static configuration object (not database-stored for MVP). It maps `actionType` values to tiers. Unknown action types default to `review` (principle of least privilege).

**MVP tier mapping:**

| Tier | `actionType` values |
|---|---|
| `auto` | `note_create` (source: `ai_extracted`), `last_contacted_update`, `tag_attach` (low-risk tags only) |
| `review` | `client_update`, `booking_create`, `followup_create`, `message_send`, any unmapped type |
| `human_only` | `refund_request`, `pricing_change`, `policy_exception`, `complaint_handling`, `liability_commitment` |

Human-only tier is also evaluated at the **intent classification** level. When the Client Worker classifies an inbound message intent as matching a human-only category, the system suppresses draft generation and proposal creation entirely. This evaluation happens in the `process-message` flow, before tool calls are made.

### 2.3 `ActionExecutor` (`supabase/functions/_shared/action-executor.ts`)

Router that dispatches approved `ProposedAction` payloads to the correct domain write. Not a monolith -- each action type is a small handler function.

```typescript
async function executeApprovedAction(
  supabase: SupabaseClient,
  action: ProposedAction,
  staffId: string
): Promise<{ success: boolean; error?: string }>;
```

Dispatch table:

| `actionType` | Handler | Target table | Audit `action_type` |
|---|---|---|---|
| `client_update` | `executeClientUpdate()` | `clients` | `client_updated` |
| `booking_create` | `executeBookingCreate()` | `bookings` | `booking_created` |
| `followup_create` | `executeFollowUpCreate()` | `follow_ups` | `followup_created` |
| `message_send` | `executeSendMessage()` | `messages` (outbound) | `message_sent` |

Each handler:
1. Performs the domain write (INSERT or UPDATE).
2. Returns the result (success or error with details).

The `approve-action` Edge Function wraps the status transition + handler execution in a transaction. If the handler fails, the transaction rolls back, and the `ProposedAction` stays `pending`.

### 2.4 Tool parameter injector (`supabase/functions/_shared/tool-executor.ts`)

This is the critical safety mechanism from architecture-final.md SS 6.4. It runs **after** the LLM outputs a tool call and **before** the tool executes.

```typescript
function executeToolCall(
  call: LLMToolCall,
  session: { workspaceId: string; clientId: string },
  toolRegistry: ToolRegistry
): Promise<ToolResult> {
  const tool = toolRegistry[call.name];
  if (!tool) throw new Error(`Unknown tool: ${call.name}`);

  // 1. Spread LLM args first, then overwrite with session-scoped values
  const params = {
    ...call.arguments,
    workspaceId: session.workspaceId,
    clientId: session.clientId,
    ...tool.fixedParams,  // per-tool fixed params (e.g., source: 'ai_extracted')
  };

  // 2. Log warning if LLM attempted to override session-scoped fields
  if (call.arguments.workspaceId && call.arguments.workspaceId !== session.workspaceId) {
    console.warn('[security] LLM attempted to override workspaceId', {
      attempted: call.arguments.workspaceId,
      injected: session.workspaceId,
    });
  }
  if (call.arguments.clientId && call.arguments.clientId !== session.clientId) {
    console.warn('[security] LLM attempted to override clientId', {
      attempted: call.arguments.clientId,
      injected: session.clientId,
    });
  }

  // 3. Validate merged params against tool's Zod schema
  const validated = tool.schema.parse(params);

  // 4. Execute
  return tool.execute(validated);
}
```

**Injection order matters:** LLM arguments are spread first, then session-scoped values overwrite. Then per-tool fixed params overwrite. Runtime values always win.

**Per-tool fixed parameters** are defined in the tool registry alongside each tool's Zod schema:

| Tool | Fixed params |
|---|---|
| `create_note` | `source: 'ai_extracted'` |
| `calendar_book` | (none beyond session scope) |
| `update_client` | (none beyond session scope) |
| `create_followup` | (none beyond session scope) |

### 2.5 `ConfirmationRequest` builder (`supabase/functions/_shared/confirmation-builder.ts`)

Constructs the human-readable confirmation card payload when a `ProposedAction` is classified as `review` tier. Called from `process-message` after approval policy evaluation.

Responsibilities:
- Generate a `summary` string from the action type and payload (e.g., "Book Initial Consultation on 22 Mar at 14:00").
- Snapshot `before_state` by querying the current value of fields being changed (for `client_update` actions).
- Store `after_state` from the proposed payload.
- Persist the `ProposedAction` with tier, summary, payload (including before/after), and status `pending` to the `proposed_actions` table.

The confirmation card is **not** a separate table. It is the `proposed_actions` row itself, rendered by the staff app's conversation thread component. The `summary`, `payload.before_state`, and `payload.after_state` fields provide all the data the UI needs.

### 2.6 Realtime notification channel for proposed actions

The staff app already subscribes to `proposed_actions` changes via Supabase Realtime (architecture-final.md SS 14):

```typescript
.on('postgres_changes', {
  event: '*',
  schema: 'public',
  table: 'proposed_actions',
  filter: `workspace_id=eq.${workspaceId}`,
}, handleActionUpdate)
```

- **INSERT** event: new confirmation card appears in the conversation thread.
- **UPDATE** event: card status changes to approved/rejected/expired, UI updates accordingly.

This uses the `workspace_id` column denormalized on `proposed_actions` (already present in the schema).

### 2.7 Re-notification processor (`supabase/functions/_shared/renotification.ts` + pg_cron)

Checks for stale pending actions and dispatches escalation notifications. Triggered by pg_cron every 15 minutes.

```sql
-- pg_cron job: check for stale pending actions
SELECT cron.schedule(
  'check-stale-actions',
  '*/15 * * * *',  -- every 15 minutes
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/daily-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'X-Cron-Task', 'renotification'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

The handler (a sub-routine within the `daily-cron` Edge Function or a dedicated lightweight function):

1. Query: `SELECT * FROM proposed_actions WHERE status = 'pending' AND created_at < now() - interval '60 minutes' AND renotified_at IS NULL`.
2. For each result: insert a Realtime-visible notification row (or trigger a Supabase Realtime broadcast) and set `renotified_at = now()`.
3. The `renotified_at` column ensures at-most-once re-notification per action.
4. Similarly check conversations with `manual_handling_required = true` that have had no staff activity within 60 minutes.

---

## 3. Data Model

### 3.1 `proposed_actions` table

Already defined in architecture-final.md SS 9.1. Reproduced with F-06-specific additions:

```sql
CREATE TABLE proposed_actions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID        NOT NULL REFERENCES workspaces(id),
  client_id       UUID        NOT NULL REFERENCES clients(id),
  conversation_id UUID        REFERENCES conversations(id),
  draft_id        UUID        REFERENCES drafts(id),          -- links to the draft that produced this action
  action_type     TEXT        NOT NULL,                        -- 'client_update', 'booking_create', 'followup_create', 'message_send'
  summary         TEXT        NOT NULL,                        -- human-readable for staff
  tier            TEXT        NOT NULL,                        -- 'auto', 'review', 'human_only'
  payload         JSONB       NOT NULL,                        -- includes before_state, after_state for updates
  status          TEXT        NOT NULL DEFAULT 'pending',      -- 'pending', 'approved', 'rejected', 'expired'
  renotified_at   TIMESTAMPTZ,                                 -- set when NT-04 re-notification fires (NULL = not yet)
  expires_at      TIMESTAMPTZ,                                 -- when this action can no longer be executed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID        REFERENCES staff(id)
);

-- Partial index for pending actions (used by re-notification query and staff app)
CREATE INDEX idx_proposed_actions_pending
  ON proposed_actions (workspace_id, status)
  WHERE status = 'pending';

-- Index for conversation thread rendering (all actions for a conversation)
CREATE INDEX idx_proposed_actions_conversation
  ON proposed_actions (conversation_id, created_at);

-- Index for re-notification query
CREATE INDEX idx_proposed_actions_stale
  ON proposed_actions (created_at)
  WHERE status = 'pending' AND renotified_at IS NULL;
```

**Additions beyond architecture-final.md SS 9:**
- `draft_id` -- links the proposed action to the draft invocation that produced it. Enables the UI to show actions in context with the draft.
- `renotified_at` -- tracks whether NT-04 re-notification has fired. Ensures at-most-once semantics.
- `expires_at` -- explicit expiry timestamp. For booking actions, set to the proposed slot's start time. For other actions, set to `created_at + interval '24 hours'`. NULL means no expiry.

### 3.2 `payload` JSONB shape (by action type)

**`client_update`:**
```typescript
{
  before_state: { lifecycle_status: 'open', full_name: 'Jane Smith' },
  after_state: { lifecycle_status: 'chosen_service' },
  changed_fields: ['lifecycle_status']
}
```

**`booking_create`:**
```typescript
{
  appointment_type: 'initial_consultation',
  start_time: '2026-03-22T14:00:00+08:00',
  end_time: '2026-03-22T15:00:00+08:00',
  notes: 'Client prefers afternoon slots',
  slot_id: 'slot-uuid-here'  // from calendar_query results
}
```

**`followup_create`:**
```typescript
{
  description: 'Confirm fabric selection',
  due_date: '2026-03-25',
  type: 'follow_up'
}
```

**`message_send`:**
```typescript
{
  draft_text: 'Hi Jane, your consultation is confirmed for...',
  channel: 'whatsapp'
}
```

### 3.3 `conversations` table addition

Add a `manual_handling_required` flag for human-only escalation:

```sql
ALTER TABLE conversations
  ADD COLUMN manual_handling_required BOOLEAN NOT NULL DEFAULT false;
```

This is a conversation-level flag, not client-level. A client can have both escalated and non-escalated conversations.

### 3.4 New audit action types

F-06 introduces two new audit `action_type` values that must be added to the `AUDIT_ACTION_TYPES` enum in `AuditEvent.ts` (established by F-04):

```typescript
// Add to AUDIT_ACTION_TYPES in lib/audit/AuditEvent.ts
'proposed_action_rejected',   // staff rejected a proposed action
'escalation_flagged',         // conversation flagged for manual handling (human-only tier)
```

### 3.5 Confirmation flow data lifecycle

```
1. process-message Edge Function completes LLM tool loop
   |
   v
2. For each ProposedAction returned by tools:
   evaluateApprovalPolicy(action, FIXED_MVP_POLICY) -> tier
   |
   +-- tier = 'auto':
   |     executeAction() immediately
   |     write AuditEvent (actor_type: 'ai')
   |     (no row in proposed_actions for auto-tier in MVP)
   |
   +-- tier = 'review':
   |     buildConfirmationCard(action) -> { summary, before_state, after_state }
   |     INSERT INTO proposed_actions (status: 'pending', tier: 'review')
   |     ** Supabase Realtime INSERT event -> staff sees card
   |
   +-- tier = 'human_only':
         UPDATE conversations SET manual_handling_required = true
         write AuditEvent (action_type: 'escalation_flagged')
         suppress draft generation for this intent
   |
   v
3. Staff interacts with confirmation card:
   |
   +-- Approve:
   |     approve-action Edge Function
   |     UPDATE proposed_actions SET status='approved' WHERE status='pending'
   |     (optimistic lock -- if 0 rows, already acted upon)
   |     executeApprovedAction(action) -> domain write
   |     write AuditEvent (actor_type: 'staff', actor_id: staff_id)
   |     ** Realtime UPDATE event -> card shows "Approved"
   |
   +-- Reject:
         UPDATE proposed_actions SET status='rejected' WHERE status='pending'
         write AuditEvent (action_type: 'proposed_action_rejected')
         ** Realtime UPDATE event -> card shows "Rejected"
```

### 3.6 `audit_events` integration

All F-06 mutations write audit events via the `AuditService` established in F-04. The fire-and-log pattern (non-blocking, retry via pgmq) applies uniformly.

| Trigger | `action_type` | `actor_type` | `metadata` includes |
|---|---|---|---|
| Auto-tier action executes | Varies by action (e.g., `note_added`) | `ai` | `proposed_action_id`, `tier: 'auto'`, `session_key` |
| Review-tier action approved | Varies by action (e.g., `client_updated`) | `staff` | `proposed_action_id`, `before`, `after`, `session_key` |
| Proposed action rejected | `proposed_action_rejected` | `staff` | `proposed_action_id`, `action_type` (original), `payload` |
| Human-only escalation | `escalation_flagged` | `system` | `intent_category`, `session_key`, `conversation_id` |

---

## 4. Three-Tier Trust Model

### 4.1 Classification logic

The approval policy is a pure function with no database lookups. It evaluates two inputs:

1. **`actionType`** from the `ProposedAction` -- determines the base tier.
2. **Intent category** from the Client Worker's intent classification -- determines if human-only escalation applies at the conversation level (before any tool calls).

```typescript
// supabase/functions/_shared/approval-policy.ts

const AUTO_ACTIONS = new Set([
  'note_create',
  'last_contacted_update',
  'tag_attach_low_risk',
]);

const HUMAN_ONLY_ACTIONS = new Set([
  'refund_request',
  'pricing_change',
  'policy_exception',
  'complaint_handling',
  'liability_commitment',
]);

const HUMAN_ONLY_INTENTS = new Set([
  'refund_request',
  'pricing_negotiation',
  'policy_exception',
  'complaint_handling',
  'liability_commitment',
]);

export type ApprovalTier = 'auto' | 'review' | 'human_only';

export interface ApprovalPolicy {
  autoActions: Set<string>;
  humanOnlyActions: Set<string>;
  humanOnlyIntents: Set<string>;
}

export const MVP_APPROVAL_POLICY: ApprovalPolicy = {
  autoActions: AUTO_ACTIONS,
  humanOnlyActions: HUMAN_ONLY_ACTIONS,
  humanOnlyIntents: HUMAN_ONLY_INTENTS,
};

export function evaluateApprovalTier(
  actionType: string,
  policy: ApprovalPolicy
): ApprovalTier {
  if (policy.autoActions.has(actionType)) return 'auto';
  if (policy.humanOnlyActions.has(actionType)) return 'human_only';
  return 'review'; // default: principle of least privilege
}

export function isHumanOnlyIntent(
  intentCategory: string,
  policy: ApprovalPolicy
): boolean {
  return policy.humanOnlyIntents.has(intentCategory);
}
```

### 4.2 Intent-level vs. action-level evaluation

These are two distinct gates:

1. **Intent-level gate** (runs first, in `process-message`): if the Client Worker classifies the inbound message intent as a human-only category, the system flags the conversation for manual handling and suppresses draft generation. No tool calls are made. No `ProposedAction` is created.

2. **Action-level gate** (runs second, after tool loop): each `ProposedAction` returned by tool execution is classified independently. A single LLM invocation may produce actions in different tiers (e.g., `note_create` is auto, `booking_create` is review).

### 4.3 Unknown action types

Any `actionType` not present in `AUTO_ACTIONS` or `HUMAN_ONLY_ACTIONS` defaults to `review`. A warning is logged:

```typescript
console.warn('[approval_policy] unmapped actionType defaults to review', { actionType });
```

This is a safety net. New action types introduced by future features are gated by default until explicitly classified.

---

## 5. Tool Parameter Injection

### 5.1 Injection point in the pipeline

The injection happens at step 9 of the inbound message pipeline (architecture-final.md SS 2.1):

```
LLM outputs tool call arguments
        |
        v
ToolParamInjector merges session-scoped params (overrides conflicts)
        |
        v
Zod schema validation on merged params
        |
        v
Tool execution (or ProposedAction wrapping for write tools)
```

### 5.2 Session key resolution

The session key is resolved at the start of `process-message` from the pgmq message payload:

```typescript
const sessionKey = `workspace:${workspaceId}:client:${clientId}`;
```

`workspaceId` comes from the message enqueue payload (set by the Baileys server). `clientId` comes from the client find-or-create step. These are never sourced from LLM output.

### 5.3 Per-tool schema validation

Every tool has a Zod schema in the tool registry (`supabase/functions/_shared/tool-registry.ts`). After parameter injection, the merged params are validated against this schema. If validation fails:

- The tool is not executed.
- An error result is returned to the LLM (so it can retry with corrected params in the next loop iteration).
- No audit event is written (no action was taken).
- The error is logged for debugging.

### 5.4 Security monitoring

Override attempts are logged with the `[security]` prefix. Repeated override attempts from a single session may indicate prompt injection. Post-MVP, these logs should be aggregated into an operational dashboard. For MVP, they are visible in Supabase Edge Function logs.

---

## 6. Notification Integration

### 6.1 Draft-ready notification (NT-03)

When `process-message` completes and saves a draft or inserts a review-tier `ProposedAction`, two Realtime events fire automatically:

1. **`drafts` INSERT** -- staff sees "Draft ready for review" in the conversation thread.
2. **`proposed_actions` INSERT** -- staff sees the confirmation card appear.

These are driven by Supabase Realtime Postgres Changes with no additional infrastructure. The staff app's `useInboxRealtime` hook (from F-04) already subscribes to `proposed_actions` changes.

**Notification content:**
- Draft ready: "Draft reply ready for review" with client display name.
- Confirmation card ready: action summary (e.g., "Booking proposal ready for review") with client display name.

Both use the same in-app toast component from F-04 (`NotificationToast.tsx`), differentiated by a `notificationType` field (`'draft_ready'` vs `'action_ready'`).

### 6.2 Escalation re-notification (NT-04)

**Trigger:** pg_cron job (`check-stale-actions`) runs every 15 minutes and calls a handler in the `daily-cron` Edge Function.

**Logic:**

```typescript
async function processStaleActions(supabase: SupabaseClient) {
  // Find pending actions older than 60 minutes, not yet re-notified
  const { data: staleActions } = await supabase
    .from('proposed_actions')
    .select('id, workspace_id, client_id, summary, action_type, conversation_id')
    .eq('status', 'pending')
    .is('renotified_at', null)
    .lt('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());

  for (const action of staleActions ?? []) {
    // Mark as re-notified (at-most-once)
    await supabase
      .from('proposed_actions')
      .update({ renotified_at: new Date().toISOString() })
      .eq('id', action.id)
      .eq('status', 'pending'); // guard: don't update if status changed concurrently

    // Insert a system message into the conversation for visibility
    // This triggers Realtime -> staff sees the escalation
    await supabase.from('messages').insert({
      conversation_id: action.conversation_id,
      workspace_id: action.workspace_id,
      direction: 'inbound', // system notification rendered as system message
      content: `Reminder: "${action.summary}" has been pending for over 1 hour`,
      sender_type: 'system',
      delivery_status: 'delivered',
    });
  }

  // Also check human-only escalated conversations with no staff activity
  const { data: staleFlagged } = await supabase
    .from('conversations')
    .select('id, workspace_id, client_id')
    .eq('manual_handling_required', true)
    .lt('last_message_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());

  // Similar re-notification logic for flagged conversations...
}
```

**At-most-once guarantee:** The `renotified_at` column is set on first re-notification. The query filters `renotified_at IS NULL`. Even if the pg_cron job runs multiple times within the 15-minute window, the conditional UPDATE + WHERE guard prevents duplicate notifications.

### 6.3 Notification distinctness

| Notification | Source event | Visual indicator | Toast body |
|---|---|---|---|
| Inbound message (NT-01, F-04) | `messages` INSERT (direction: inbound) | Default message icon | "[Client]: [preview]" |
| Draft ready (NT-03) | `drafts` INSERT | Pen/draft icon | "Draft reply ready for [Client]" |
| Confirmation ready (NT-03) | `proposed_actions` INSERT | Checkmark icon | "[Summary] ready for review" |
| Escalation re-notification (NT-04) | `messages` INSERT (sender_type: system) | Warning/clock icon | "Reminder: [Client] has pending action for 1h+" |

For MVP, these are the same notification type with different body text and a `notificationType` discriminator for UI rendering. Separate enable/disable controls are deferred to post-MVP.

---

## 7. Edge Cases

### 7.1 Expired actions

**Booking actions:** `expires_at` is set to the proposed slot's `start_time`. Once the time passes, a pg_cron job (or check at approval time) marks the action as `expired`.

**Other actions:** `expires_at` is set to `created_at + 24 hours`.

**Approval of expired action:** When staff taps "Approve" on an expired action:
1. The `approve-action` Edge Function checks `status` -- finds `expired`.
2. Returns error: `{ error: 'action_expired', message: 'This action has expired and can no longer be executed' }`.
3. No write is committed. The card shows "Expired" state.

**Expiry job:** A pg_cron sub-task runs alongside the re-notification check:

```sql
-- Expire proposed actions past their expiry time
UPDATE proposed_actions
SET status = 'expired'
WHERE status = 'pending'
  AND expires_at IS NOT NULL
  AND expires_at < now();
```

This fires a Realtime UPDATE event, updating the card UI for any staff viewing the conversation.

### 7.2 Concurrent approvals

Two staff members viewing the same confirmation card and tapping "Approve" simultaneously.

**Mitigation:** Optimistic locking via conditional UPDATE:

```sql
UPDATE proposed_actions
SET status = 'approved',
    reviewed_at = now(),
    reviewed_by = $staff_id
WHERE id = $proposed_action_id
  AND status = 'pending'
RETURNING *;
```

- First writer wins: the `WHERE status = 'pending'` clause means only one UPDATE matches.
- Second writer gets zero rows returned and receives: `{ error: 'already_acted', message: 'This action has already been approved' }`.
- Only one `AuditEvent` and one domain write are committed.
- The Realtime UPDATE event propagates to both staff members' UIs.

No advisory lock or database-level row lock is needed. The conditional UPDATE provides sufficient concurrency safety for the expected low contention (1-10 workspaces, single operator per workspace in MVP).

### 7.3 LLM attempting scope override

The LLM outputs a tool call with `workspaceId: 'WS-999'` (a different workspace).

**Mitigation:** The `ToolParamInjector` (SS 2.4) silently overwrites with the session-scoped value. The warning is logged:

```
[security] LLM attempted to override workspaceId { attempted: 'WS-999', injected: 'WS-001' }
```

There is no exception. The tool executes with the correct `workspaceId`. The LLM receives the normal tool result and is unaware its override was discarded.

**Post-MVP consideration:** If override attempts exceed a threshold per session (e.g., 3 attempts), flag the session for manual review and halt further LLM invocations. This is not implemented in MVP.

### 7.4 Approval atomicity -- domain write fails

Staff approves a `booking_create` action, but the Google Calendar API call fails.

**Behavior:**
1. The `approve-action` Edge Function wraps the status transition + domain write in a single database transaction.
2. The Calendar API call happens within the transaction handler. If it fails, the entire transaction rolls back.
3. The `ProposedAction` status remains `pending`.
4. Staff sees: "Action could not be completed -- please try again."
5. The failure is logged with error details.
6. The confirmation card remains actionable.

**Implementation note:** For external API calls (Google Calendar), the transaction cannot truly roll back the external call. The pattern is:
1. Attempt external API call first (create calendar event).
2. If successful, perform database writes (create booking record, update proposed_action status) in a single transaction.
3. If the external call fails, skip the database transaction entirely.
4. If the database transaction fails after the external call succeeds, log the orphaned calendar event for manual cleanup.

### 7.5 ProposedAction with stale before_state

Between the time a `ProposedAction` is created and when staff approves it, another staff member may have manually updated the same client field.

**Behavior (MVP):** The approval executes the proposed change regardless. The `AuditEvent` captures both the `before_state` (snapshotted at proposal time) and the `after_state`. The audit trail shows the full sequence of changes.

**Post-MVP enhancement:** Compare `before_state` against current database state at approval time. If they differ, show a conflict warning to staff before executing.

### 7.6 Multiple actions from single LLM invocation

The Client Worker returns 3 tool calls: `note_create` (auto), `client_update` (review), `booking_create` (review).

**Behavior:** Each action is evaluated independently:
- `note_create` executes immediately (auto tier). Audit event written.
- `client_update` and `booking_create` each produce a separate `proposed_actions` row with status `pending`.
- Both confirmation cards appear in the conversation thread, ordered by `created_at`.
- Approving one does not affect the other.

### 7.7 Rejection of already-expired action

Staff taps "Reject" on an action that has already expired.

**Behavior:** The conditional UPDATE `WHERE status = 'pending'` returns zero rows (status is `expired`). The card displays its expired state. No additional audit event is written (expiry was already logged by the expiry job).

### 7.8 Human-only escalation followed by non-sensitive follow-up

A conversation is flagged for manual handling. The client sends a follow-up message with a non-sensitive intent (e.g., "What are your opening hours?").

**Behavior:**
1. The inbound message is stored and notification fires (F-02, F-04).
2. The Client Worker is invoked (intent classification runs).
3. The new intent is non-sensitive, so a draft may be generated.
4. The `manual_handling_required` flag persists as a visual indicator.
5. Staff can approve the draft independently of the escalation flag.
6. Staff must explicitly clear the `manual_handling_required` flag when they consider the sensitive topic resolved.

---

## 8. Acceptance Criteria to Task Mapping

### Task T-F06-01: Tool parameter injector

Implements SS 2.4, SS 5. Highest priority -- must be complete before any Client Worker tool call can safely execute.

- [ ] `tool-executor.ts` in `_shared/`: implement `executeToolCall()` with session-scoped param injection.
- [ ] LLM-provided `workspaceId` and `clientId` are silently overwritten by session values.
- [ ] Per-tool fixed params (e.g., `source: 'ai_extracted'` for `create_note`) are applied after LLM args.
- [ ] Warning logged when LLM attempts to override `workspaceId` or `clientId`, with `[security]` prefix.
- [ ] Unknown tool name throws error and is not executed.
- [ ] Zod schema validation runs on merged (post-injection) params. Validation failure returns error to LLM; tool not executed.
- [ ] Unit tests: injection overrides LLM values; fixed params applied; unknown tool rejected; schema validation failure.
- [ ] Integration test: simulate LLM tool call with overridden `workspaceId` -> confirm correct workspace used, warning logged.

Covers AC: US-F06-06 all scenarios.

### Task T-F06-02: Approval policy evaluator

Implements SS 2.2, SS 4. Second priority -- gates all other approval flow tasks.

- [ ] `approval-policy.ts` in `_shared/`: implement `evaluateApprovalTier()` and `isHumanOnlyIntent()` as pure functions.
- [ ] `MVP_APPROVAL_POLICY` constant with auto, review, and human_only action type sets.
- [ ] `HUMAN_ONLY_INTENTS` set for intent-level gating.
- [ ] Unknown/unmapped `actionType` defaults to `review` with warning logged.
- [ ] Unit tests: each tier classification, unknown type defaults, intent-level classification.
- [ ] Integration with `process-message`: after tool loop, each `ProposedAction` is classified and routed.

Covers AC: US-F06-01 all scenarios.

### Task T-F06-03: ProposedAction persistence and confirmation card builder

Implements SS 2.5, SS 3.1, SS 3.2.

- [ ] Database migration: add `draft_id`, `renotified_at`, `expires_at` columns to `proposed_actions` table if not present. Add indexes per SS 3.1.
- [ ] Database migration: add `manual_handling_required` column to `conversations` table.
- [ ] `confirmation-builder.ts` in `_shared/`: generate summary text for each action type.
- [ ] For `client_update` actions: snapshot current field values as `before_state` in the payload.
- [ ] Set `expires_at`: booking actions expire at slot start time; others expire at `created_at + 24 hours`.
- [ ] INSERT into `proposed_actions` with status `pending` and tier `review`.
- [ ] Verify: INSERT triggers Supabase Realtime event (staff sees card).
- [ ] Unit tests: summary generation for each action type; before_state snapshot; expiry calculation.

Covers AC: US-F06-02 all scenarios.

### Task T-F06-04: `approve-action` Edge Function -- approval path

Implements SS 2.1, SS 2.3.

- [ ] Create `supabase/functions/approve-action/index.ts`.
- [ ] Accept `{ proposed_action_id, decision: 'approve', staff_id }`.
- [ ] Validate workspace ownership (proposed action's `workspace_id` matches staff's workspace).
- [ ] Optimistic lock: `UPDATE proposed_actions SET status = 'approved' WHERE id = $id AND status = 'pending' RETURNING *`.
- [ ] If zero rows returned: return `{ error: 'already_acted' }`.
- [ ] If action is expired (`status = 'expired'`): return `{ error: 'action_expired' }`.
- [ ] `ActionExecutor` dispatch table: `client_update`, `booking_create`, `followup_create`, `message_send`.
- [ ] Wrap status transition + domain write in database transaction.
- [ ] Write `AuditEvent` with `actor_type: 'staff'`, `proposed_action_id` in metadata.
- [ ] On domain write failure: transaction rolls back, status stays `pending`, error returned.
- [ ] Latency: < 1 second.
- [ ] Integration tests: approve pending action -> domain write occurs, audit event written; approve already-approved action -> error; approve expired action -> error.
- [ ] Concurrent approval test: two simultaneous approvals -> only one succeeds, other gets `already_acted`.

Covers AC: US-F06-03 all scenarios.

### Task T-F06-05: `approve-action` Edge Function -- rejection path

Implements SS 2.1.

- [ ] Accept `{ proposed_action_id, decision: 'reject', staff_id }`.
- [ ] Optimistic lock: `UPDATE proposed_actions SET status = 'rejected' WHERE id = $id AND status = 'pending' RETURNING *`.
- [ ] If zero rows returned: return appropriate error (already acted or expired).
- [ ] Set `reviewed_at` and `reviewed_by`.
- [ ] Write `AuditEvent` with `action_type: 'proposed_action_rejected'`.
- [ ] No domain write is committed.
- [ ] Rejection is irreversible -- no undo endpoint.
- [ ] Rejected action data retained in database for learning loop (F-15).
- [ ] Add `proposed_action_rejected` to `AUDIT_ACTION_TYPES` enum.
- [ ] Integration tests: reject pending action -> status changes, audit written; reject expired action -> no change.
- [ ] Verify: rejecting one card does not affect other pending cards in same conversation.

Covers AC: US-F06-04 all scenarios.

### Task T-F06-06: Human-only escalation flow

Implements SS 4.2 (intent-level gate), SS 3.3.

- [ ] In `process-message`: after intent classification, check `isHumanOnlyIntent(intent, policy)`.
- [ ] If human-only: set `conversations.manual_handling_required = true`.
- [ ] Skip draft generation and tool execution for this intent.
- [ ] Write `AuditEvent` with `action_type: 'escalation_flagged'`, `metadata.intent_category`.
- [ ] Add `escalation_flagged` to `AUDIT_ACTION_TYPES` enum.
- [ ] Staff app: render visual indicator (warning icon + "Needs manual attention" label) on flagged conversations.
- [ ] Subsequent messages from same client still invoke Client Worker for intent classification.
- [ ] Non-sensitive follow-up intents in a flagged conversation still generate drafts normally.
- [ ] `manual_handling_required` flag persists until explicitly cleared by staff.
- [ ] Integration tests: human-only intent -> conversation flagged, no draft generated; subsequent non-sensitive message -> draft generated normally.

Covers AC: US-F06-05 all scenarios.

### Task T-F06-07: Auto-tier action execution in process-message

Implements SS 3.5 (auto tier path).

- [ ] In `process-message`: after approval policy evaluation, auto-tier actions execute immediately via `ActionExecutor`.
- [ ] Write `AuditEvent` with `actor_type: 'ai'` for each auto-executed action.
- [ ] No `proposed_actions` row is created for auto-tier actions (they are fire-and-forget with audit logging).
- [ ] Integration test: `note_create` action -> note saved immediately, audit event written, no confirmation card.

Covers AC: US-F06-01 "Auto-allowed action is classified and executed immediately."

### Task T-F06-08: Re-notification processor (NT-04)

Implements SS 2.7, SS 6.2.

- [ ] pg_cron job: `check-stale-actions` runs every 15 minutes, calls `daily-cron` with `X-Cron-Task: renotification`.
- [ ] Handler: query pending actions older than 60 minutes with `renotified_at IS NULL`.
- [ ] For each stale action: set `renotified_at = now()` (at-most-once).
- [ ] Insert system message into conversation for Realtime visibility.
- [ ] Also handle stale human-only flagged conversations (same 60-minute threshold).
- [ ] Re-notification fires at most once per pending action.
- [ ] If action has been acted upon between cron runs, the conditional UPDATE returns zero rows -- no notification sent.
- [ ] Integration tests: pending action at 61 minutes -> re-notification fires; re-notification does not fire twice; acted-upon action -> no re-notification.

Covers AC: US-F06-07 escalation re-notification scenarios.

### Task T-F06-09: ProposedAction expiry job

Implements SS 7.1.

- [ ] pg_cron sub-task (can run with the re-notification check): `UPDATE proposed_actions SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()`.
- [ ] Realtime UPDATE event fires -> staff sees card transition to "Expired."
- [ ] Staff cannot approve an expired action (guarded by optimistic lock in T-F06-04).
- [ ] Integration tests: booking action with past slot time -> status set to expired; approval attempt on expired action -> error.

Covers AC: US-F06-03 "Approval of an already-expired action."

### Task T-F06-10: Staff app UI -- confirmation cards in conversation thread

Implements SS 2.6.

- [ ] Render `proposed_actions` rows inline in the conversation thread, ordered by `created_at`.
- [ ] Card displays: `summary`, `action_type`, before/after state diff (for updates), "Approve" and "Reject" buttons.
- [ ] For `message_send` actions: display full draft text with inline edit capability (edit flow is F-05 scope).
- [ ] On approve: call `approve-action` Edge Function. Update card to show "Approved" with timestamp.
- [ ] On reject: call `approve-action` Edge Function with `decision: 'reject'`. Update card to show "Rejected" with timestamp.
- [ ] On error (already acted, expired): show appropriate error message.
- [ ] Expired cards show "Expired" state, buttons removed.
- [ ] Pending cards show "Approve" and "Reject" buttons.
- [ ] Realtime UPDATE events update card state without page reload.
- [ ] Multiple cards are independently actionable.
- [ ] Escalation flag renders as a distinct visual indicator (warning icon + label) at the conversation level.

Covers AC: US-F06-02 (card rendering), US-F06-03 (approve UI), US-F06-04 (reject UI), US-F06-05 (escalation UI).

---

## 9. Dependencies

### Upstream (must exist before F-06)

| Dependency | Feature | Reason |
|---|---|---|
| `audit_events` table + `AuditService` + `AUDIT_ACTION_TYPES` | F-04 | All F-06 mutations write audit events |
| `proposed_actions` table (base schema) | Architecture foundation | Core data model for approval boundary |
| `process-message` Edge Function with LLM tool loop | F-05 | Produces `ProposedAction` objects that F-06 evaluates |
| Tool registry with Zod schemas | F-05 | `ToolParamInjector` validates against these schemas |
| Supabase Realtime subscription on `proposed_actions` | F-04 (wired), F-06 (events fire) | Cards appear in staff app via Realtime |
| `conversations` table | F-02 | `manual_handling_required` column added by F-06 |
| pgmq extension enabled | F-02 | Re-notification retry uses pgmq |
| pg_cron enabled | Architecture foundation | Re-notification and expiry jobs |

### Downstream (features that depend on F-06)

| Feature | Dependency |
|---|---|
| F-07 (Booking & Scheduling) | Booking creation goes through approval workflow; `booking_create` action type in `ActionExecutor` |
| F-09 (Notes, Follow-ups, Knowledge) | Follow-up creation goes through approval workflow; note creation uses auto-tier |
| F-13 (Intelligent Note Processing) | Uses confirmation cards for data change proposals from note analysis |
| F-15 (Learning Loop) | Rejected `ProposedAction` records are learning signals |

### External services

| Service | Usage | Risk |
|---|---|---|
| Google Calendar API | `booking_create` handler creates calendar events | External API failure handled by transaction rollback (SS 7.4) |
| Supabase Realtime | Confirmation card delivery to staff | Managed service; client reconnects automatically |
| pg_cron | Re-notification and expiry jobs | Supabase-native; minimum 1-minute interval |

---

## 10. Open Questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| OQ-1 | **ProposedAction expiry defaults:** PRD does not specify expiry durations. This spec proposes: booking actions expire at proposed slot time; other actions expire after 24 hours. Needs PM alignment. | PM + Eng | No -- implement proposed defaults, adjust by config later |
| OQ-2 | **Rejection reason capture:** Should MVP include an optional free-text field for staff rejection reasons? Improves learning loop fidelity (F-15) but adds UI complexity. Recommend deferring to post-MVP. | PM | No -- deferred |
| OQ-3 | **Draft-ready vs. confirmation-ready notification distinctness:** Should these be visually distinct notification types or same type with different body text? Recommend same type for MVP, split post-MVP. | PM | No -- same type for MVP |
| OQ-4 | **Re-notification for human-only escalations:** NT-04 says "re-send if staff hasn't reviewed within 1h" but does not specify whether this covers human-only flags. This spec includes it. Confirm with PM. | PM | No -- included by default |
| OQ-5 | **Stale before_state conflict detection:** Should approval check current DB state against snapshotted `before_state` and warn staff of conflicts? Recommend deferring to post-MVP. | Eng | No -- deferred |
| OQ-6 | **Auto-tier actions in proposed_actions table:** Should auto-tier actions be persisted to `proposed_actions` for auditability, or is the `audit_events` record sufficient? This spec omits them from `proposed_actions` to reduce table size. | Eng | No -- audit_events is sufficient for MVP |
