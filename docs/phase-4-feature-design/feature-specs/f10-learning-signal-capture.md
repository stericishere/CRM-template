# Feature Spec — F-10: Learning Signal Capture

**Feature:** F-10
**Phase:** 2 (AI Drafting & Booking)
**Size:** S (2-3 days)
**PRD Functions:** LL-01
**User Stories:** US-F10-01, US-F10-02, US-F10-03
**Architecture modules:** `learning-optimization` (RecordDraftEditSignal, DraftEditSignal)
**Depends on:** F-05 (AI Drafting — drafts table and Client Worker operational)
**Last updated:** March 2026

---

## Architecture alignment note

The canonical architecture (`docs/phase-3-architecture/architecture-final.md`) defines signal recording as step 3 in the send flow (§16.8), occurring in the Next.js Server Action between saving the outbound message and calling the Baileys server to dispatch. This positioning is intentional: signal recording is an application-layer concern owned by the Next.js app, not an Edge Function.

Key canonical decisions this spec adheres to:

- **Next.js Server Action, not an Edge Function** — signal recording happens in the staff send flow inside the Next.js app (`src/app/(dashboard)/inbox/[conversationId]/`), not in `approve-action` or any Edge Function.
- **Supabase PostgreSQL** — `draft_edit_signals` is a standard Postgres table with RLS. No pgmq, no pg_net, no queue.
- **Non-blocking best-effort write** — signal write failure must not prevent WhatsApp dispatch. This is an explicit architecture requirement (§16.8 and user story US-F10-01).
- **No LLM call** — F-10 is a pure database write. Zero AI inference.
- **Flat module structure** — the signal recorder is a small utility function in `src/lib/learning/` inside the Next.js app, not a shared Edge Function module.
- **workspace_id on every row** — denormalized on `draft_edit_signals` for consistent RLS scoping across all learning tables.

Phase 2 scope is **recording only**. Diff classification (`edit_categories`, `pattern_key`) and reply-outcome attribution (`client_replied`, `client_reply_latency_minutes`) are deferred to Phase 3 (F-14) and Phase 4 (F-15). Those fields exist on the schema as nullable columns from day one so the table never requires a destructive migration.

---

## 1. Overview

F-10 lays the raw data foundation for the learning loop. Every time a staff member acts on an AI-generated draft — sends it unchanged, edits and sends it, regenerates it, or discards it — the system writes one structured `DraftEditSignal` row to the `draft_edit_signals` table.

The write fires at the exact moment of staff action. For send actions (sent_as_is, edited_and_sent) it fires before the WhatsApp dispatch call but after the outbound message has been saved to the `messages` table. For non-send actions (regenerated, discarded) it fires at the moment of the button click.

No record is ever created for manually composed replies (messages sent without a corresponding draft). If a staff member discards a draft and then types a manual reply, the discard signal was already written; the manual message has no signal.

---

## 2. Component Breakdown

### 2.1 `recordDraftEditSignal` utility (`src/lib/learning/record-signal.ts`)

A single async function that executes the `draft_edit_signals` INSERT. Called from the send Server Action and from the discard/regenerate handlers.

```typescript
type StaffAction = 'sent_as_is' | 'edited_and_sent' | 'regenerated' | 'discarded';

interface DraftEditSignalInput {
  workspaceId: string;
  clientId: string;
  draftId: string;
  staffAction: StaffAction;
  originalDraft: string;
  finalVersion: string | null;          // null for regenerated and discarded
  intentClassified: string;             // copied from drafts.intent_classified
  scenarioType: string;                 // copied from drafts.scenario_type (Phase 2 addition)
}

async function recordDraftEditSignal(
  supabase: SupabaseClient,
  input: DraftEditSignalInput
): Promise<{ success: boolean; error?: string }>;
```

The function:
1. Validates that `finalVersion` is non-null when `staffAction` is `sent_as_is` or `edited_and_sent`.
2. Substitutes the sentinel value `"unclassified"` for any null or empty `intentClassified` / `scenarioType`, and logs a warning with the `draftId`.
3. Executes `supabase.from('draft_edit_signals').insert(...)`.
4. Returns `{ success: true }` or `{ success: false, error: message }` — never throws.

The function never throws. All errors are caught internally and returned as a structured result. The caller decides whether to surface or swallow.

