# Feature Spec — F-15: Learning Loop & Communication Rules

**Feature:** F-15
**Phase:** 4 (Refinement & Learning)
**Size:** XL (2+ weeks)
**PRD Functions:** LL-03, LL-04, LL-05, LL-06, LL-07, LL-08
**User Stories:** US-F15-01 through US-F15-08
**Architecture modules:** `learning-optimization` (ClassifyDraftEdits, UpdatePatternRecurrence, PromoteToCommunicationRule, CommunicationRule, WorkspaceCommunicationProfile)
**ADR Dependencies:** ADR-1 (rules injected into single-agent context, not as a separate agent), ADR-3 (rules are part of global context assembled deterministically)
**Prerequisite features:** F-10 (Learning Signal Capture), F-14 (Draft Acceptance Metrics), F-05 (Context Assembly)
**Last updated:** March 2026

---

## Architecture alignment note

The final locked architecture (`docs/phase-3-architecture/architecture-final.md`) explicitly deferred learning loop analysis from Phase 2:

> "Learning loop analysis deferred (signal recording only in Phase 2)"
> "Record the data now. Build the analysis when you have enough signals."

This spec implements the full analysis pipeline. Phase 2 (F-10) established the `draft_edit_signals` table and the signal recording path. Phase 3 (F-14) added acceptance metric aggregation. F-15 builds everything on top: classification, recurrence tracking, promotion, rule injection, and the staff management UI.

The architecture stores the communication profile as `communication_profile JSONB` on the `workspaces` table (architecture-final.md section 9.1). This spec replaces that denormalized JSONB approach with dedicated normalized tables (`edit_classifications`, `pattern_recurrences`, `communication_rules`) for queryability and auditability. The `workspaces.communication_profile` column is retained only as a cached snapshot for context assembly performance.

---

## 1. Overview

F-15 closes the learning loop. It transforms raw `draft_edit_signals` data into workspace-level communication rules that improve all future AI drafts. The pipeline has five stages, each implemented as a distinct module:

1. **Classify** — An async Edge Function worker classifies staff edits using Claude Haiku (edit categories + stable pattern key).
2. **Track** — Recurrence counts and distinct client counts are updated per pattern.
3. **Promote** — Deterministic application code checks whether a pattern meets the threshold (3+ occurrences, 2+ clients, 30-day window).
4. **Create Rule** — A one-time LLM call generates a human-readable instruction from representative edit examples.
5. **Inject** — Active rules are loaded into the global context section of every Client Worker invocation.

Staff can view, edit, and disable rules in Settings. The "always do this" flag provides an escape hatch for immediate promotion from a single edit.

---

## 2. Component Breakdown

### 2.1 `classify-edits` Edge Function (`supabase/functions/classify-edits/index.ts`)

Async worker that processes unclassified `draft_edit_signals`. This is a new Edge Function (the fifth, alongside `process-message`, `approve-action`, `daily-cron`, `embed-knowledge`).

**Trigger:** pg_cron poll every 5 minutes, or pg_net async call when a new `edited_and_sent` signal is inserted.

**Responsibilities:**
- Dequeue unclassified signals (batch of up to 10).
- For each signal: invoke Claude Haiku with the classification prompt.
- Parse the LLM response into edit categories, severity, pattern key, and analysis notes.
- Write the `edit_classifications` row.
- Update or create the `pattern_recurrences` row.
- Run the promotion threshold check.
- If promoted: invoke Claude Haiku again to generate the rule instruction, then create the `communication_rules` row.
- Log LLM usage to `llm_usage` for every Haiku call.

**Latency:** No user-facing latency constraint. The worker runs async after the staff send flow completes. Target: < 30 seconds per signal (dominated by LLM call latency).

**Concurrency:** Single worker per workspace. The pg_cron trigger fires globally; the function acquires an advisory lock per workspace (`pg_try_advisory_lock(hashtext('classify_edits:' || workspace_id))`) to prevent duplicate processing.

### 2.2 Pattern tracking module (`supabase/functions/_shared/pattern-tracking.ts`)

Shared module used by `classify-edits`. Contains:

- `updatePatternRecurrence(workspaceId, patternKey, category, clientId, signalCreatedAt)` — upserts the `pattern_recurrences` row with atomic increment and distinct client recalculation.
- `checkPromotionThreshold(recurrence)` — pure function returning `{ shouldPromote: boolean, reason: string }` based on the three threshold criteria.
- `calculateConfidence(recurrenceCount)` — `min(1.0, recurrenceCount / 10)`.

### 2.3 Rule management API routes (Next.js)

Staff-facing CRUD for communication rules. These are Next.js API routes (not Edge Functions) because they serve the staff app directly.

| Route | Method | Purpose |
|---|---|---|
| `/api/rules` | GET | List all rules for workspace (active + disabled) |
| `/api/rules/:ruleId` | PATCH | Update instruction text or active status |
| `/api/rules/:ruleId/details` | GET | Fetch rule details including source pattern and example edits |

All routes use the Supabase client with RLS (`auth.workspace_id()`). No service-role bypass needed.

### 2.4 Context assembly integration (`supabase/functions/_shared/context-assembly.ts`)

Modification to the existing `assembleContext()` function (F-05). Adds a `loadCommunicationRules(workspaceId)` step that queries active rules ordered by confidence DESC, truncated to the ~500 token budget.

### 2.5 Settings UI components (Next.js)

| Component | File | Purpose |
|---|---|---|
| `CommunicationRulesPage` | `src/app/(dashboard)/settings/rules/page.tsx` | List view with toggle, edit, and expand |
| `RuleCard` | `src/components/settings/RuleCard.tsx` | Individual rule display with inline edit |
| `RuleDetailPanel` | `src/components/settings/RuleDetailPanel.tsx` | Expanded view with source pattern and example edits |
| `AlwaysDoThisCheckbox` | `src/components/draft/AlwaysDoThisCheckbox.tsx` | Checkbox in draft send flow |

### 2.6 "Always do this" flag integration

UI addition to the draft review panel (F-05 thread page). When staff edits a draft and is about to send, an "Always do this" checkbox appears. Checking it adds `always_do_this = true` to the `draft_edit_signals` record. The `classify-edits` worker processes these signals with priority (fetched before non-flagged signals in the batch query).

---

## 3. Data Model

### 3.1 `edit_classifications` table

```sql
CREATE TABLE edit_classifications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID        NOT NULL REFERENCES workspaces(id),
  signal_id       UUID        NOT NULL REFERENCES draft_edit_signals(id),
  edit_categories TEXT[]      NOT NULL,    -- subset of EditCategory enum
  severity        TEXT        NOT NULL,    -- 'minor', 'significant', 'rewrite'
  pattern_keys    TEXT[]      NOT NULL,    -- one or more stable keys
  analysis_notes  TEXT,                    -- LLM explanation of detected changes
  llm_model       TEXT        NOT NULL,    -- 'claude-haiku-...'
  llm_latency_ms  INTEGER     NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_edit_classifications_signal
  ON edit_classifications(signal_id);  -- one classification per signal

CREATE INDEX idx_edit_classifications_workspace
  ON edit_classifications(workspace_id, created_at DESC);
```

