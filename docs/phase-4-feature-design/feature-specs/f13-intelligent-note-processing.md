# Feature Spec — F-13: Intelligent Note Processing & Promise Tracking

**Feature:** F-13 Intelligent Note Processing & Promise Tracking
**Phase:** 3 (Operational Memory & Follow-ups)
**Size:** L (8-12 days)
**PRD Functions:** NF-02, NF-03, NF-04, NF-08
**User Stories:** US-F13-01 through US-F13-07
**Architecture modules:** `follow-up-management`, `client-relationship` (ProposeClientUpdate), `agent-governance` (confirmation cards)
**ADR dependencies:** ADR-1 (note categorization is an async LLM call), ADR-4 (promise extraction dispatches through Client Worker path), ADR-6 (pg_net async triggering)
**Depends on:** F-06 (confirmation cards / approval workflow, `ActionExecutor`, `ConfirmationRequest` builder), F-09 (note and follow-up infrastructure, notes and follow_ups tables)
**Required by:** F-11 (flush-before-compact checks `extraction_status`), F-12 (COS Operations consumes FollowUp records created by F-13)
**Last updated:** March 2026

---

## Architecture alignment note

The canonical architecture (`docs/phase-3-architecture/architecture-final.md`) establishes that AI processing is always async and never on the critical write path. F-13 is the primary consumer of this invariant for notes: the note is persisted immediately by F-09, and F-13's categorization pipeline runs afterward as a separate Edge Function invocation triggered by `pg_net`.

Key canonical decisions this spec adheres to:

- **Edge Functions, not BullMQ** -- `categorize-note` is a new Supabase Edge Function (Deno). It is invoked asynchronously after note INSERT, not inline with the save path.
- **pg_net for async triggering** -- a Postgres trigger on the `notes` table fires `pg_net.http_post()` to invoke the `categorize-note` Edge Function (same pattern as inbound message processing per ADR-6).
- **pg_cron safety net** -- a polling job catches notes stuck in `pending` status if the `pg_net` trigger fails (same safety-net pattern as `process-message`).
- **Claude Haiku for cheap/fast categorization** -- categorization and promise extraction use the same cheap model as compaction (architecture-final.md SS 6.6). Not Sonnet -- these are structured extraction tasks, not creative drafting.
- **Reuses F-06 proposed_actions flow** -- all client data changes and follow-up creations go through the existing `ProposedAction` -> confirmation card -> `approve-action` Edge Function pipeline. No new approval infrastructure.
- **Flat module structure** -- shared code in `supabase/functions/_shared/`. No bounded contexts.
- **Supabase Realtime** -- new `proposed_actions` INSERTs fire Realtime events automatically. Staff sees confirmation cards appear in the thread without polling.
- **OpenRouter for LLM calls** -- LLM calls use OpenAI-compatible SDK with OpenRouter API via the shared `llm-client.ts` module.

---

## 1. Component Breakdown

### 1.1 Edge Function -- `supabase/functions/categorize-note/index.ts`

A new Edge Function that receives a `note_id` (and `workspace_id`) in the request body, loads the note and client context, calls Claude Haiku for structured extraction, and writes the results.

**Responsibilities:**

- Validate the incoming `note_id`. Load the note record. Confirm `extraction_status = 'pending'`.
- Skip notes with `source = 'merge_history'` (these should already have `extraction_status = 'not_applicable'`, but guard defensively).
- Load the client's current profile (for before/after diffs on proposed changes).
- Load the workspace's `vertical_config.customFields` (so the LLM knows which custom fields are valid).
- Load existing open FollowUp records of type `promise` for the client (for deduplication).
- Call Claude Haiku with the categorization prompt.
- Parse the structured JSON response.
- For each extracted item, write the appropriate record:
  - **Follow-up** -> INSERT into `proposed_actions` with `action_type = 'followup_create'`, tier `review`. Goes through F-06 confirmation card flow.
  - **Promise** -> INSERT into `proposed_actions` with `action_type = 'followup_create'`, tier `review`, payload includes `type: 'promise'`.
  - **Client data change** -> INSERT into `proposed_actions` with `action_type = 'client_update'`, tier `review`, payload includes `before_state` / `after_state`.
- Set `extraction_status = 'complete'` on success (even if the note had no actionable content).
- Set `extraction_status = 'failed'` on any unrecoverable error.
- Log LLM usage to `llm_usage` table.

**Latency target:** < 10 seconds (Haiku is fast; most time is the LLM call itself at ~1-3s).

### 1.2 Trigger mechanism -- `pg_net` on note INSERT

A Postgres trigger fires after every INSERT on the `notes` table. It calls the `categorize-note` Edge Function via `pg_net.http_post()` for notes that require categorization.