### 2.2 Send Server Action (`src/app/(dashboard)/inbox/[conversationId]/actions.ts`)

The existing (or new) `sendDraftReply` Server Action that orchestrates the staff send flow. F-10 adds step 3 to the sequence:

```
sendDraftReply(draftId, finalText, staffId)
  │
  ├─ 1. Fetch draft record (id, content, intent_classified, scenario_type,
  │      conversation_id, workspace_id, client_id)
  ├─ 2. INSERT outbound message to `messages` table
  ├─ 3. recordDraftEditSignal(...)          <-- F-10 addition (non-blocking)
  │      ↳ failure: log error, continue
  ├─ 4. UPDATE drafts SET staff_action, reviewed_at, reviewed_by, edited_content
  ├─ 5. HTTP POST to Baileys server: /send
  │      { workspaceId, to: clientPhone, content: finalText }
  └─ 6. UPDATE conversation state → 'awaiting_client_reply'
```

Step 3 is wrapped in a try/catch that logs the error with `draftId` and `error.message` but does not re-throw. Steps 4 and 5 proceed regardless of step 3's outcome.

### 2.3 Discard handler (`src/components/draft/DraftActions.tsx` or equivalent)

When the staff member clicks "Discard", the UI calls a `discardDraft` Server Action:

```
discardDraft(draftId, staffId)
  │
  ├─ 1. Fetch draft record
  ├─ 2. recordDraftEditSignal({ staffAction: 'discarded', finalVersion: null, ... })
  │      ↳ failure: log error, continue
  └─ 3. UPDATE drafts SET staff_action = 'discarded', reviewed_at, reviewed_by
```

No WhatsApp message is dispatched. No conversation state change — the conversation remains open for the staff member to handle manually.

### 2.4 Regenerate handler (`src/components/draft/DraftActions.tsx` or equivalent)

When the staff member clicks "Regenerate", the UI calls a `regenerateDraft` Server Action. This handler runs **before** the new LLM call is initiated:

```
regenerateDraft(draftId, staffId)
  │
  ├─ 1. Fetch current draft record
  ├─ 2. recordDraftEditSignal({ staffAction: 'regenerated', finalVersion: null, ... })
  │      ↳ failure: log error, continue
  ├─ 3. UPDATE current draft SET staff_action = 'regenerated', reviewed_at, reviewed_by
  └─ 4. Trigger new LLM call (enqueue to pgmq or direct process-message invocation)
         ↳ New draft will arrive via Supabase Realtime (dual notification pattern)
```

Signal timing: the signal for the superseded draft is written at click time, before the new draft request is dispatched. This ensures the signal is captured even if the LLM call fails or times out.

### 2.5 Regeneration rate limit enforcement (UI layer)

The 5-regeneration soft cap (PRD §18.4) is enforced in the UI component, not in the signal recording layer. The `DraftActions` component queries `draft_edit_signals` (or the `drafts` table `staff_action` field) to count `regenerated` signals for the current conversation turn and disables the "Regenerate" button at count 5.

Signal recording itself does not check or enforce this cap. The cap is a UI concern.

---

## 3. Data Model

### 3.1 `draft_edit_signals` table

The architecture-final.md schema (§9.1) defines the base table. F-10 extends it with `scenario_type`, which was specified in the user stories (US-F10-01) but absent from the initial schema stub. A migration adds this column.

```sql
-- ============================================================
-- DRAFT EDIT SIGNALS (learning loop -- Phase 2 recording only)
-- ============================================================
CREATE TABLE draft_edit_signals (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                UUID NOT NULL REFERENCES workspaces(id),
  client_id                   UUID NOT NULL REFERENCES clients(id),
  draft_id                    UUID NOT NULL REFERENCES drafts(id),
  staff_action                TEXT NOT NULL
                                CHECK (staff_action IN (
                                  'sent_as_is',
                                  'edited_and_sent',
                                  'regenerated',
                                  'discarded'
                                )),
  original_draft              TEXT NOT NULL,
  final_version               TEXT,                         -- null for regenerated, discarded
  intent_classified           TEXT NOT NULL DEFAULT 'unclassified',
  scenario_type               TEXT NOT NULL DEFAULT 'unclassified',

  -- Phase 3 (F-14): populated by AcceptanceMetricsWorker
  client_replied              BOOLEAN,
  client_reply_latency_minutes INTEGER,

  -- Phase 4 (F-15): populated by LearningWorker
  edit_categories             TEXT[],
  pattern_key                 TEXT,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_draft_edit_signals_workspace
  ON draft_edit_signals(workspace_id, created_at DESC);

CREATE INDEX idx_draft_edit_signals_draft
  ON draft_edit_signals(draft_id);

CREATE INDEX idx_draft_edit_signals_workspace_action
  ON draft_edit_signals(workspace_id, staff_action, created_at DESC);
```