### 3.2 `pattern_recurrences` table

```sql
CREATE TABLE pattern_recurrences (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID        NOT NULL REFERENCES workspaces(id),
  pattern_key      TEXT        NOT NULL,
  category         TEXT        NOT NULL,    -- primary EditCategory
  recurrence_count INTEGER     NOT NULL DEFAULT 1,
  distinct_clients INTEGER     NOT NULL DEFAULT 1,
  client_ids       UUID[]      NOT NULL DEFAULT '{}',  -- for distinct count recalc
  first_seen       TIMESTAMPTZ NOT NULL,
  last_seen        TIMESTAMPTZ NOT NULL,
  promoted         BOOLEAN     NOT NULL DEFAULT false,
  promoted_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, pattern_key)
);

CREATE INDEX idx_pattern_recurrences_workspace
  ON pattern_recurrences(workspace_id, promoted, recurrence_count DESC);
```

### 3.3 `communication_rules` table

```sql
CREATE TABLE communication_rules (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID        NOT NULL REFERENCES workspaces(id),
  category            TEXT        NOT NULL,    -- EditCategory
  instruction         TEXT        NOT NULL,    -- human-readable rule for LLM context
  confidence          REAL        NOT NULL,    -- 0.0-1.0
  source_pattern_key  TEXT        NOT NULL,
  source_type         TEXT        NOT NULL DEFAULT 'auto',  -- 'auto' | 'staff_flagged'
  example_edits       JSONB,                  -- 2-3 representative original/final pairs snapshotted at promotion time
  active              BOOLEAN     NOT NULL DEFAULT true,
  promoted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, source_pattern_key)
);

CREATE INDEX idx_communication_rules_active
  ON communication_rules(workspace_id, active, confidence DESC)
  WHERE active = true;
```

### 3.4 Schema addition to `draft_edit_signals`

The existing `draft_edit_signals` table (from F-10) needs three new columns:

```sql
ALTER TABLE draft_edit_signals
  ADD COLUMN edit_categories  TEXT[],           -- back-populated by classifier
  ADD COLUMN pattern_key      TEXT,             -- back-populated by classifier
  ADD COLUMN always_do_this   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN processed_at     TIMESTAMPTZ;      -- set when classification completes

CREATE INDEX idx_signals_unprocessed
  ON draft_edit_signals(workspace_id, created_at)
  WHERE staff_action = 'edited_and_sent'
    AND processed_at IS NULL;

CREATE INDEX idx_signals_always_do_this
  ON draft_edit_signals(workspace_id, created_at)
  WHERE always_do_this = true
    AND processed_at IS NULL;
```

### 3.5 RLS policies for new tables

```sql
ALTER TABLE edit_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE pattern_recurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_isolation" ON edit_classifications
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

CREATE POLICY "workspace_isolation" ON pattern_recurrences
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

CREATE POLICY "workspace_isolation" ON communication_rules
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());
```

### 3.6 pgmq queue

```sql
SELECT pgmq.create('classify_edits');
SELECT pgmq.create('classify_edits_dlq');
```

Signals are enqueued when a `draft_edit_signals` row with `staff_action = 'edited_and_sent'` is inserted. A database trigger handles the enqueue:

```sql
CREATE OR REPLACE FUNCTION enqueue_edit_signal()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.staff_action = 'edited_and_sent' THEN
    PERFORM pgmq.send('classify_edits', jsonb_build_object(
      'signal_id', NEW.id,
      'workspace_id', NEW.workspace_id
    ));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enqueue_edit_signal
  AFTER INSERT ON draft_edit_signals
  FOR EACH ROW EXECUTE FUNCTION enqueue_edit_signal();
```

---

## 4. LLM Classification

### 4.1 Model selection

Claude Haiku (e.g., `claude-3-5-haiku-20241022`) for all classification and instruction generation calls. Rationale:
- Classification is a structured extraction task, not a creative generation task. Haiku is sufficient.
- Cost: ~$0.001 per classification call (500 input tokens, 200 output tokens).
- Latency: ~1-3 seconds per call.

### 4.2 EditCategory taxonomy

Fixed set of 17 categories. Defined as a TypeScript const in `_shared/types.ts` and included in the classification prompt:

```typescript
export const EDIT_CATEGORIES = [
  'tone_softened',
  'tone_warmed',
  'tone_formalized',
  'shortened',
  'lengthened',
  'assumption_removed',
  'fact_corrected',
  'scheduling_options_added',
  'cta_softened',
  'cta_strengthened',
  'personalization_added',
  'upsell_removed',
  'policy_clarification_added',
  'greeting_changed',
  'closing_changed',
  'emoji_added_or_removed',
  'structure_reorganized',
] as const;

export type EditCategory = typeof EDIT_CATEGORIES[number];

export type EditSeverity = 'minor' | 'significant' | 'rewrite';
```

### 4.3 Classification prompt strategy

A single LLM call handles both classification (LL-03) and pattern key assignment (LL-04). The prompt uses structured output (JSON) with few-shot examples.

```typescript
function buildClassificationPrompt(
  originalDraft: string,
  finalVersion: string,
  intentClassified: string | null,
  scenarioType: string | null,
  existingPatternKeys: string[],
): string {
  return `You are an edit classifier for a business messaging assistant. Staff edited an AI-generated draft before sending it. Analyze what changed and why.

## Edit Categories (select one or more)
${EDIT_CATEGORIES.map(c => `- ${c}`).join('\n')}

## Severity Levels
- minor: cosmetic changes (punctuation, whitespace, minor word swap)
- significant: meaningful change to tone, content, or structure
- rewrite: staff replaced more than half the draft text

## Existing Pattern Keys for This Workspace
${existingPatternKeys.length > 0
  ? existingPatternKeys.map(k => `- ${k}`).join('\n')
  : '(none yet — assign new keys as needed)'}

## Pattern Key Format
Use lowercase_underscore format: {verb}_{object}_{context}
Examples: soften_greeting_tone, remove_upsell_reminders, shorten_booking_confirmation
IMPORTANT: Reuse an existing key if the edit matches an existing pattern. Only create a new key if no existing key fits.

## Context
- Intent: ${intentClassified ?? 'unknown'}
- Scenario: ${scenarioType ?? 'unknown'}

## Original Draft
${originalDraft}

## Final Version (what staff sent)
${finalVersion}

## Instructions
1. Compare the original draft and final version.
2. Identify all meaningful changes.
3. Classify each change into one or more edit categories.
4. Assess the overall severity.
5. Assign one or more pattern keys (reuse existing keys when applicable).
6. Write brief analysis notes explaining what changed and why.

Respond with valid JSON only:
{
  "edit_categories": ["category1", "category2"],
  "severity": "minor|significant|rewrite",
  "pattern_keys": ["pattern_key_1"],
  "analysis_notes": "Brief explanation of changes"
}`;
}
```