```sql
-- Trigger function: invoke categorize-note Edge Function via pg_net
CREATE OR REPLACE FUNCTION trigger_note_categorization()
RETURNS TRIGGER AS $$
BEGIN
  -- Only trigger for sources that need categorization
  IF NEW.extraction_status = 'pending' THEN
    PERFORM net.http_post(
      url := current_setting('app.supabase_url')
             || '/functions/v1/categorize-note',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'note_id', NEW.id,
        'workspace_id', NEW.workspace_id,
        'client_id', NEW.client_id
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_categorize_note
  AFTER INSERT ON notes
  FOR EACH ROW
  EXECUTE FUNCTION trigger_note_categorization();
```

**Safety net -- pg_cron polling:**

```sql
-- Runs every 60 seconds. Picks up notes stuck in 'pending' for > 2 minutes.
SELECT cron.schedule(
  'retry-pending-categorization',
  '* * * * *',  -- every minute
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url')
           || '/functions/v1/categorize-note',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'note_id', n.id,
      'workspace_id', n.workspace_id,
      'client_id', n.client_id
    )
  )
  FROM notes n
  WHERE n.extraction_status = 'pending'
    AND n.created_at < now() - interval '2 minutes'
    AND n.extraction_retry_count < 3
  LIMIT 10;
  $$
);
```

The `LIMIT 10` prevents flooding the Edge Function with retries in a single cycle. The `extraction_retry_count < 3` cap prevents infinite retries.

### 1.3 Conversational context update parser -- `supabase/functions/_shared/context-update-parser.ts`