**Design decisions:**

- `staff_action` uses a CHECK constraint rather than a Postgres enum type. Enum types require a migration to add values; CHECK constraints can be altered with a single `ALTER TABLE`. This preserves the ability to extend the action taxonomy in Phase 4 without a destructive migration.
- `final_version` is nullable by design: `regenerated` and `discarded` produce no sent text. A `NOT NULL` constraint would force spurious empty strings that would corrupt downstream diff analysis.
- `intent_classified` and `scenario_type` default to `'unclassified'` at the database level as a secondary safety net. The application layer substitutes the sentinel before insert; the DB default is a last-resort guard.
- Phase 3 and Phase 4 columns (`client_replied`, `client_reply_latency_minutes`, `edit_categories`, `pattern_key`) are included as nullable columns from day one. They are populated by later features via `UPDATE`. This avoids future ALTER TABLE migrations on a table that may have millions of rows by Phase 4.

### 3.2 Column reference

| Column | Type | Nullable | Populated by | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | DB default | Primary key |
| `workspace_id` | UUID | NO | Application | FK to workspaces; RLS scoping |
| `client_id` | UUID | NO | Application | FK to clients |
| `draft_id` | UUID | NO | Application | FK to drafts; one signal per draft per action |
| `staff_action` | TEXT | NO | Application | Enum-checked: sent_as_is, edited_and_sent, regenerated, discarded |
| `original_draft` | TEXT | NO | Application | Exact text from `drafts.content` at action time |
| `final_version` | TEXT | YES | Application | Non-null only for sent_as_is and edited_and_sent |
| `intent_classified` | TEXT | NO | Application | Copied from `drafts.intent_classified`; sentinel 'unclassified' if missing |
| `scenario_type` | TEXT | NO | Application | Copied from `drafts.scenario_type`; sentinel 'unclassified' if missing |
| `client_replied` | BOOLEAN | YES | F-14 (Phase 3) | Did the client reply after this send? |
| `client_reply_latency_minutes` | INTEGER | YES | F-14 (Phase 3) | Minutes from send to client reply |
| `edit_categories` | TEXT[] | YES | F-15 (Phase 4) | Diff classification tags |
| `pattern_key` | TEXT | YES | F-15 (Phase 4) | Recurring edit pattern identifier |
| `created_at` | TIMESTAMPTZ | NO | DB default | UTC timestamp of the staff action |

### 3.3 `drafts` table — `scenario_type` column addition

The user stories reference `scenario_type` as a field on the draft record (copied to the signal at write time). The architecture-final.md schema stub for `drafts` does not include this column. F-10 requires a migration to add it:

```sql
ALTER TABLE drafts
  ADD COLUMN scenario_type TEXT;
```

The Client Worker (F-05) populates `scenario_type` alongside `intent_classified` during draft generation. F-10 copies it from the draft at signal write time. F-10 does not define the scenario taxonomy — that alignment is tracked as an open question (see §7).

### 3.4 RLS policies

```sql
-- Staff can only read signals from their own workspace
CREATE POLICY "workspace_isolation_select"
  ON draft_edit_signals FOR SELECT
  TO authenticated
  USING (workspace_id = auth.workspace_id());

-- Signals are written by the Next.js server (service role) in Server Actions
-- Staff cannot insert, update, or delete signals directly
-- No INSERT/UPDATE/DELETE policies for authenticated role
```

Signal writes use the Supabase service role key (available in Next.js Server Actions via `SUPABASE_SERVICE_ROLE_KEY`). This prevents any client-side manipulation of signal data.

---

## 4. Recording Logic

### 4.1 Determining `staff_action`