**Few-shot examples** (3 examples prepended as user/assistant message pairs in the conversation history):

1. Formal-to-casual greeting change -> `["tone_warmed"]`, `"soften_greeting_tone"`
2. Upsell removal from reminder -> `["upsell_removed"]`, `"remove_upsell_reminders"`
3. Multi-category edit (shortened + CTA softened) -> `["shortened", "cta_softened"]`, `"shorten_and_soften_reminders"`

### 4.4 Response parsing and validation

```typescript
type ClassificationResponse = {
  edit_categories: string[];
  severity: string;
  pattern_keys: string[];
  analysis_notes: string;
};

function parseClassificationResponse(raw: string): ClassificationResponse | null {
  try {
    const parsed = JSON.parse(raw);

    // Filter to valid categories only; log warnings for unknown ones
    const validCategories = parsed.edit_categories.filter(
      (c: string) => EDIT_CATEGORIES.includes(c as EditCategory)
    );

    if (validCategories.length === 0) {
      console.warn('[classify] LLM returned no valid categories', { raw });
      return null;
    }

    const validSeverity = ['minor', 'significant', 'rewrite'].includes(parsed.severity)
      ? parsed.severity
      : 'significant'; // default to significant if invalid

    return {
      edit_categories: validCategories,
      severity: validSeverity,
      pattern_keys: parsed.pattern_keys ?? [],
      analysis_notes: parsed.analysis_notes ?? '',
    };
  } catch {
    console.error('[classify] Failed to parse LLM response', { raw });
    return null;
  }
}
```

If parsing fails or returns null, the signal remains unprocessed (`processed_at` stays null) and will be retried in the next cycle. After 3 failed attempts (tracked via pgmq `read_ct`), the message is moved to `classify_edits_dlq`.

### 4.5 Instruction generation prompt (at promotion time)

A second LLM call generates the human-readable rule instruction from representative edit examples. This runs once at promotion time, not per-signal.

```typescript
function buildInstructionPrompt(
  patternKey: string,
  category: string,
  exampleEdits: Array<{ original: string; final: string }>,
): string {
  return `You are writing a communication instruction for an AI messaging assistant. Based on these examples of staff corrections, write a single clear instruction that the AI should follow in all future drafts.

## Pattern: ${patternKey}
## Category: ${category}

## Staff Edit Examples
${exampleEdits.map((e, i) => `
### Example ${i + 1}
Original: ${e.original}
Staff corrected to: ${e.final}
`).join('\n')}

## Instructions
Write ONE imperative instruction sentence (1-2 lines max) addressed to the AI drafter.
- Use imperative voice: "Do X" or "Do not do Y"
- Be specific enough for the AI to act on
- Do not reference internal system concepts (pattern keys, signal IDs, counts)
- Do not reference specific client names from the examples

Respond with the instruction text only, no JSON wrapping.`;
}
```

---

## 5. Pattern Key Assignment

### 5.1 Stability strategy

Pattern key stability is the most architecturally critical property of the learning loop. Without it, recurrence tracking fragments across synonymous keys and the promotion threshold is never met.

**Primary mechanism:** The classification prompt includes all existing pattern keys for the workspace (fetched from `pattern_recurrences`). The LLM is instructed to reuse an existing key when the edit matches an existing pattern.

**Key format:** `{verb}_{object}_{context}` — lowercase, underscore-separated. Examples: `soften_greeting_tone`, `remove_upsell_reminders`, `shorten_booking_confirmation`.

### 5.2 Existing key loading

```typescript
async function loadExistingPatternKeys(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('pattern_recurrences')
    .select('pattern_key')
    .eq('workspace_id', workspaceId)
    .order('recurrence_count', { ascending: false })
    .limit(50);  // cap to prevent prompt bloat

  return (data ?? []).map(r => r.pattern_key);
}
```

The limit of 50 keys addresses open question #1 from the user stories. Beyond 50 patterns, the least-recurring keys are omitted from the prompt. The LLM may create a new key that is a synonym of an omitted key, but at that point the omitted key's recurrence is so low that fragmentation has minimal impact.

### 5.3 Multi-category edits

When a signal produces multiple edit categories, the LLM may assign:
- A single pattern key capturing the combined behaviour (e.g., `shorten_and_soften_reminders`).
- Multiple pattern keys if the changes are independent (e.g., `remove_upsell_reminders` + `shorten_booking_confirmation`).

Each pattern key results in its own `pattern_recurrences` upsert. The `edit_classifications.pattern_keys` array stores all assigned keys for the signal.

---

## 6. Recurrence Tracking

### 6.1 Upsert logic

After classification, for each pattern key assigned to a signal:

```typescript
async function updatePatternRecurrence(
  supabase: SupabaseClient,
  workspaceId: string,
  patternKey: string,
  category: string,
  clientId: string,
  signalCreatedAt: string,
): Promise<PatternRecurrence> {
  // Atomic upsert with array append for client tracking
  const { data, error } = await supabase.rpc('upsert_pattern_recurrence', {
    p_workspace_id: workspaceId,
    p_pattern_key: patternKey,
    p_category: category,
    p_client_id: clientId,
    p_signal_created_at: signalCreatedAt,
  });

  if (error) throw error;
  return data;
}
```

The RPC function handles the atomic increment and distinct client tracking:

```sql
CREATE OR REPLACE FUNCTION upsert_pattern_recurrence(
  p_workspace_id  UUID,
  p_pattern_key   TEXT,
  p_category      TEXT,
  p_client_id     UUID,
  p_signal_created_at TIMESTAMPTZ
)
RETURNS pattern_recurrences
LANGUAGE plpgsql
AS $$
DECLARE
  result pattern_recurrences;
BEGIN
  INSERT INTO pattern_recurrences (
    workspace_id, pattern_key, category,
    recurrence_count, distinct_clients, client_ids,
    first_seen, last_seen
  )
  VALUES (
    p_workspace_id, p_pattern_key, p_category,
    1, 1, ARRAY[p_client_id],
    p_signal_created_at, p_signal_created_at
  )
  ON CONFLICT (workspace_id, pattern_key) DO UPDATE SET
    recurrence_count = pattern_recurrences.recurrence_count + 1,
    client_ids = CASE
      WHEN p_client_id = ANY(pattern_recurrences.client_ids)
        THEN pattern_recurrences.client_ids
        ELSE array_append(pattern_recurrences.client_ids, p_client_id)
    END,
    distinct_clients = CASE
      WHEN p_client_id = ANY(pattern_recurrences.client_ids)
        THEN pattern_recurrences.distinct_clients
        ELSE pattern_recurrences.distinct_clients + 1
    END,
    last_seen = GREATEST(pattern_recurrences.last_seen, p_signal_created_at),
    category = CASE
      WHEN pattern_recurrences.recurrence_count > 0 THEN pattern_recurrences.category
      ELSE p_category
    END,
    updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END;
$$;
```