A shared module called from the note save path (F-09's API route or the `process-message` pipeline). It classifies whether staff input is an update command or a regular note **before** the note is persisted.

**Responsibilities:**

- Receive the raw staff input text.
- Apply a lightweight intent classification heuristic (regex-first, LLM-fallback).
- If classified as a context update command: return `{ isCommand: true, source: 'conversation_update', parsedIntent: { ... } }`.
- If not a command: return `{ isCommand: false }`. The note is saved with `source = 'staff_manual'` and enters the async categorization pipeline.

The heuristic checks for imperative verbs targeting known fields:

```typescript
const COMMAND_PATTERNS = [
  /^(update|change|set|modify)\s+(her|his|their|client'?s?)?\s*(name|full.?name)\s+(to|as)\s+/i,
  /^(update|change|set|modify)\s+(her|his|their|client'?s?)?\s*(phone|number|phone.?number)\s+(to|as)\s+/i,
  /^(update|change|set|modify)\s+(her|his|their|client'?s?)?\s*(email)\s+(to|as)\s+/i,
  /^(add|remove|delete)\s+tag\s+/i,
  /^(set|update|change)\s+(her|his|their|client'?s?)?\s*(\w[\w\s]*?)\s+(to|as)\s+/i,
];
```

When confidence is low (no regex match, ambiguous phrasing), the system defaults to treating input as a regular note. False negatives are acceptable (the async categorization picks them up). False positives (misinterpreting an observation as a command) are not.

### 1.4 Shared modules -- `supabase/functions/_shared/`

| File | Responsibility |
|------|----------------|
| `categorization-prompt.ts` | System prompt for Claude Haiku. Defines extraction schema, field constraints, deduplication instructions. |
| `context-update-parser.ts` | Lightweight intent classification for update commands (Section 1.3). |
| `deadline-resolver.ts` | Converts relative date references to absolute ISO dates using workspace timezone. |
| `llm-client.ts` | Existing shared module. Used with Haiku model for categorization. |
| `types/extraction.ts` | TypeScript types for categorization input/output, extraction results. |

### 1.5 Buying signal detector -- integrated into `process-message`

Buying signal detection does NOT require a new Edge Function. It runs within the existing `process-message` pipeline (F-05's Client Worker) during inbound message processing. The Client Worker's intent classification includes a `buying_signal` category that triggers follow-up proposal generation through the standard `create_followup` tool with `propose_write` authority.

No new infrastructure is needed. The enhancement is:
1. An addition to the Client Worker system prompt instructing it to detect buying signals.
2. The existing `create_followup` tool produces a `ProposedAction` with `action_type = 'followup_create'` through the F-06 flow.

---

## 2. Data Model

### 2.1 `notes` table additions

The base `notes` table is defined in architecture-final.md SS 9.1. F-13 adds columns for the async extraction pipeline:

```sql
ALTER TABLE notes
  ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'complete', 'failed', 'not_applicable')),
  ADD COLUMN extraction_retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN extraction_completed_at TIMESTAMPTZ,
  ADD COLUMN extraction_error TEXT;

-- Index for the pg_cron safety net query
CREATE INDEX idx_notes_pending_extraction
  ON notes (workspace_id, extraction_status, created_at)
  WHERE extraction_status = 'pending';

-- Index for flush-before-compact check (F-11)
CREATE INDEX idx_notes_client_pending
  ON notes (client_id, workspace_id)
  WHERE extraction_status = 'pending';
```

**Column semantics:**

| Column | Purpose |
|--------|---------|
| `extraction_status` | Lifecycle: `pending` -> `complete` or `failed`. Notes with `source = 'merge_history'` are set to `not_applicable` at INSERT time. |
| `extraction_retry_count` | Incremented on each failed attempt. Capped at 3. |
| `extraction_completed_at` | Timestamp of successful extraction. NULL until complete. |
| `extraction_error` | Last error message from a failed extraction attempt. NULL on success. Useful for debugging. |

### 2.2 `follow_ups` table addition

The base `follow_ups` table is defined in architecture-final.md SS 9.1. F-13 adds a reference back to the source note:

```sql
ALTER TABLE follow_ups
  ADD COLUMN source_note_id UUID REFERENCES notes(id);

-- Index for deduplication queries
CREATE INDEX idx_followups_client_type_open
  ON follow_ups (client_id, type)
  WHERE status IN ('open', 'pending');
```

### 2.3 `proposed_actions` table addition

The base `proposed_actions` table is defined in architecture-final.md SS 9.1 and extended by F-06. F-13 adds a reference to the source note (for actions that originate from note categorization rather than from the Client Worker):

```sql
ALTER TABLE proposed_actions
  ADD COLUMN source_note_id UUID REFERENCES notes(id);
```

This enables the UI to trace any proposed change back to the note that triggered it.

### 2.4 `proposed_actions.payload` shapes (F-13-specific)

**`client_update` from note categorization:**
```typescript
{
  before_state: { full_name: 'Elizabeth Chen' },
  after_state: { full_name: 'Liz Chen' },
  changed_fields: ['full_name'],
  extraction_source: 'note_categorization',
  source_note_id: 'note-uuid'
}
```

**`client_update` for preference change:**
```typescript
{
  before_state: { preferences: { preferred_time: 'afternoons' } },
  after_state: { preferences: { preferred_time: 'mornings' } },
  changed_fields: ['preferences.preferred_time'],
  extraction_source: 'note_categorization',
  source_note_id: 'note-uuid'
}
```

**`followup_create` for follow-up extraction:**
```typescript
{
  type: 'follow_up',
  description: 'Follow up about wedding quote',
  due_date: '2026-03-20',       // absolute date, or null
  source_note_id: 'note-uuid',
  extraction_source: 'note_categorization'
}
```

**`followup_create` for promise extraction:**
```typescript
{
  type: 'promise',
  description: 'Send revised quote to client',
  due_date: '2026-03-20',
  source_note_id: 'note-uuid',
  extraction_source: 'note_categorization'
}
```

**`followup_create` for buying signal:**
```typescript
{
  type: 'follow_up',
  description: 'Client inquired about deep tissue massage pricing -- follow up to convert to booking',
  due_date: '2026-03-21',       // default: 3 business days from detection
  extraction_source: 'buying_signal'
}
```

---

## 3. LLM Integration -- Claude Haiku for Categorization

### 3.1 Model selection

| Parameter | Value |
|-----------|-------|
| Model | `claude-haiku-3-20240307` (or latest Haiku) |
| Max output tokens | 2,000 |
| Temperature | 0.1 (low creativity, high precision for structured extraction) |
| Cost estimate | ~$0.001 per note (1.5K input + 1K output at Haiku pricing) |

### 3.2 System prompt -- `categorization-prompt.ts`

```typescript
const CATEGORIZATION_SYSTEM_PROMPT = `You are a CRM note categorization engine. Your job is to analyze a staff note about a client and extract structured, actionable items.

You will receive:
- The note text written by a staff member
- The client's current profile (name, phone, email, tags, preferences, lifecycle_status)
- The workspace's custom field definitions
- Today's date and workspace timezone
- A list of existing open promises for this client (for deduplication)

Extract ALL of the following that apply:

1. **FOLLOW_UPS**: Tasks the staff needs to do (e.g., "follow up about wedding quote", "call back about fitting"). These are NOT promises.
2. **PROMISES**: Commitments made BY staff or the business TO the client (e.g., "I promised her 10% off", "we'll have alterations ready by Tuesday"). Only extract from staff-side commitments, not client requests.
3. **CLIENT_UPDATES**: Changes to the client's profile data. Only propose changes to these fields:
   - full_name
   - phone_number (normalize to E.164 format)
   - email
   - tags (add or remove)
   - preferences (including custom fields listed in the workspace config)
   - lifecycle_status
   Do NOT propose changes to fields not in this list (e.g., balances, pricing, internal IDs).

For each extracted item, include:
- A clear, concise description
- The category (FOLLOW_UP, PROMISE, or CLIENT_UPDATE)
- For follow-ups and promises: a due_date if a temporal reference exists, or null if none
- For client updates: the field name, current value (before_state), and proposed value (after_state)

DEDUPLICATION: Compare any detected promises against the existing open promises list provided. If a promise is semantically equivalent to an existing one, do NOT re-extract it. Mark it as "duplicate" in your response.

DATE RESOLUTION: When the note contains relative date references ("by Friday", "next week", "tomorrow"), resolve them to absolute ISO 8601 dates (YYYY-MM-DD) using the provided current date and timezone. If the reference is too vague ("soon", "sometime"), set due_date to null.

If the note contains NO actionable items, return an empty extractions array. This is a valid outcome.

Respond with ONLY valid JSON matching this schema. No preamble, no commentary.`;
```

### 3.3 User message structure

```typescript
type CategorizationInput = {
  note_content: string;
  note_created_at: string;       // ISO timestamp
  client_profile: {
    full_name: string | null;
    phone_number: string | null;
    email: string | null;
    tags: string[];
    preferences: Record<string, unknown>;
    lifecycle_status: string;
  };
  workspace_custom_fields: string[];   // from vertical_config.customFields
  current_date: string;                // ISO date in workspace timezone
  workspace_timezone: string;
  existing_open_promises: Array<{
    content: string;
    due_date: string | null;
  }>;
};
```

The user message is formatted as:

```
Note text:
"{note_content}"

Note saved at: {note_created_at}
Today's date: {current_date}
Timezone: {workspace_timezone}

Client profile:
- Name: {full_name}
- Phone: {phone_number}
- Email: {email}
- Tags: {tags}
- Preferences: {preferences as JSON}
- Lifecycle status: {lifecycle_status}

Workspace custom fields: {workspace_custom_fields}

Existing open promises for this client:
{existing_open_promises as list, or "None"}

Extract all actionable items from the note.
```

### 3.4 Expected response schema

```typescript
type CategorizationResponse = {
  extractions: Array<
    | {
        category: 'FOLLOW_UP';
        description: string;
        due_date: string | null;    // ISO date or null
      }
    | {
        category: 'PROMISE';
        description: string;
        due_date: string | null;
        is_duplicate: boolean;       // true if semantically matches an existing promise
      }
    | {
        category: 'CLIENT_UPDATE';
        field: string;               // e.g., 'full_name', 'preferences.preferred_time', 'tags'
        before_value: unknown;
        after_value: unknown;
      }
  >;
};
```

### 3.5 Response validation

After parsing the LLM's JSON response, validate:

1. **Schema conformance**: the response matches `CategorizationResponse` (use Zod for runtime validation).
2. **Field allowlist**: for `CLIENT_UPDATE` extractions, verify the `field` is in the updatable field set (`full_name`, `phone_number`, `email`, `tags`, `preferences.*`, `lifecycle_status`). Reject extractions targeting unknown fields.
3. **Duplicate filtering**: discard any `PROMISE` extraction where `is_duplicate = true`.
4. **Date validity**: if `due_date` is present, verify it is a valid ISO 8601 date string.

If the entire response is unparseable (not valid JSON, wrong schema), the categorization is marked as `failed`. No partial records are created.

### 3.6 LLM usage logging

After every categorization call, log to `llm_usage`:

```typescript
await logLLMUsage(supabase, {
  workspaceId,
  clientId,
  edgeFunctionName: 'categorize-note',
  model: 'claude-haiku-3-20240307',
  tokensIn: response.usage.input_tokens,
  tokensOut: response.usage.output_tokens,
  latencyMs,
  costUsd: calculateCost('haiku', response.usage),
});
```

---

## 4. Promise Extraction

### 4.1 Two extraction paths

Promises are detected through two distinct paths:

| Path | Trigger | Source data | Runtime |
|------|---------|-------------|---------|
| **Note categorization** (primary) | Note INSERT -> `categorize-note` Edge Function | Note content | Haiku, async |
| **Conversation message scan** | Client Worker processes inbound/outbound message | Message content | Sonnet (already running for draft generation), inline |

For the **note categorization** path, promise extraction is part of the same Haiku LLM call that handles follow-up and client update extraction (Section 3). No separate LLM call is needed.

For the **conversation message** path, promise extraction is an additional instruction in the Client Worker's system prompt. When the Client Worker detects a staff-sent message containing a commitment, it calls the `create_followup` tool with `type: 'promise'`. This goes through the standard F-06 approval flow.

### 4.2 Promise vs. follow-up distinction

| | Promise | Follow-up |
|---|---------|-----------|
| **Definition** | Commitment made BY staff/business TO the client | Task the staff needs to do |
| **`type` field** | `'promise'` | `'follow_up'` |
| **Example** | "I'll send the quote by Friday" | "Follow up about the wedding dress order" |
| **COS priority** | Higher urgency (broken promise = reputation risk) | Standard urgency |
| **Source** | Staff-sent messages and staff notes only | Any source |

The LLM prompt (Section 3.2) explicitly instructs the model to distinguish between these two categories. Client requests ("Can you send me the quote?") are not promises.

### 4.3 Semantic deduplication

Before creating a promise `ProposedAction`, the categorization function checks for semantic duplicates among existing open promises for the same client.

**Deduplication strategy:**

1. The Haiku prompt receives the list of existing open promises (Section 3.3).
2. The LLM marks each extracted promise as `is_duplicate: true/false` based on semantic equivalence.
3. The categorization function discards duplicates before creating `ProposedAction` records.

This is an LLM-based deduplication, not string matching. "Send the revised quote by Friday" and "Email her the updated quote before end of week" are semantically equivalent and should be deduplicated.

**Fallback guard:** if the LLM fails to flag a duplicate, an application-level check compares the new promise's description against existing open promises using substring overlap (> 60% token overlap = potential duplicate, logged as warning but still created). This is a soft guard, not a hard block.

---

## 5. Buying Signal Detection

### 5.1 Integration point

Buying signal detection runs inside the existing `process-message` Edge Function (F-05's Client Worker), not as a separate job. The enhancement is purely prompt-level.

### 5.2 Client Worker prompt addition

Add to the Client Worker's system prompt:

```
BUYING SIGNAL DETECTION:
When a client's message contains any of the following, it may be a buying signal:
- Questions about pricing, cost, or fees
- Questions about availability, openings, or scheduling
- Comparisons between services or service tiers
- Requests for more details about a specific service
- Expressions of intent ("I'm thinking about...", "I'd like to...")

When you detect a buying signal:
1. Respond to the client's question normally in your draft.
2. ALSO call the create_followup tool with:
   - description: A concise note capturing what the client is interested in and a suggestion to follow up to convert to a booking.
   - due_date: 3 business days from today (to follow up before the lead cools).
   - type: "follow_up"

Do NOT create a buying signal follow-up if:
- The message is a general thank-you or social pleasantry.
- An open follow-up already exists for this client about the same service/topic.
- The client has already booked the service in question.
```

### 5.3 Deduplication

The Client Worker receives open follow-ups in context assembly (architecture-final.md SS 6.2, "Active items" slot). The prompt instructs the LLM to check for existing follow-ups before proposing a new one. As an application-level guard, the `approve-action` Edge Function can also check for duplicates before executing a `followup_create` action.

### 5.4 Suggested due date

Default: 3 business days from detection. The calculation skips Saturdays and Sundays (simple heuristic; no holiday calendar for MVP). Staff can modify the due date when approving the confirmation card.

```typescript
function addBusinessDays(from: Date, days: number, timezone: string): string {
  let current = new Date(from);
  let added = 0;
  while (added < days) {
    current.setDate(current.getDate() + 1);
    const dayOfWeek = current.getDay(); // 0=Sun, 6=Sat
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      added++;
    }
  }
  return current.toISOString().split('T')[0]; // YYYY-MM-DD
}
```

---

## 6. Confirmation Cards -- Reuse of F-06

### 6.1 Flow

F-13 creates `ProposedAction` records that enter the existing F-06 pipeline. No new confirmation card infrastructure is needed.

```
categorize-note Edge Function
        |
        v
Parse LLM response -> list of extractions
        |
        v
For each extraction:
  +-- CLIENT_UPDATE:
  |     Build payload with before_state / after_state
  |     INSERT INTO proposed_actions (
  |       action_type = 'client_update',
  |       tier = 'review',
  |       source_note_id = note.id,
  |       summary = "Update client [field]",
  |       payload = { before_state, after_state, changed_fields }
  |     )
  |     ** Realtime INSERT event -> staff sees confirmation card
  |
  +-- FOLLOW_UP or PROMISE:
        Build payload with description, due_date, type
        INSERT INTO proposed_actions (
          action_type = 'followup_create',
          tier = 'review',
          source_note_id = note.id,
          summary = "Create [follow-up|promise]: [description]",
          payload = { type, description, due_date }
        )
        ** Realtime INSERT event -> staff sees confirmation card
```

### 6.2 Approval execution

When staff approves:

- **`client_update`**: F-06's `ActionExecutor.executeClientUpdate()` applies the change to the `clients` table. The handler already supports `full_name`, `phone_number`, `email`, `tags`, `preferences`, and `lifecycle_status` (established in F-06 spec SS 2.3).
- **`followup_create`**: F-06's `ActionExecutor.executeFollowUpCreate()` INSERTs into the `follow_ups` table. F-13 adds `source_note_id` to the INSERT payload.

### 6.3 Multiple extractions from one note

A single note may produce multiple `ProposedAction` records (e.g., a name change, a preference update, a promise, and a follow-up). Each is an independent confirmation card. Staff can approve or reject each independently. The note's `extraction_status` is set to `complete` after all `ProposedAction` records are written, regardless of whether staff has acted on them yet.

### 6.4 Conversation context update cards

When the context update parser (Section 1.3) detects a command:

1. The note is saved with `source = 'conversation_update'`.
2. `extraction_status` is set to `'not_applicable'` (the command was parsed synchronously, not by the async pipeline).
3. A `ProposedAction` is created immediately (not via the categorize-note Edge Function).
4. The confirmation card appears in the thread within 1-2 seconds of the staff input.

This is the "fast path" for explicit data corrections. The LLM is not involved for high-confidence regex matches.

---

## 7. Deadline Inference -- `deadline-resolver.ts`

### 7.1 Responsibility

Converts relative temporal references to absolute ISO 8601 dates. Called from within the categorization LLM response (the LLM does the resolution) and validated by application code.

### 7.2 LLM-driven resolution

Date resolution is part of the Haiku LLM call (Section 3). The prompt provides:
- `current_date` (ISO date in workspace timezone)
- `workspace_timezone`
- `note_created_at` (timestamp of the source note)

The LLM outputs absolute dates directly. The application validates the output.

### 7.3 Application-level validation

```typescript
function validateResolvedDate(
  dueDate: string | null,
  noteCreatedAt: Date,
  workspaceTimezone: string
): { date: string | null; isOverdue: boolean } {
  if (!dueDate) return { date: null, isOverdue: false };

  // Validate ISO format
  const parsed = new Date(dueDate);
  if (isNaN(parsed.getTime())) {
    console.warn('[deadline] LLM returned invalid date', { dueDate });
    return { date: null, isOverdue: false };
  }

  // Check if the date is in the past
  const today = getCurrentDateInTimezone(workspaceTimezone);
  const isOverdue = parsed < today;

  return { date: dueDate, isOverdue };
}
```

### 7.4 Resolution rules

| Temporal reference | Resolution | Example (today = Wed 2026-03-18) |
|-------------------|------------|-----------------------------------|
| "Friday" / "by Friday" | Nearest upcoming Friday | 2026-03-20 |
| "next Thursday" | Thursday of the following week | 2026-03-26 |
| "tomorrow" | Day after note timestamp | 2026-03-19 |
| "end of week" | Friday of current week | 2026-03-20 |
| "in two weeks" | 14 days from note date | 2026-04-01 |
| "March 28" | Literal date (current year assumed) | 2026-03-28 |
| "soon" / "sometime" | null (too vague) | null |
| Past reference ("last Monday") | Literal past date | 2026-03-16 (marked overdue) |

### 7.5 Timezone handling

All date resolution uses the workspace timezone, not UTC. "Tomorrow" at 11 PM UTC means different dates depending on the workspace timezone. The LLM receives the timezone name (e.g., "Europe/London", "Asia/Tokyo") and resolves accordingly.

### 7.6 Overdue on creation

If the resolved `due_date` is before today (workspace time), the FollowUp is created with `status = 'overdue'` instead of `'open'`. This ensures it appears immediately in the COS overdue items list (F-12).

---

## 8. Edge Cases

### 8.1 Categorization failure

| Failure mode | Behavior |
|--------------|----------|
| LLM timeout / API error / rate limit | `extraction_status = 'failed'`, `extraction_retry_count` incremented. pg_cron safety net retries. |
| LLM returns unparseable output (not JSON) | `extraction_status = 'failed'`, raw response logged in `extraction_error`. No partial records created. |
| LLM returns valid JSON with invalid field references | Invalid extractions are silently dropped. Valid ones are processed. If ALL extractions are invalid, note is still marked `complete` (the LLM successfully processed it, just found nothing actionable after validation). |
| pg_net trigger fails to fire | pg_cron safety net picks up the note (pending for > 2 min) within the next minute. |

### 8.2 Retry policy

- **Maximum retries:** 3 automatic (via pg_cron safety net).
- **Backoff:** The pg_cron job runs every minute, but `extraction_retry_count` is checked. The retry happens on the next pg_cron tick after the 2-minute staleness window. Effective backoff is ~2-3 minutes between attempts.
- **After exhaustion:** `extraction_status` remains `'failed'`. An alert-level log is emitted. The note remains readable as raw text. Staff can manually trigger retry (sets `extraction_status = 'pending'` and `extraction_retry_count = 0`).

```typescript
// In categorize-note Edge Function
async function processNote(supabase: SupabaseClient, noteId: string) {
  const { data: note } = await supabase
    .from('notes')
    .select('*')
    .eq('id', noteId)
    .eq('extraction_status', 'pending')
    .single();

  if (!note) return; // Already processed or not found

  try {
    // ... LLM call and record creation ...
    await supabase.from('notes').update({
      extraction_status: 'complete',
      extraction_completed_at: new Date().toISOString(),
      extraction_error: null,
    }).eq('id', noteId);
  } catch (error) {
    const newRetryCount = note.extraction_retry_count + 1;
    await supabase.from('notes').update({
      extraction_status: newRetryCount >= 3 ? 'failed' : 'pending',
      extraction_retry_count: newRetryCount,
      extraction_error: error.message,
    }).eq('id', noteId);

    if (newRetryCount >= 3) {
      console.error('[categorization] max retries exhausted', {
        noteId,
        workspaceId: note.workspace_id,
        error: error.message,
      });
    }
  }
}
```

### 8.3 Duplicate proposed actions

A note may be processed twice if the pg_cron safety net fires concurrently with the pg_net trigger. Guard against this:

1. At the start of `processNote`, atomically set `extraction_status = 'processing'` using a conditional update:

```sql
UPDATE notes
SET extraction_status = 'processing'
WHERE id = $1
  AND extraction_status = 'pending'
RETURNING *;
```

If zero rows are returned, another invocation is already handling this note. Return immediately.

2. On success, set `extraction_status = 'complete'`. On failure, set back to `pending` (if retries remain) or `failed`.

This "optimistic lock" pattern prevents duplicate extraction from concurrent invocations.

### 8.4 Note with no actionable content

This is the most common outcome. A note like "Had a nice chat, she seems happy" produces an empty `extractions` array. The note's `extraction_status` is set to `complete`. No `ProposedAction` or `FollowUp` records are created. This is a normal, expected result -- not an error.

### 8.5 Conversational context update failure

If the context update parser's intent classification fails (LLM error on the fallback path), the input is saved as a regular note with `source = 'staff_manual'` and `extraction_status = 'pending'`. The async categorization pipeline processes it normally. Staff sees a brief inline message: "Saved as note. Update could not be processed -- will retry."

### 8.6 Very long note content

Notes over 3,000 characters are truncated to 3,000 characters before being sent to the LLM. A warning is logged. The full note content remains in the database.

### 8.7 Flush-before-compact integration (F-11)

Only `pending` status blocks compaction. `failed` and `processing` do not block -- the raw note text is still available for the compaction LLM to include. The integration point is F-11's `checkPendingExtractions` query (F-11 spec SS 5.2) which queries `extraction_status = 'pending'`.

To handle the transient `processing` status: compaction treats `processing` the same as `pending` (blocks compaction). If a note is stuck in `processing` for > 5 minutes, the pg_cron safety net resets it to `pending`.

```sql
-- Add to the pg_cron safety net: reset stuck 'processing' notes
UPDATE notes
SET extraction_status = 'pending'
WHERE extraction_status = 'processing'
  AND updated_at < now() - interval '5 minutes';
```

---

## 9. Categorize-Note Edge Function -- Full Pipeline

```
categorize-note Edge Function receives { note_id, workspace_id, client_id }
        |
        v
1. Load note record WHERE id = note_id AND extraction_status = 'pending'
   (optimistic lock: SET extraction_status = 'processing')
   If 0 rows: return (already handled)
        |
        v
2. Guard: if note.source = 'merge_history', set 'not_applicable', return
        |
        v
3. Load client profile (full_name, phone, email, tags, preferences, lifecycle_status)
   Load workspace vertical_config.customFields
   Load existing open promises for this client
        |
        v
4. Build categorization input (Section 3.3)
        |
        v
5. Call Claude Haiku with CATEGORIZATION_SYSTEM_PROMPT + user message
   Start timer for latency tracking
        |
        v
6. Parse JSON response. Validate with Zod schema.
   If parse fails: set 'failed', log raw response, return
        |
        v
7. Validate each extraction:
   - CLIENT_UPDATE: field must be in updatable set
   - PROMISE: filter out is_duplicate = true
   - FOLLOW_UP / PROMISE: validate due_date format
   Drop invalid extractions (log warning)
        |
        v
8. For each valid extraction:
   INSERT INTO proposed_actions (
     workspace_id, client_id, source_note_id,
     action_type, summary, tier = 'review',
     payload, status = 'pending'
   )
   ** Realtime fires: staff sees confirmation card
        |
        v
9. UPDATE notes SET extraction_status = 'complete',
   extraction_completed_at = now(),
   extraction_error = null
   WHERE id = note_id
        |
        v
10. Log LLM usage to llm_usage table
        |
        v
11. Return { success: true, extractions_count: N }
```

---

## 10. Acceptance Criteria to Tasks

### Task 1: Database migrations (US-F13-01, US-F13-02, US-F13-04)
- [ ] Add `extraction_status`, `extraction_retry_count`, `extraction_completed_at`, `extraction_error` columns to `notes` table
- [ ] Add `idx_notes_pending_extraction` partial index
- [ ] Add `idx_notes_client_pending` partial index for flush-before-compact
- [ ] Add `source_note_id` column to `follow_ups` table
- [ ] Add `source_note_id` column to `proposed_actions` table
- [ ] Add `idx_followups_client_type_open` partial index for deduplication

### Task 2: pg_net trigger and pg_cron safety net (US-F13-01, US-F13-07)
- [ ] Create `trigger_note_categorization()` Postgres function
- [ ] Create `trg_categorize_note` trigger on `notes` table (AFTER INSERT)
- [ ] Verify trigger only fires for `extraction_status = 'pending'`
- [ ] Create `retry-pending-categorization` pg_cron job (every minute)
- [ ] Verify pg_cron respects `extraction_retry_count < 3` cap
- [ ] Verify pg_cron resets stuck `processing` notes after 5 minutes

### Task 3: Categorize-note Edge Function (US-F13-01, US-F13-04)
- [ ] Create `supabase/functions/categorize-note/index.ts`
- [ ] Implement optimistic lock (`pending` -> `processing` transition)
- [ ] Load note, client profile, workspace config, existing promises
- [ ] Call Claude Haiku with categorization prompt
- [ ] Parse and validate LLM JSON response with Zod
- [ ] Create `ProposedAction` records for each valid extraction
- [ ] Set `extraction_status = 'complete'` on success
- [ ] Handle failure: increment retry count, set error message
- [ ] Log LLM usage to `llm_usage` table

### Task 4: Categorization prompt (US-F13-01, US-F13-04, US-F13-06)
- [ ] Implement `supabase/functions/_shared/categorization-prompt.ts`
- [ ] Define `CategorizationResponse` Zod schema in `types/extraction.ts`
- [ ] Include field allowlist in prompt (updatable fields only)
- [ ] Include deduplication instructions for promises
- [ ] Include date resolution instructions with timezone context
- [ ] Verify prompt handles notes with no actionable content (empty array)

### Task 5: Confirmation card integration (US-F13-02)
- [ ] Verify `ProposedAction` records from note categorization render as confirmation cards (reuse F-06 UI)
- [ ] Verify `client_update` cards show before/after diff (name, phone, email, tags, preferences, lifecycle_status)
- [ ] Verify `followup_create` cards show follow-up/promise description and due date
- [ ] Verify multiple cards from one note are independently actionable
- [ ] Verify `source_note_id` is passed through to `follow_ups` table on approval

### Task 6: Conversational context update parser (US-F13-03)
- [ ] Implement `supabase/functions/_shared/context-update-parser.ts`
- [ ] Implement regex-based command detection for known fields
- [ ] Handle ambiguous input: default to regular note when confidence is low
- [ ] Create `ProposedAction` directly for detected commands (bypass async pipeline)
- [ ] Save note with `source = 'conversation_update'`, `extraction_status = 'not_applicable'`
- [ ] Phone number normalization to E.164 for phone updates
- [ ] Handle multiple commands in one input (e.g., "update name to X and set preference to Y")
- [ ] Graceful fallback on parse failure: save as regular note with `extraction_status = 'pending'`

### Task 7: Buying signal detection (US-F13-05)
- [ ] Add buying signal detection instructions to Client Worker system prompt
- [ ] Verify `create_followup` tool is called with `type: 'follow_up'` and relevant description
- [ ] Implement `addBusinessDays` utility for default 3-business-day due date
- [ ] Verify deduplication against existing open follow-ups in context assembly
- [ ] Verify general conversation ("thanks, great service") does NOT trigger a buying signal

### Task 8: Deadline inference and validation (US-F13-06)
- [ ] Implement `supabase/functions/_shared/deadline-resolver.ts` (validation layer)
- [ ] Verify LLM resolves relative dates correctly (Friday, next Thursday, tomorrow, end of week, in two weeks)
- [ ] Verify specific dates are used as-is (March 28)
- [ ] Verify vague references result in null due_date
- [ ] Verify past dates result in `status = 'overdue'` on the FollowUp
- [ ] Verify timezone-aware resolution (workspace timezone, not UTC)

### Task 9: Retry and resilience (US-F13-07)
- [ ] Verify note save is never blocked by categorization failure
- [ ] Verify `extraction_status` transitions: pending -> processing -> complete / failed
- [ ] Verify automatic retry up to 3 times via pg_cron safety net
- [ ] Verify no retries after max attempts exhausted
- [ ] Verify malformed LLM response creates no partial records
- [ ] Verify concurrent invocations are handled by optimistic lock (zero-row UPDATE)
- [ ] Verify manual retry resets `extraction_status` to `pending` and `extraction_retry_count` to 0
- [ ] Verify staff UI shows "Retry" option for failed notes

### Task 10: Integration tests
- [ ] Note save triggers async categorization within 5 seconds
- [ ] Multi-extraction note: name change + preference + promise + follow-up all create separate ProposedAction records
- [ ] Staff approves name change -> `clients.full_name` updated
- [ ] Staff rejects preference change -> no data modified
- [ ] Promise with deadline "by Friday" -> FollowUp with correct absolute date
- [ ] Promise without deadline -> FollowUp with null due_date
- [ ] Duplicate promise is not re-extracted
- [ ] Buying signal from client message -> follow-up suggestion confirmation card
- [ ] General conversation -> no buying signal follow-up
- [ ] Context update command "update name to X" -> immediate confirmation card (< 2s)
- [ ] Ambiguous input -> saved as regular note, processed by async pipeline
- [ ] LLM failure -> note stays intact, retried automatically
- [ ] Flush-before-compact: pending extraction blocks compaction (F-11 integration)
- [ ] Failed extraction does NOT block compaction