| Staff action | `staff_action` value | `final_version` | Trigger point |
|---|---|---|---|
| Clicks Send, draft text unchanged | `sent_as_is` | = `drafts.content` (original text) | Send button click |
| Clicks Send, draft text modified (including whitespace-only changes) | `edited_and_sent` | = text actually sent | Send button click |
| Clicks Regenerate | `regenerated` | null | Regenerate button click, before new LLM call |
| Clicks Discard | `discarded` | null | Discard confirmation |

Whitespace-only edits classify as `edited_and_sent`. The comparison is performed on raw text (not trimmed). `final_version` stores the text after trimming trailing/leading whitespace, matching the text sent to the client. `original_draft` retains the exact stored `drafts.content` with no mutation.

### 4.2 Source fields

All fields written to `draft_edit_signals` are derived from data already present at action time — no additional LLM call, no external API call, no async lookup.

```typescript
// Pseudo-code: data assembly inside recordDraftEditSignal caller
const draft = await supabase
  .from('drafts')
  .select('id, content, intent_classified, scenario_type, workspace_id, client_id')
  .eq('id', draftId)
  .single();

const signal: DraftEditSignalInput = {
  workspaceId:       draft.workspace_id,
  clientId:          draft.client_id,
  draftId:           draft.id,
  staffAction:       determineStaffAction(draft.content, finalText),
  originalDraft:     draft.content,
  finalVersion:      isSendAction ? finalText.trim() : null,
  intentClassified:  draft.intent_classified ?? 'unclassified',
  scenarioType:      draft.scenario_type ?? 'unclassified',
};
```

### 4.3 `edited_and_sent` vs `sent_as_is` detection

The send handler receives two text values: `draft.content` (the stored AI text) and `finalText` (the text in the compose field at send time). These are compared with strict string equality:

```typescript
function determineStaffAction(
  originalContent: string,
  sentText: string
): 'sent_as_is' | 'edited_and_sent' {
  return originalContent === sentText ? 'sent_as_is' : 'edited_and_sent';
}
```

Note: `sentText` is the raw value from the compose field, before trimming. `final_version` is stored as `sentText.trim()`. If the two differ only by whitespace — the `trim()` brings them together — the staff_action is still `edited_and_sent` because the raw strings were not equal. This is the correct behavior per US-F10-01 (whitespace-only edits scenario).

---

## 5. Non-Blocking Pattern

### 5.1 Requirement

A failed signal write must not prevent WhatsApp message delivery. This is stated explicitly in the architecture (§16.8 step 3) and in all three user stories.

### 5.2 Implementation

The `recordDraftEditSignal` function never throws. It catches all errors internally:

```typescript
async function recordDraftEditSignal(
  supabase: SupabaseClient,
  input: DraftEditSignalInput
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .from('draft_edit_signals')
      .insert({
        workspace_id:       input.workspaceId,
        client_id:          input.clientId,
        draft_id:           input.draftId,
        staff_action:       input.staffAction,
        original_draft:     input.originalDraft,
        final_version:      input.finalVersion,
        intent_classified:  input.intentClassified,
        scenario_type:      input.scenarioType,
      });

    if (error) {
      console.error('[learning] signal write failed', {
        draftId: input.draftId,
        action:  input.staffAction,
        error:   error.message,
        code:    error.code,
      });
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[learning] signal write threw', {
      draftId: input.draftId,
      action:  input.staffAction,
      error:   message,
    });
    return { success: false, error: message };
  }
}
```

The `sendDraftReply` Server Action calls this function and discards the return value:

```typescript
// Non-blocking: result is intentionally ignored
void recordDraftEditSignal(supabase, signal).catch(() => {
  // Already caught inside the function — belt-and-suspenders
});

// Execution continues unconditionally
await sendViaWhatsApp(workspaceId, clientPhone, finalText);
```

### 5.3 No retry for signal writes

Signal writes are best-effort. There is no retry queue for failed signal writes. A retry mechanism would add complexity and latency to a non-critical path. If a signal is permanently lost due to a DB error, the downstream learning loop operates on a slightly smaller dataset — acceptable at MVP scale.

If signal loss becomes a recurring operational issue (e.g., DB degradation during high traffic), it will be visible in server logs tagged `[learning] signal write failed`. At that point, a pgmq-backed write queue can be added without changing the data model.