### 6.2 Distinct client tracking

`client_ids UUID[]` stores the set of distinct client IDs that have contributed signals to this pattern. `distinct_clients` is derived from `array_length(client_ids, 1)`. The array approach ensures idempotency: reprocessing a signal for the same client does not inflate the count.

### 6.3 Concurrency safety

The `ON CONFLICT ... DO UPDATE` with atomic increment is safe under concurrent writes. The advisory lock at the workspace level in `classify-edits` further prevents contention, but the SQL is correct even without it.

---

## 7. Promotion Logic

### 7.1 Threshold criteria

All three conditions must be met:

| Criterion | Threshold | Column | Operator |
|---|---|---|---|
| Occurrence count | >= 3 | `recurrence_count` | `>=` |
| Distinct clients | >= 2 | `distinct_clients` | `>=` |
| Time window | <= 30 days | `last_seen - first_seen` | `<=` |

### 7.2 Rolling window semantics

The 30-day window is evaluated as `last_seen - first_seen <= 30 days`. This is the simple implementation (addresses open question #3 from user stories). The rationale: if a pattern has been active recently enough (last_seen) and started recently enough (first_seen relative to last_seen), it qualifies. An early outlier signal that set `first_seen` 45 days ago but whose last 3 signals all occurred in the past 20 days would fail this check.

**Decay mechanism:** To handle early outliers, a separate pg_cron job (part of `daily-cron`) resets `first_seen` for non-promoted patterns where the oldest contributing signal is > 60 days old:

```sql
-- Run as part of daily-cron, once per day
UPDATE pattern_recurrences
SET first_seen = (
  SELECT MIN(des.created_at)
  FROM draft_edit_signals des
  JOIN edit_classifications ec ON ec.signal_id = des.id
  WHERE des.workspace_id = pattern_recurrences.workspace_id
    AND ec.pattern_keys @> ARRAY[pattern_recurrences.pattern_key]
    AND des.created_at > now() - INTERVAL '30 days'
),
recurrence_count = (
  SELECT COUNT(*)
  FROM draft_edit_signals des
  JOIN edit_classifications ec ON ec.signal_id = des.id
  WHERE des.workspace_id = pattern_recurrences.workspace_id
    AND ec.pattern_keys @> ARRAY[pattern_recurrences.pattern_key]
    AND des.created_at > now() - INTERVAL '30 days'
),
distinct_clients = (
  SELECT COUNT(DISTINCT des.client_id)
  FROM draft_edit_signals des
  JOIN edit_classifications ec ON ec.signal_id = des.id
  WHERE des.workspace_id = pattern_recurrences.workspace_id
    AND ec.pattern_keys @> ARRAY[pattern_recurrences.pattern_key]
    AND des.created_at > now() - INTERVAL '30 days'
),
client_ids = (
  SELECT ARRAY_AGG(DISTINCT des.client_id)
  FROM draft_edit_signals des
  JOIN edit_classifications ec ON ec.signal_id = des.id
  WHERE des.workspace_id = pattern_recurrences.workspace_id
    AND ec.pattern_keys @> ARRAY[pattern_recurrences.pattern_key]
    AND des.created_at > now() - INTERVAL '30 days'
),
updated_at = now()
WHERE promoted = false
  AND first_seen < now() - INTERVAL '60 days';
```

This recalculates from source signals for stale patterns, ensuring the rolling window is accurate even when early signals have aged out.

### 7.3 Threshold check implementation

```typescript
type PromotionResult = {
  shouldPromote: boolean;
  reason: string;
};

function checkPromotionThreshold(
  recurrence: PatternRecurrence,
): PromotionResult {
  if (recurrence.promoted) {
    return { shouldPromote: false, reason: 'already_promoted' };
  }

  const windowDays = Math.ceil(
    (new Date(recurrence.last_seen).getTime() -
     new Date(recurrence.first_seen).getTime()) /
    (1000 * 60 * 60 * 24)
  );

  if (recurrence.recurrence_count < 3) {
    return {
      shouldPromote: false,
      reason: `recurrence_count=${recurrence.recurrence_count}, need >= 3`,
    };
  }

  if (recurrence.distinct_clients < 2) {
    return {
      shouldPromote: false,
      reason: `distinct_clients=${recurrence.distinct_clients}, need >= 2`,
    };
  }

  if (windowDays > 30) {
    return {
      shouldPromote: false,
      reason: `window=${windowDays}d, need <= 30`,
    };
  }

  return { shouldPromote: true, reason: 'threshold_met' };
}
```

### 7.4 "Always do this" bypass

When a signal has `always_do_this = true`, the promotion check is bypassed entirely. After classification and pattern recurrence update, the rule is created immediately regardless of counts or window:

```typescript
if (signal.always_do_this) {
  // Bypass threshold — staff explicitly requested promotion
  await createCommunicationRule(supabase, {
    workspaceId: signal.workspace_id,
    patternKey: primaryPatternKey,
    category: primaryCategory,
    recurrence,
    sourceType: 'staff_flagged',
    confidence: 0.5,  // lower than auto-promoted rules
  });
} else {
  const promotion = checkPromotionThreshold(recurrence);
  if (promotion.shouldPromote) {
    await createCommunicationRule(supabase, {
      workspaceId: signal.workspace_id,
      patternKey: primaryPatternKey,
      category: primaryCategory,
      recurrence,
      sourceType: 'auto',
      confidence: calculateConfidence(recurrence.recurrence_count),
    });
  }
}
```

### 7.5 Confidence calculation

```typescript
function calculateConfidence(recurrenceCount: number): number {
  return Math.min(1.0, recurrenceCount / 10);
}
```

Simple linear scale: 3 occurrences = 0.3, 5 = 0.5, 10+ = 1.0. Staff-flagged rules start at 0.5 regardless. Post-MVP: weight by `distinct_clients` and signal severity.

---

## 8. Rule Creation

### 8.1 Promotion flow

```typescript
async function createCommunicationRule(
  supabase: SupabaseClient,
  params: {
    workspaceId: string;
    patternKey: string;
    category: string;
    recurrence: PatternRecurrence;
    sourceType: 'auto' | 'staff_flagged';
    confidence: number;
  },
): Promise<CommunicationRule> {
  // 1. Check for existing rule with same source_pattern_key (idempotency)
  const { data: existing } = await supabase
    .from('communication_rules')
    .select('id')
    .eq('workspace_id', params.workspaceId)
    .eq('source_pattern_key', params.patternKey)
    .single();

  if (existing) {
    console.log('[promote] Rule already exists for pattern', params.patternKey);
    return existing;
  }

  // 2. Fetch 2-3 representative edit examples for instruction generation
  const { data: examples } = await supabase
    .from('draft_edit_signals')
    .select('original_draft, final_version')
    .eq('workspace_id', params.workspaceId)
    .eq('pattern_key', params.patternKey)
    .eq('staff_action', 'edited_and_sent')
    .not('original_draft', 'is', null)
    .not('final_version', 'is', null)
    .order('created_at', { ascending: false })
    .limit(3);

  const exampleEdits = (examples ?? []).map(e => ({
    original: e.original_draft,
    final: e.final_version,
  }));

  // 3. Generate instruction via LLM
  const instruction = await generateRuleInstruction(
    params.patternKey,
    params.category,
    exampleEdits,
  );

  // 4. Create rule
  const { data: rule, error } = await supabase
    .from('communication_rules')
    .insert({
      workspace_id: params.workspaceId,
      category: params.category,
      instruction,
      confidence: params.confidence,
      source_pattern_key: params.patternKey,
      source_type: params.sourceType,
      example_edits: exampleEdits,
      active: true,
    })
    .select()
    .single();

  if (error) throw error;

  // 5. Mark pattern as promoted
  await supabase
    .from('pattern_recurrences')
    .update({ promoted: true, promoted_at: new Date().toISOString() })
    .eq('workspace_id', params.workspaceId)
    .eq('pattern_key', params.patternKey);

  // 6. Audit event
  await auditService.logEvent({
    workspaceId: params.workspaceId,
    actorType: 'system',
    actorId: null,
    actionType: 'rule_created',
    targetType: 'communication_rule',
    targetId: rule.id,
    metadata: {
      pattern_key: params.patternKey,
      source_type: params.sourceType,
      recurrence_count: params.recurrence.recurrence_count,
      distinct_clients: params.recurrence.distinct_clients,
    },
  });

  return rule;
}
```

### 8.2 Instruction generation call

```typescript
async function generateRuleInstruction(
  patternKey: string,
  category: string,
  exampleEdits: Array<{ original: string; final: string }>,
): Promise<string> {
  const prompt = buildInstructionPrompt(patternKey, category, exampleEdits);

  const response = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }],
  });

  const instruction = response.content[0]?.type === 'text'
    ? response.content[0].text.trim()
    : `Follow the "${patternKey.replace(/_/g, ' ')}" pattern in all drafts.`;

  // Log LLM usage
  await logLLMUsage(supabase, {
    workspaceId,
    clientId: null,
    edgeFunctionName: 'classify-edits',
    model: 'claude-3-5-haiku-20241022',
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
    latencyMs: /* measured */,
    costUsd: /* calculated from pricing */,
  });

  return instruction;
}
```

---

## 9. Rule Injection into Context Assembly

### 9.1 Loading rules

Added to the existing `assembleContext()` function in `_shared/context-assembly.ts`:

```typescript
// Inside assembleContext(), after loading vertical config and tone profile:

async function loadCommunicationRules(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<CommunicationRule[]> {
  const { data } = await supabase
    .from('communication_rules')
    .select('instruction, confidence, category')
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .order('confidence', { ascending: false });

  return data ?? [];
}
```

### 9.2 Context formatting

Rules are formatted as a dedicated section in the system prompt, positioned after the tone profile and SOP rules, before client-scoped context:

```typescript
function formatCommunicationRules(rules: CommunicationRule[]): string {
  if (rules.length === 0) return '';

  // Token budget: ~500 tokens, ~30 tokens per rule instruction
  const TOKEN_BUDGET = 500;
  const AVG_TOKENS_PER_RULE = 30;
  const maxRules = Math.floor(TOKEN_BUDGET / AVG_TOKENS_PER_RULE);  // ~16

  const included = rules.slice(0, maxRules);

  if (included.length < rules.length) {
    console.warn('[context] Communication rules truncated', {
      total: rules.length,
      included: included.length,
    });
  }

  const ruleLines = included.map(
    (r, i) => `${i + 1}. ${r.instruction}`
  ).join('\n');

  return `## Learned Communication Preferences
The following rules were learned from staff corrections to previous drafts. Follow them in all responses:

${ruleLines}`;
}
```

### 9.3 Cache strategy

Communication rules change infrequently (only when a pattern is promoted or staff edits/disables a rule). The formatted rules string is cacheable per workspace. The cache key is `rules:${workspaceId}` and is invalidated on any INSERT, UPDATE, or DELETE to `communication_rules` for that workspace.

For MVP, no explicit cache is needed. The database query is fast (indexed, small result set). If context assembly latency becomes a concern, add an in-memory cache with 60-second TTL in the Edge Function.

### 9.4 Token budget allocation

From the architecture's token budget table (architecture-final.md section 6.2):

| Section | Budget |
|---|---|
| Communication rules | ~500 tokens |

With an average of ~30 tokens per rule instruction, this caps at roughly 16 rules before truncation. Rules are prioritized by confidence (highest first), so the most strongly supported rules are always included.

---

## 10. Staff Settings UI

### 10.1 Communication Rules page

**Route:** `/settings/rules`

**Layout:**
- Header: "Communication Rules" with count badge (e.g., "3 active")
- Empty state: explanatory text when no rules exist yet
- Rule list: sorted by `promoted_at` DESC (newest first)
- Each rule card shows: instruction text, category label, confidence indicator, active toggle, "Edit" and "Details" buttons

### 10.2 Rule card component

```typescript
type RuleCardProps = {
  rule: CommunicationRule;
  onToggle: (ruleId: string, active: boolean) => void;
  onEdit: (ruleId: string, instruction: string) => void;
  onExpand: (ruleId: string) => void;
};
```

**Category labels** (human-readable mapping):

| Category | Label |
|---|---|
| `tone_softened` | Tone |
| `tone_warmed` | Tone |
| `tone_formalized` | Tone |
| `shortened` | Length |
| `lengthened` | Length |
| `assumption_removed` | Content |
| `fact_corrected` | Content |
| `scheduling_options_added` | Scheduling |
| `cta_softened` | Call to Action |
| `cta_strengthened` | Call to Action |
| `personalization_added` | Personalization |
| `upsell_removed` | Content |
| `policy_clarification_added` | Policy |
| `greeting_changed` | Greeting |
| `closing_changed` | Closing |
| `emoji_added_or_removed` | Style |
| `structure_reorganized` | Structure |

### 10.3 Rule editing

Inline text editing. When staff clicks "Edit", the instruction text becomes an editable textarea. On save:

```typescript
async function updateRule(ruleId: string, instruction: string): Promise<void> {
  const { error } = await supabase
    .from('communication_rules')
    .update({ instruction, updated_at: new Date().toISOString() })
    .eq('id', ruleId);

  if (error) throw error;

  // Audit event
  await supabase.from('audit_events').insert({
    workspace_id: workspaceId,
    actor_type: 'staff',
    actor_id: staffId,
    action_type: 'rule_updated',
    target_type: 'communication_rule',
    target_id: ruleId,
    metadata: { before: previousInstruction, after: instruction },
  });
}
```

### 10.4 Rule toggle (enable/disable)

Toggle switch on each rule card. On toggle:

```typescript
async function toggleRule(ruleId: string, active: boolean): Promise<void> {
  const { error } = await supabase
    .from('communication_rules')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', ruleId);

  if (error) throw error;

  // Audit event
  await supabase.from('audit_events').insert({
    workspace_id: workspaceId,
    actor_type: 'staff',
    actor_id: staffId,
    action_type: active ? 'rule_enabled' : 'rule_disabled',
    target_type: 'communication_rule',
    target_id: ruleId,
    metadata: {},
  });
}
```

### 10.5 Rule detail panel

Expandable section on each rule card showing:

| Detail | Source |
|---|---|
| Source pattern key | `communication_rules.source_pattern_key` |
| Times detected | `pattern_recurrences.recurrence_count` (live query) |
| Clients affected | `pattern_recurrences.distinct_clients` (live query) |
| Source type | "Auto-detected" or "Staff-created" based on `source_type` |
| Example edits | `communication_rules.example_edits` JSONB (snapshotted at promotion) |

Example edits are displayed as before/after diff pairs with the original strikethrough and final highlighted.

### 10.6 "Always do this" checkbox in draft send flow

Added to the draft review panel in the client thread page (F-05's `src/app/(dashboard)/inbox/[conversationId]/page.tsx`):

- Visible only when `edited_content !== original_draft` (staff has made changes).
- Checkbox label: "Always do this"
- Tooltip: "Create a permanent rule from this edit so the AI applies it to all future drafts"
- When checked and staff clicks Send, the `draft_edit_signals` record is created with `always_do_this = true`.
- Visual confirmation: brief toast "Rule will be created from your edit" after send.

---

## 11. Edge Cases

### 11.1 Noisy classifications

**Problem:** The LLM may misclassify edits, leading to inaccurate pattern keys and potentially promoting bad rules.

**Mitigations:**
- The promotion threshold (3+ occurrences, 2+ clients) naturally filters one-off misclassifications. A single bad classification does not produce a rule.
- The `severity = 'minor'` classification prevents cosmetic edits (whitespace, punctuation) from inflating recurrence counts. Minor edits are classified but should rarely produce meaningful pattern keys.
- Staff can disable any rule in Settings. A bad rule is recoverable within one click.
- Classification is idempotent: if the taxonomy or prompt improves, signals can be reclassified.

### 11.2 Bad promotions

**Problem:** A pattern meets the threshold but the resulting rule is too broad, too narrow, or incorrect.

**Mitigations:**
- The instruction is generated from representative examples, not from the pattern key alone. This anchors the instruction in actual staff behaviour.
- Staff can edit the instruction text in Settings. The edited version replaces the LLM-generated one for all future context assemblies.
- Staff can disable the rule entirely. The pattern continues to be tracked (recurrence count increments) but the disabled rule does not affect drafts.
- A maximum of ~16 rules (500 token budget / ~30 tokens per rule) naturally caps the blast radius of bad promotions.

### 11.3 Rule conflicts

**Problem:** Two rules may contradict each other (e.g., "Use formal tone" and "Use casual, friendly greetings").

**Mitigations:**
- Rules are injected into the context in confidence-descending order. The LLM naturally resolves conflicts by prioritizing earlier instructions (higher confidence = listed first).
- Staff can identify and disable conflicting rules in Settings. The category labels help surface rules that address the same domain (e.g., two "Tone" rules).
- Post-MVP: add conflict detection that flags rules in the same category with opposing directives.

### 11.4 Pattern key fragmentation

**Problem:** Over time, the LLM creates synonymous pattern keys (e.g., `soften_greeting` and `warm_opening_tone`) that fragment recurrence tracking.

**Mitigations:**
- The primary defence is including existing keys in the classification prompt. The LLM is instructed to reuse existing keys when the edit matches.
- The 50-key cap on the prompt prevents the key list from becoming unwieldy while covering the most important patterns.
- Post-MVP: periodic key deduplication job that uses embedding similarity to detect and merge synonym keys.

### 11.5 High-volume workspaces overwhelming the classifier

**Problem:** A workspace with many active conversations generates a burst of `edited_and_sent` signals that the classifier cannot keep up with.

**Mitigations:**
- The batch size of 10 signals per invocation limits the work per Edge Function call.
- The 5-minute pg_cron poll ensures signals are eventually processed even if the pg_net trigger-based path is overloaded.
- Signals are durable in the database (`processed_at IS NULL` index). No signal is lost if the classifier falls behind.
- The advisory lock per workspace prevents duplicate processing. Multiple workspaces are processed independently.

### 11.6 LLM classification failure

**Problem:** Claude Haiku returns an error, times out, or returns unparseable output.

**Mitigations:**
- The signal remains unprocessed (`processed_at` stays null) and will be retried in the next cycle.
- After 3 failed processing attempts (tracked via pgmq `read_ct`), the message moves to `classify_edits_dlq`.
- No partial classification is written. The operation is all-or-nothing.
- LLM errors are logged with full context (signal_id, workspace_id, error details, raw response if available).

### 11.7 "Always do this" on a trivial edit

**Problem:** Staff checks "Always do this" on a minor punctuation change, creating a low-value rule.

**Mitigations:**
- Staff-flagged rules start at confidence 0.5 (lower than threshold-promoted rules with 3+ occurrences). They appear lower in the confidence-sorted rule list and are more likely to be truncated if the token budget is full.
- Staff can immediately disable or edit the rule in Settings.
- Post-MVP: show a confirmation dialog if the edit severity is classified as `minor`.

### 11.8 Workspace with no existing pattern keys (cold start)

**Problem:** The first classification has no existing keys to anchor against. Key stability cannot be verified until the second signal.

**Mitigation:** This is expected behaviour. The first key is always new. The second classification includes the first key in its prompt, establishing the stability mechanism. Cold start is inherently a low-risk period because the promotion threshold requires 3+ signals.

### 11.9 Rule token budget exceeded

**Problem:** A mature workspace accumulates 20+ active rules, exceeding the ~500 token budget.

**Mitigations:**
- Rules are sorted by confidence DESC and truncated at the budget. The most strongly supported rules are always included.
- A warning is logged when truncation occurs, providing visibility for the workspace owner.
- Staff can review and disable low-value rules in Settings to free budget.
- Post-MVP: make the token budget configurable per workspace.

---

## 12. Acceptance Criteria to Task Mapping

### Task T-F15-01: Database migration — new tables and schema changes

Implements section 3 (full data model).

- [ ] Create `edit_classifications` table with schema from section 3.1.
- [ ] Create `pattern_recurrences` table with schema from section 3.2.
- [ ] Create `communication_rules` table with schema from section 3.3.
- [ ] Add `edit_categories`, `pattern_key`, `always_do_this`, `processed_at` columns to `draft_edit_signals` (section 3.4).
- [ ] Create all indexes defined in section 3 (signal unprocessed index, always_do_this index, classification signal index, pattern workspace index, rules active index).
- [ ] Enable RLS on all three new tables with workspace isolation policies (section 3.5).
- [ ] Create `classify_edits` and `classify_edits_dlq` pgmq queues (section 3.6).
- [ ] Create the `enqueue_edit_signal` trigger function and trigger (section 3.6).
- [ ] Create the `upsert_pattern_recurrence` RPC function (section 6.1).
- [ ] Verify: INSERT into `edit_classifications` as authenticated staff for own workspace succeeds; cross-workspace fails.
- [ ] Verify: `upsert_pattern_recurrence` correctly inserts on first call and increments on second.
- [ ] Verify: trigger fires on `draft_edit_signals` INSERT with `staff_action = 'edited_and_sent'`; pgmq message created.

Covers AC: US-F15-01 scenario "Classification uses only the diff", US-F15-03 scenario "First occurrence of a new pattern", US-F15-04 scenario "Recurrence update is scoped to workspace".

### Task T-F15-02: Classification prompt and LLM integration

Implements sections 4.1-4.4 (LLM classification).

- [ ] `_shared/classification-prompt.ts` — `buildClassificationPrompt()` function with taxonomy, few-shot examples, and existing key injection.
- [ ] `_shared/classification-parser.ts` — `parseClassificationResponse()` with category validation, severity validation, and unknown category logging.
- [ ] Integration with OpenRouter (`anthropic/claude-haiku-4-5-20251001`).
- [ ] LLM usage logging after every classification call.
- [ ] Unit tests: prompt construction with 0, 1, and 50 existing keys.
- [ ] Unit tests: response parsing with valid JSON, invalid categories (filtered), unparseable response (returns null).
- [ ] Integration test: classify a mock edit (formal to casual greeting) -> returns `["tone_warmed"]` with a pattern key.

Covers AC: US-F15-01 all classification scenarios, US-F15-02 "Pattern key assigned during classification".

### Task T-F15-03: `classify-edits` Edge Function

Implements sections 2.1 and full pipeline (classify, track, promote, create rule).

- [ ] New Edge Function `supabase/functions/classify-edits/index.ts`.
- [ ] Dequeue from `classify_edits` pgmq queue (batch of up to 10).
- [ ] Advisory lock per workspace to prevent concurrent processing.
- [ ] For each signal: load existing pattern keys, invoke classification LLM, parse response, write `edit_classifications` row.
- [ ] Back-populate `edit_categories` and `pattern_key` on the `draft_edit_signals` row.
- [ ] Set `processed_at` on the signal after successful classification.
- [ ] Call `upsert_pattern_recurrence` for each pattern key.
- [ ] Run promotion threshold check.
- [ ] If promoted or `always_do_this`: generate rule instruction, create `communication_rules` row, mark pattern as promoted.
- [ ] Handle `always_do_this = true` signals with priority (fetched before regular signals).
- [ ] On LLM failure: leave signal unprocessed; log error; pgmq visibility timeout handles retry.
- [ ] After 3 failures: message moves to `classify_edits_dlq`.
- [ ] pg_cron schedule: every 5 minutes.
- [ ] End-to-end test: insert a `draft_edit_signals` row with `staff_action = 'edited_and_sent'` -> classification created, pattern tracked, signal marked processed.
- [ ] End-to-end test: insert 3 signals for the same pattern from 2 clients -> rule created with valid instruction.

Covers AC: US-F15-01 all scenarios, US-F15-02 all scenarios, US-F15-03 all scenarios, US-F15-04 all scenarios, US-F15-05 all scenarios.

### Task T-F15-04: Pattern recurrence tracking and decay

Implements sections 6 and 7.2 (recurrence tracking and rolling window decay).

- [ ] `_shared/pattern-tracking.ts` — `updatePatternRecurrence()`, `checkPromotionThreshold()`, `calculateConfidence()`.
- [ ] `checkPromotionThreshold()` unit tests: all 7 scenarios from US-F15-04 (meets threshold, not enough clients, not enough occurrences, exceeds window, rolling window, already promoted, boundary values).
- [ ] `calculateConfidence()` unit tests: 3 -> 0.3, 5 -> 0.5, 10 -> 1.0, 15 -> 1.0.
- [ ] Daily decay SQL added to `daily-cron` Edge Function for patterns with `first_seen > 60 days ago` and `promoted = false`.
- [ ] Verify: concurrent upserts to the same pattern do not lose counts.
- [ ] Verify: distinct_clients array correctly deduplicates repeated client IDs.

Covers AC: US-F15-03 all scenarios, US-F15-04 all scenarios.

### Task T-F15-05: Rule instruction generation

Implements sections 4.5 and 8 (instruction prompt and rule creation).

- [ ] `_shared/instruction-prompt.ts` — `buildInstructionPrompt()` function.
- [ ] `generateRuleInstruction()` with Claude Haiku call and LLM usage logging.
- [ ] `createCommunicationRule()` with idempotency check (existing rule for same pattern key).
- [ ] Example edits snapshotted in `example_edits` JSONB at promotion time.
- [ ] Audit event on rule creation (action_type: `rule_created`).
- [ ] Integration test: promote a pattern -> rule created with human-readable instruction, imperative voice, no internal system references.
- [ ] Integration test: attempt to promote an already-promoted pattern -> no duplicate rule.

Covers AC: US-F15-05 all scenarios.

### Task T-F15-06: Context assembly integration

Implements section 9 (rule injection).

- [ ] Modify `_shared/context-assembly.ts` to call `loadCommunicationRules()`.
- [ ] `formatCommunicationRules()` — renders rules as numbered list under "## Learned Communication Preferences" header.
- [ ] Token budget enforcement: include up to ~16 rules sorted by confidence DESC; log warning on truncation.
- [ ] Omit section entirely when no active rules exist (no placeholder text).
- [ ] Section positioned after tone profile / SOP rules, before client-scoped context.
- [ ] Unit test: 0 rules -> empty string returned.
- [ ] Unit test: 3 rules -> formatted section with header and numbered list.
- [ ] Unit test: 20 rules -> truncated to ~16, warning logged.
- [ ] Integration test: create active rule -> next `assembleContext()` call includes the rule in output.
- [ ] Integration test: disable rule -> next `assembleContext()` call excludes it.

Covers AC: US-F15-06 all scenarios.

### Task T-F15-07: Rule management API routes

Implements section 2.3 (Next.js API routes) and section 10.3-10.4 (edit/toggle logic).

- [ ] `GET /api/rules` — list all rules for workspace, sorted by `promoted_at` DESC.
- [ ] `PATCH /api/rules/:ruleId` — update `instruction` and/or `active` fields. Validates that only `instruction` and `active` are mutable.
- [ ] `GET /api/rules/:ruleId/details` — fetch rule with joined `pattern_recurrences` data (recurrence_count, distinct_clients).
- [ ] Audit events for rule_updated, rule_enabled, rule_disabled with before/after metadata.
- [ ] All routes use Supabase RLS (no service-role bypass).
- [ ] Test: PATCH with `{ active: false }` -> rule disabled, audit event written.
- [ ] Test: PATCH with `{ instruction: "new text" }` -> instruction updated, audit event with before/after.
- [ ] Test: attempt to PATCH `confidence` or `source_pattern_key` -> rejected (immutable fields).

Covers AC: US-F15-07 scenarios "Staff disables a rule", "Staff re-enables a rule", "Staff edits instruction text", "Staff cannot edit system fields".

### Task T-F15-08: Settings UI — Communication Rules page

Implements sections 10.1-10.5 (staff UI).

- [ ] `src/app/(dashboard)/settings/rules/page.tsx` — Communication Rules page with list view.
- [ ] `src/components/settings/RuleCard.tsx` — rule display with inline edit, toggle, expand.
- [ ] `src/components/settings/RuleDetailPanel.tsx` — expanded view with source pattern, counts, example edits.
- [ ] Category label mapping (section 10.2 table).
- [ ] Confidence displayed as strength indicator (e.g., progress bar or star rating).
- [ ] Empty state: explanatory text when no rules exist.
- [ ] Sort by promoted_at DESC by default.
- [ ] "Staff-created" badge for rules with `source_type = 'staff_flagged'`.
- [ ] Example edits displayed as before/after diff pairs.
- [ ] Optimistic UI update on toggle and edit (revert on API error).

Covers AC: US-F15-07 all scenarios.

### Task T-F15-09: "Always do this" flag in draft send flow

Implements section 10.6 and US-F15-08.

- [ ] `src/components/draft/AlwaysDoThisCheckbox.tsx` — checkbox component.
- [ ] Visible only when `edited_content !== original_draft`.
- [ ] Tooltip: "Create a permanent rule from this edit so the AI applies it to all future drafts".
- [ ] On send with checkbox checked: `always_do_this = true` on `draft_edit_signals` record.
- [ ] Brief toast confirmation: "Rule will be created from your edit".
- [ ] Hidden/disabled when draft is unedited.
- [ ] Integration test: send edited draft with "always do this" -> signal created with `always_do_this = true` -> classifier processes with priority -> rule created with `source_type = 'staff_flagged'` and `confidence = 0.5`.

Covers AC: US-F15-08 all scenarios.

### Task T-F15-10: Audit event types for learning loop

Extends F-04's audit event system with learning loop action types.

- [ ] Add to `AUDIT_ACTION_TYPES`: `'rule_created'`, `'rule_updated'`, `'rule_enabled'`, `'rule_disabled'`.
- [ ] Instrument all mutation call sites in the classify-edits Edge Function and rule management API routes.
- [ ] Verify: rule creation -> audit event with pattern_key, source_type, recurrence_count in metadata.
- [ ] Verify: rule toggle -> audit event with rule_id.
- [ ] Verify: rule edit -> audit event with before/after instruction text.

Covers AC: US-F15-07 scenarios referencing audit events.

### Task T-F15-11: End-to-end integration test

Full pipeline validation.

- [ ] Seed workspace with 3 `draft_edit_signals` records (staff_action = 'edited_and_sent') from 2 different clients, all with conceptually similar edits (e.g., staff shortens verbose booking confirmations).
- [ ] Trigger `classify-edits` Edge Function.
- [ ] Verify: all 3 signals classified with same pattern key.
- [ ] Verify: `pattern_recurrences` row has `recurrence_count = 3`, `distinct_clients = 2`.
- [ ] Verify: pattern promoted; `communication_rules` row created with valid instruction.
- [ ] Verify: next `assembleContext()` call for any client includes the new rule in "Learned Communication Preferences" section.
- [ ] Verify: rule appears in `GET /api/rules` response.
- [ ] Verify: disable rule in Settings -> next context assembly excludes it.
- [ ] Verify: re-enable rule -> next context assembly includes it again.
- [ ] Verify: total of 3 LLM calls logged in `llm_usage` (3 classification calls + 1 instruction generation call, minus the 2 classification calls where pattern wasn't yet promotable = depends on batch order; at minimum 3 classification + 1 instruction = 4 calls).

---

## 13. Dependencies

### Upstream (must exist before F-15)

| Dependency | Feature | Reason |
|---|---|---|
| `draft_edit_signals` table with signal data | F-10 (Learning Signal Capture) | Raw input for the classification pipeline |
| Draft acceptance metric aggregation | F-14 (Draft Acceptance Metrics) | Confirms signal data quality before analysis pipeline runs |
| `assembleContext()` function | F-05 (Context Assembly) | Rule injection target; must support the `communicationRules` field |
| `audit_events` table and `AuditService` | F-04 (Notifications & Audit) | All rule mutations produce audit events |
| pgmq extension enabled | F-02 (WhatsApp Message Pipeline) | `classify_edits` and `classify_edits_dlq` queues |
| `auth.workspace_id()` PostgreSQL function | Architecture foundation | RLS policies on all new tables |
| pg_cron enabled | Architecture foundation | Classifier polling schedule |

### Downstream (features that depend on F-15)

None. F-15 is the terminal feature in the dependency graph. Its output (communication rules in context assembly) improves existing features (F-05 draft quality) but no feature depends on F-15 being complete.

### External services

| Service | Usage | Risk |
|---|---|---|
| OpenRouter (Claude Haiku) | Edit classification + instruction generation | LLM failure is gracefully handled; signals remain unprocessed and retry |
| Supabase PostgreSQL | All data storage and pgmq queue | Core infrastructure dependency |

---

## 14. Open Questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| OQ-1 | Should the rolling window decay job (section 7.2) run as part of the existing `daily-cron` Edge Function or as a separate pg_cron SQL job? Running inline in `daily-cron` adds complexity to an already-loaded function. A separate SQL job avoids the Edge Function entirely. | Eng | No — default: separate pg_cron SQL job |
| OQ-2 | Should confidence be updated dynamically as more signals confirm a promoted pattern, or remain static after creation? Dynamic updates mean every new signal for a promoted pattern triggers a confidence recalculation on the rule. Static is simpler but the confidence stales. | Eng + PM | No — default: static for MVP. Staff can infer recurrence strength from the detail panel. |
| OQ-3 | The `workspaces.communication_profile` JSONB column from the architecture schema — should it be kept as a denormalized cache of active rules (for fast context assembly), removed entirely (redundant with the normalized `communication_rules` table), or left as-is but unused? | Eng | No — default: keep but unused. Remove in a cleanup migration after F-15 is stable. |
| OQ-4 | Should the `classify-edits` Edge Function be triggered by pg_net (event-driven, lower latency) or pg_cron only (simpler, 5-minute polling)? The trigger in section 3.6 uses pgmq but the function invocation strategy is separate. | Eng | No — default: pg_cron polling. Add pg_net trigger as an optimization if classification latency matters. |
| OQ-5 | What is the maximum number of active rules per workspace before a warning or soft cap is enforced? The token budget caps effective rules at ~16, but a workspace could have 30+ active rules where only the top 16 are used. | PM + Eng | No — default: no cap for MVP. The confidence-based truncation handles overflow gracefully. |