### 5.4 No UI feedback on failure

Signal write errors are never surfaced to the staff member. The send action completes normally. Errors appear only in Vercel server function logs.

---

## 6. Edge Cases

### 6.1 Discard followed by manual reply

When a staff member discards a draft and then composes a manual reply:

1. The `discarded` signal is written immediately when the discard action fires (not deferred).
2. The manual reply is sent through the standard message pipeline.
3. No additional learning signal is written for the manual reply.

Manual messages have no `draft_id` to reference, making a signal record impossible without a schema extension. Capturing manual replies as a `manual` staff_action variant is tracked as an open question (§7.2) but is explicitly out of scope for Phase 2.

### 6.2 Regeneration chains

Each regeneration creates a new `drafts` row with a new `draft_id`. The signal for the superseded draft is written when the staff member clicks "Regenerate", referencing the old `draft_id`. The signal for the eventual sent draft references the new `draft_id`.

For a chain of N regenerations followed by a send, exactly N+1 signals are written, each referencing its own distinct `draft_id`. There is no parent/child relationship between signals in the schema — the conversation turn is reconstructable by joining on `conversation_id` through the `drafts` table.

Example: 3 regenerations then send:

| Signal # | `staff_action` | `draft_id` | `final_version` |
|---|---|---|---|
| 1 | `regenerated` | draft-001 | null |
| 2 | `regenerated` | draft-002 | null |
| 3 | `regenerated` | draft-003 | null |
| 4 | `sent_as_is` | draft-004 | "Confirmed for 3pm" |

### 6.3 Regeneration signal timing

The regeneration signal is written at the moment the "Regenerate" button is clicked, before the new LLM call is dispatched. This is preferred over writing the signal when the new draft arrives because:

- It guarantees capture even if the LLM call fails or times out.
- It accurately reflects the staff action (the decision to regenerate) rather than an LLM outcome.
- It means the signal is written before the app navigates to a loading state, when the draft context is still fully in scope.

Tradeoff: if the new LLM call fails immediately and the staff member retries by clicking Regenerate again on the same draft, a second `regenerated` signal will be written for the same `draft_id`. This is acceptable — it accurately represents two regeneration attempts.

### 6.4 Draft without `intent_classified` or `scenario_type`

In normal operation, the Client Worker (F-05) always populates both fields before the draft reaches the staff review screen. If either is null or empty (e.g., Client Worker bug, partial F-05 implementation during development):

1. The application substitutes `'unclassified'` for the missing field.
2. A warning is logged: `[learning] missing classification on signal write { draftId, missingFields }`.
3. The signal is written with the sentinel value.
4. The send action proceeds normally.

This is a defensive fallback. No send is blocked due to a missing classification.

### 6.5 Database constraint violation on `staff_action`

If application code attempts to write an invalid `staff_action` value (not in the CHECK constraint list), the database rejects the insert with a constraint violation error. The `recordDraftEditSignal` function catches this, logs it with the `draftId`, and returns `{ success: false }`. The send proceeds. The CHECK constraint prevents partial or corrupt records — if the insert is rejected, no row exists (no partial write).

### 6.6 Concurrent send (double-click protection)

If a staff member double-clicks "Send" before the Server Action completes, two signal writes may be attempted for the same `draft_id`. The `draft_edit_signals` table has no unique constraint on `draft_id` — multiple records per `draft_id` are permitted in the schema (e.g., a draft could theoretically be regenerated and then the signal re-written). However, the send flow should be protected at the UI layer (disable button after first click) and at the Server Action layer (check `drafts.staff_action IS NULL` before proceeding). F-10 does not add a unique constraint on `draft_id` since one draft can legitimately yield at most one signal in Phase 2 — but UI-layer protection is the primary guard.

### 6.7 Regeneration cap at 5

The 5-regeneration soft cap (PRD §18.4) is enforced in the UI component. The signal layer does not gate on this count. If the UI cap fails (e.g., a client-side bug), a 6th regeneration signal will be written — this is harmless and does not affect data integrity. The UI cap is a product feature, not a data integrity constraint.

---

## 7. Open Questions

**7.1 Signal write ordering (transaction vs. fire-and-forget)**

Should the signal write be part of the same database transaction as the `drafts.staff_action` UPDATE, or truly independent?

- **Option A (same transaction):** `INSERT draft_edit_signals` + `UPDATE drafts SET staff_action` in one transaction. If either fails, both roll back. Guarantees that `drafts.staff_action` is always backed by a corresponding signal row. Adds ~10-20ms of transaction overhead.
- **Option B (independent):** Signal write fires first; `drafts` UPDATE and WhatsApp dispatch follow. If the signal write fails, the draft is still updated and the message still sent — a signal gap is possible.

This spec implements Option B (the fire-and-forget pattern from US-F10-01). Option A is noted as a future tightening if data quality audits show meaningful signal gaps. Engineering to confirm before sprint start.

**7.2 Manual reply signal capture**

US-F10-03 specifies that manual replies (post-discard) do not produce a signal. Confirm with PM whether manually composed messages should ever be captured (e.g., as a `manual` staff_action variant) for completeness. This would require either a nullable `draft_id` or a separate table.

**7.3 `scenario_type` taxonomy**

The PRD defines the `scenario_type` column on the signal schema but does not enumerate valid values. Engineering and PM need to align on the scenario taxonomy (e.g., `booking_inquiry`, `faq`, `follow_up_reply`, `complaint`, `other`) before the Client Worker (F-05) populates the field. F-10 records whatever value F-05 writes; it does not validate the taxonomy.

**7.4 Regeneration signal timing confirmation**

US-F10-03 specifies the regeneration signal is written when "Regenerate" is clicked. Confirm this is preferable to writing it when the new draft arrives. Writing at click time is simpler and more reliable; writing at arrival time would allow capturing whether the LLM returned an error before writing the signal. This spec implements the click-time approach.

---

## 8. Acceptance Criteria → Tasks

### AC Coverage

| User Story | AC | Status |
|---|---|---|
| US-F10-01 | Signal written on sent_as_is | Task T-10-01 |
| US-F10-01 | Signal written on edited_and_sent | Task T-10-01 |
| US-F10-01 | Whitespace-only edit → edited_and_sent | Task T-10-01 |
| US-F10-01 | Signal failure does not block send | Task T-10-02 |
| US-F10-02 | All required fields non-null | Task T-10-03 |
| US-F10-02 | final_version null only for discard/regenerate | Task T-10-03 |
| US-F10-02 | Phase 4 fields null at creation | Task T-10-03 (schema) |
| US-F10-02 | Missing classification → sentinel + log | Task T-10-04 |
| US-F10-02 | Invalid staff_action → DB constraint violation | Task T-10-03 (schema) |
| US-F10-03 | Discard signal written immediately | Task T-10-05 |
| US-F10-03 | Manual reply after discard → no signal | Task T-10-05 |
| US-F10-03 | Regeneration chain → one signal per draft | Task T-10-06 |
| US-F10-03 | Multiple regenerations → N+1 signals | Task T-10-06 |
| US-F10-03 | Regeneration cap at 5 in UI | Task T-10-07 |

### Tasks

**T-10-01 — Send flow: signal recording for sent_as_is and edited_and_sent**

File: `src/lib/learning/record-signal.ts` (new), `src/app/(dashboard)/inbox/[conversationId]/actions.ts` (modify)

- Implement `recordDraftEditSignal()` function per §2.1 signature.
- Add step 3 to `sendDraftReply` Server Action per §2.2 sequence.
- Implement `determineStaffAction()` comparison per §4.3.
- Store `final_version` as `sentText.trim()`.
- Store `original_draft` as exact `drafts.content` (no mutation).

AC: sent_as_is signal written with matching original_draft and final_version; edited_and_sent signal written with differing strings; whitespace-only edit classified as edited_and_sent.

---

**T-10-02 — Non-blocking wrapper: signal failure does not block send**

File: `src/app/(dashboard)/inbox/[conversationId]/actions.ts`

- Wrap `recordDraftEditSignal` call in fire-and-forget pattern per §5.2.
- Verify WhatsApp dispatch (step 5) executes regardless of signal write outcome.
- Confirm no error is surfaced to the staff UI on signal failure.
- Add structured log output: `[learning] signal write failed { draftId, action, error, code }`.

AC: with Supabase temporarily unavailable (simulate via mock), send completes and message is dispatched; error appears in server logs.

---

**T-10-03 — Database migration: `draft_edit_signals` table and `drafts.scenario_type`**

File: `supabase/migrations/00X_learning_signals.sql`

- Create `draft_edit_signals` table per §3.1 DDL.
- Add CHECK constraint on `staff_action`.
- Add indexes: `idx_draft_edit_signals_workspace`, `idx_draft_edit_signals_draft`, `idx_draft_edit_signals_workspace_action`.
- Add RLS policies per §3.4 (SELECT for authenticated; no INSERT/UPDATE/DELETE for authenticated).
- Add `scenario_type TEXT` column to `drafts` table (ALTER TABLE).
- Verify that `client_replied`, `client_reply_latency_minutes`, `edit_categories`, `pattern_key` columns exist as nullable (no default) — confirms Phase 3/4 UPDATE path is open.

AC: `supabase db push` succeeds; all constraints present; `INSERT` with invalid `staff_action` value is rejected by DB; `INSERT` with valid input succeeds.

---

**T-10-04 — Sentinel fallback for missing classification fields**

File: `src/lib/learning/record-signal.ts`

- Add guard: if `intentClassified` is null or empty string, substitute `'unclassified'`.
- Add guard: if `scenarioType` is null or empty string, substitute `'unclassified'`.
- Log warning: `[learning] missing classification on signal write { draftId, missingFields }`.
- Write unit tests for both null and empty-string inputs.

AC: signal is written successfully with sentinel when draft has no classification; warning appears in logs; send is not blocked.

---

**T-10-05 — Discard flow: signal recording and no-signal for manual replies**

File: `src/app/(dashboard)/inbox/[conversationId]/actions.ts` (new `discardDraft` Server Action or modify existing)

- Implement `discardDraft` Server Action per §2.3 sequence.
- Write `discarded` signal with `final_version: null` at discard click time.
- Confirm no signal is written when staff sends a subsequent manual message.
- Confirm no WhatsApp dispatch occurs as part of the discard flow.

AC: discard signal exists in DB immediately after discard; `final_version` is null; no signal row for any subsequent manual reply by the same staff member in the same conversation.

---

**T-10-06 — Regenerate flow: signal per draft, chain integrity**

File: `src/app/(dashboard)/inbox/[conversationId]/actions.ts` (new `regenerateDraft` Server Action or modify existing)

- Implement `regenerateDraft` Server Action per §2.4 sequence.
- Write `regenerated` signal with `final_version: null` before new LLM call is enqueued.
- Verify signal references the superseded draft's `draft_id`, not the new draft's.
- Write integration test for a 3-regeneration chain: confirm 3 `regenerated` signals + 1 `sent_as_is` signal, each with distinct `draft_id`.

AC: N regenerations + 1 send = N+1 total signal rows; each references correct `draft_id`; `final_version` null on all regenerated rows.

---

**T-10-07 — UI: regeneration cap at 5**

File: `src/components/draft/DraftActions.tsx` (or equivalent draft action component)

- Query count of `staff_action = 'regenerated'` signals for the current `draft`'s conversation turn (join through `drafts.conversation_id` or query `drafts` table directly by `conversation_id` and `staff_action`).
- Disable "Regenerate" button when count >= 5.
- Show tooltip: "Regeneration limit reached for this conversation".
- Staff can still edit and send the current draft when the button is disabled.

AC: after 5 regenerations, Regenerate button is disabled with tooltip; Edit and Send remain functional; 6th regeneration is not possible via UI.

---

**T-10-08 — Unit tests for `recordDraftEditSignal`**

File: `src/lib/learning/record-signal.test.ts`

Tests to cover:
- Valid `sent_as_is` input → returns `{ success: true }`, correct fields inserted.
- Valid `edited_and_sent` input with different original/final → returns `{ success: true }`.
- Valid `regenerated` input with `final_version: null` → succeeds.
- Valid `discarded` input with `final_version: null` → succeeds.
- `sent_as_is` with `final_version: null` → error returned (invalid), no DB write attempted.
- Null `intentClassified` → sentinel substituted, write succeeds.
- Supabase insert throws → returns `{ success: false, error: ... }`, does not throw.
- Supabase insert returns error object → returns `{ success: false, error: ... }`, does not throw.

Use a mock Supabase client. No live DB required.
