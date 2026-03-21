# Sprint 5: Intelligence & Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the feedback loop — notes produce structured records via async AI categorization (F-13), and staff draft edits are classified into recurring patterns that promote to workspace communication rules injected into all future AI drafts (F-15).

**Architecture:** Two async Edge Function pipelines triggered by database events. F-13: note INSERT → pg_net → `categorize-note` (Haiku) → proposed_actions. F-15: edited_and_sent signal INSERT → pgmq → `classify-edits` (Haiku) → pattern_recurrences → communication_rules → context assembly injection. Both pipelines are non-blocking: note saves and draft sends complete before AI processing begins. All proposed changes flow through the existing F-06 approval system.

**Tech Stack:** Supabase Edge Functions (Deno), pg_net + pg_cron, pgmq, PostgreSQL RPC, Claude Haiku via OpenRouter, Vitest, Zod

**Specs:**
- `docs/phase-4-feature-design/feature-specs/f13-intelligent-note-processing.md`
- `docs/phase-4-feature-design/feature-specs/f15-learning-loop.md`

---

## Dependency Graph

```
Task 1 (migration) ──── MUST GO FIRST
    │
    └── Task 2 (shared types) ──── AFTER Task 1
            │
            ├── Task 3 (deadline resolver)  ──────────┐
            ├── Task 4 (categorization prompt/parser) ─┤── PARALLEL
            ├── Task 7 (classification prompt/parser) ─┤   (pure functions)
            └── Task 8 (pattern tracking/promotion)  ──┘
                    │
                    ├── Task 5 (categorize-note EF) ── depends on 3, 4
                    ├── Task 9 (classify-edits EF) ─── depends on 7, 8
                    │       │
                    │       ├── Task 10 (rule mgmt APIs) ── depends on 2
                    │       └── Task 11 (context injection) ── depends on 2
                    │
                    ├── Task 6 (notes API + context parser) ── depends on 2
                    └── Task 12 (verification) ──── LAST
```

**Parallel execution groups:**
- Group A: Tasks 3, 4, 7, 8 (all pure functions/types, parallel after Task 2)
- Group B: Tasks 5, 6 (F-13 integration, after Group A)
- Group C: Tasks 9, 10, 11 (F-15 integration, after Group A)
- Group D: Task 12 (after all)

---

## File Structure

### New files

```
supabase/migrations/
  20260323000001_sprint5_intelligence.sql     # All DDL: tables, columns, triggers, RPC, pg_cron, RLS

supabase/functions/_shared/
  types/extraction.ts                         # F-13: categorization input/output types
  types/learning.ts                           # F-15: edit classification, pattern, rule types
  categorization-prompt.ts                    # F-13: Haiku system prompt + user message builder
  categorization-parser.ts                    # F-13: parse + validate LLM response
  classification-prompt.ts                    # F-15: Haiku classification prompt + few-shot
  classification-parser.ts                    # F-15: parse + validate classification response
  deadline-resolver.ts                        # F-13: relative date → absolute ISO date
  context-update-parser.ts                    # F-13: staff command intent classification
  pattern-tracking.ts                         # F-15: recurrence upsert, threshold check, confidence
  instruction-generator.ts                    # F-15: Haiku prompt for rule instruction text

supabase/functions/categorize-note/
  index.ts                                    # F-13: async note categorization Edge Function

supabase/functions/classify-edits/
  index.ts                                    # F-15: async edit classification Edge Function

src/app/api/workspaces/[workspaceId]/rules/
  route.ts                                    # F-15: GET (list rules)

src/app/api/workspaces/[workspaceId]/rules/[ruleId]/
  route.ts                                    # F-15: PATCH (update rule)

src/app/api/workspaces/[workspaceId]/rules/[ruleId]/details/
  route.ts                                    # F-15: GET (rule + source pattern + examples)

src/lib/rules/
  schemas.ts                                  # F-15: Zod schemas for rule API validation

src/lib/learning/__tests__/
  deadline-resolver.test.ts                   # F-13: deadline resolver unit tests
  categorization-parser.test.ts               # F-13: response parser unit tests
  context-update-parser.test.ts               # F-13: command parser unit tests
  classification-parser.test.ts               # F-15: classification parser unit tests
  pattern-tracking.test.ts                    # F-15: pattern tracking + promotion unit tests
```

### Modified files

```
supabase/functions/_shared/context-assembly.ts  # F-15: add loadCommunicationRules()
src/app/api/workspaces/[workspaceId]/notes/route.ts  # F-13: set extraction_status on POST
src/lib/notes/schemas.ts                        # F-13: add extraction_status to schema, expand source enum
```

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/20260323000001_sprint5_intelligence.sql`

This migration covers both F-13 and F-15 schema changes. All DDL uses `IF NOT EXISTS` / `CREATE OR REPLACE` for idempotency.

- [ ] **Step 1: Create the migration file**

```sql
-- Sprint 5: Intelligence & Learning (F-13, F-15)
-- Adds: note extraction columns, edit classification tables, pattern tracking,
--        communication rules, triggers, RPC functions, pg_cron safety nets
-- All statements are idempotent (IF NOT EXISTS / CREATE OR REPLACE)

-- ============================================================
-- F-13: Note extraction pipeline
-- ============================================================

-- 1a. Add extraction columns to notes table
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS extraction_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS extraction_retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extraction_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extraction_error TEXT;

-- Constraint for extraction_status values (idempotent via DO block)
-- 'processing' state is used as an optimistic lock to prevent duplicate extraction
DO $$ BEGIN
  ALTER TABLE notes ADD CONSTRAINT chk_notes_extraction_status
    CHECK (extraction_status IN ('pending', 'processing', 'complete', 'failed', 'not_applicable'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Index: pg_cron safety net picks up stuck pending notes
CREATE INDEX IF NOT EXISTS idx_notes_pending_extraction
  ON notes (workspace_id, extraction_status, created_at)
  WHERE extraction_status = 'pending';

-- Index: flush-before-compact check (F-11 uses this)
CREATE INDEX IF NOT EXISTS idx_notes_client_pending
  ON notes (client_id, workspace_id)
  WHERE extraction_status = 'pending';

-- 1b. Add source_note_id to follow_ups (trace extraction back to note)
ALTER TABLE follow_ups
  ADD COLUMN IF NOT EXISTS source_note_id UUID REFERENCES notes(id);

-- Index: deduplication of open follow-ups/promises per client
CREATE INDEX IF NOT EXISTS idx_followups_client_type_open
  ON follow_ups (client_id, type)
  WHERE status IN ('open', 'pending');

-- 1c. Add source_note_id to proposed_actions (trace proposal back to note)
ALTER TABLE proposed_actions
  ADD COLUMN IF NOT EXISTS source_note_id UUID REFERENCES notes(id);

-- 1d. pg_net trigger: fire categorize-note on note INSERT
CREATE OR REPLACE FUNCTION trigger_note_categorization()
RETURNS TRIGGER AS $$
BEGIN
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

DROP TRIGGER IF EXISTS trg_categorize_note ON notes;
CREATE TRIGGER trg_categorize_note
  AFTER INSERT ON notes
  FOR EACH ROW
  EXECUTE FUNCTION trigger_note_categorization();

-- 1e. pg_cron: retry pending notes stuck > 2 minutes (safety net)
SELECT cron.schedule(
  'retry-pending-categorization',
  '* * * * *',
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

-- 1f. pg_cron: recover notes stuck in 'processing' for > 5 minutes
-- Prevents permanent stuck state if Edge Function crashes mid-extraction
SELECT cron.schedule(
  'recover-stuck-processing-notes',
  '*/5 * * * *',
  $$
  UPDATE notes
  SET extraction_status = 'pending'
  WHERE extraction_status = 'processing'
    AND extraction_completed_at IS NULL
    AND created_at < now() - interval '5 minutes';
  $$
);

-- ============================================================
-- F-15: Learning loop pipeline
-- ============================================================

-- 2a. Add columns to draft_edit_signals for classification output
ALTER TABLE draft_edit_signals
  ADD COLUMN IF NOT EXISTS edit_categories TEXT[],
  ADD COLUMN IF NOT EXISTS pattern_key TEXT,
  ADD COLUMN IF NOT EXISTS always_do_this BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Index: unprocessed edited_and_sent signals for classify-edits worker
CREATE INDEX IF NOT EXISTS idx_signals_unprocessed
  ON draft_edit_signals (workspace_id, created_at)
  WHERE staff_action = 'edited_and_sent'
    AND processed_at IS NULL;

-- Index: always_do_this priority queue
CREATE INDEX IF NOT EXISTS idx_signals_always_do_this
  ON draft_edit_signals (workspace_id, created_at)
  WHERE always_do_this = true
    AND processed_at IS NULL;

-- 2b. edit_classifications table
CREATE TABLE IF NOT EXISTS edit_classifications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID        NOT NULL REFERENCES workspaces(id),
  signal_id       UUID        NOT NULL REFERENCES draft_edit_signals(id),
  edit_categories TEXT[]      NOT NULL,
  severity        TEXT        NOT NULL,
  pattern_keys    TEXT[]      NOT NULL,
  analysis_notes  TEXT,
  llm_model       TEXT        NOT NULL,
  llm_latency_ms  INTEGER     NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_classifications_signal
  ON edit_classifications(signal_id);

CREATE INDEX IF NOT EXISTS idx_edit_classifications_workspace
  ON edit_classifications(workspace_id, created_at DESC);

-- 2c. pattern_recurrences table
CREATE TABLE IF NOT EXISTS pattern_recurrences (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID        NOT NULL REFERENCES workspaces(id),
  pattern_key      TEXT        NOT NULL,
  category         TEXT        NOT NULL,
  recurrence_count INTEGER     NOT NULL DEFAULT 1,
  distinct_clients INTEGER     NOT NULL DEFAULT 1,
  client_ids       UUID[]      NOT NULL DEFAULT '{}',
  first_seen       TIMESTAMPTZ NOT NULL,
  last_seen        TIMESTAMPTZ NOT NULL,
  promoted         BOOLEAN     NOT NULL DEFAULT false,
  promoted_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, pattern_key)
);

CREATE INDEX IF NOT EXISTS idx_pattern_recurrences_workspace
  ON pattern_recurrences(workspace_id, promoted, recurrence_count DESC);

-- 2d. communication_rules table
CREATE TABLE IF NOT EXISTS communication_rules (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID        NOT NULL REFERENCES workspaces(id),
  category            TEXT        NOT NULL,
  instruction         TEXT        NOT NULL,
  confidence          REAL        NOT NULL,
  source_pattern_key  TEXT        NOT NULL,
  source_type         TEXT        NOT NULL DEFAULT 'auto',
  example_edits       JSONB,
  active              BOOLEAN     NOT NULL DEFAULT true,
  promoted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, source_pattern_key)
);

DO $$ BEGIN
  ALTER TABLE communication_rules ADD CONSTRAINT chk_communication_rules_source_type
    CHECK (source_type IN ('auto', 'staff_flagged'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_communication_rules_active
  ON communication_rules(workspace_id, active, confidence DESC)
  WHERE active = true;

-- 2e. RLS policies for new tables
ALTER TABLE edit_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE pattern_recurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_rules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "workspace_isolation" ON edit_classifications
    FOR ALL USING (workspace_id = auth.workspace_id())
    WITH CHECK (workspace_id = auth.workspace_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "workspace_isolation" ON pattern_recurrences
    FOR ALL USING (workspace_id = auth.workspace_id())
    WITH CHECK (workspace_id = auth.workspace_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "workspace_isolation" ON communication_rules
    FOR ALL USING (workspace_id = auth.workspace_id())
    WITH CHECK (workspace_id = auth.workspace_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2f. pgmq queues for classify-edits
SELECT pgmq.create('classify_edits');
SELECT pgmq.create('classify_edits_dlq');

-- 2g. Trigger: enqueue edited_and_sent signals for classification
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

DROP TRIGGER IF EXISTS trg_enqueue_edit_signal ON draft_edit_signals;
CREATE TRIGGER trg_enqueue_edit_signal
  AFTER INSERT ON draft_edit_signals
  FOR EACH ROW EXECUTE FUNCTION enqueue_edit_signal();

-- 2h. Advisory lock RPC wrappers (PostgREST cannot call pg_try_advisory_lock directly)
CREATE OR REPLACE FUNCTION try_advisory_lock(lock_key BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN pg_try_advisory_lock(lock_key);
END;
$$;

CREATE OR REPLACE FUNCTION advisory_unlock(lock_key BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN pg_advisory_unlock(lock_key);
END;
$$;

-- 2i. RPC: atomic pattern recurrence upsert
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

- [ ] **Step 2: Verify migration syntax**

Run: `cd /Applications/Development/CRM-template && npx supabase db lint --schema public`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260323000001_sprint5_intelligence.sql
git commit -m "feat(sprint5): add migration for note extraction + learning loop tables"
```

---

## Task 2: Shared Types & Constants

**Files:**
- Create: `supabase/functions/_shared/types/extraction.ts`
- Create: `supabase/functions/_shared/types/learning.ts`

These are type-only files — no runtime logic to test. They define the contracts between all Sprint 5 modules.

- [ ] **Step 1: Create F-13 extraction types**

```typescript
// supabase/functions/_shared/types/extraction.ts

/** Categorization input sent to Haiku */
export interface CategorizationInput {
  note_content: string;
  note_created_at: string;
  client_profile: {
    full_name: string | null;
    phone_number: string | null;
    email: string | null;
    tags: string[];
    preferences: Record<string, unknown>;
    lifecycle_status: string;
  };
  workspace_custom_fields: string[];
  current_date: string;
  workspace_timezone: string;
  existing_open_promises: Array<{
    content: string;
    due_date: string | null;
  }>;
}

/** Individual extraction from categorization response */
export type Extraction =
  | {
      category: 'FOLLOW_UP';
      description: string;
      due_date: string | null;
    }
  | {
      category: 'PROMISE';
      description: string;
      due_date: string | null;
      is_duplicate: boolean;
    }
  | {
      category: 'CLIENT_UPDATE';
      field: string;
      before_value: unknown;
      after_value: unknown;
    };

/** Full categorization response from Haiku */
export interface CategorizationResponse {
  extractions: Extraction[];
}

/** Valid fields for CLIENT_UPDATE extractions */
export const UPDATABLE_FIELDS = [
  'full_name',
  'phone_number',
  'email',
  'tags',
  'lifecycle_status',
] as const;

/** Prefix for preference/custom field updates */
export const PREFERENCES_PREFIX = 'preferences.' as const;

/** Note extraction status lifecycle: pending → processing → complete/failed */
export type ExtractionStatus = 'pending' | 'processing' | 'complete' | 'failed' | 'not_applicable';

/** Context update parser result */
export interface ContextUpdateResult {
  isCommand: boolean;
  source?: 'conversation_update';
  parsedIntent?: {
    field: string;
    value: unknown;
    action: 'set' | 'add' | 'remove';
  };
}
```

- [ ] **Step 2: Create F-15 learning types**

```typescript
// supabase/functions/_shared/types/learning.ts

/** Fixed taxonomy of 17 edit categories */
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

/** Classification LLM response */
export interface ClassificationResponse {
  edit_categories: string[];
  severity: string;
  pattern_keys: string[];
  analysis_notes: string;
}

/** Pattern recurrence row from database */
export interface PatternRecurrence {
  id: string;
  workspace_id: string;
  pattern_key: string;
  category: string;
  recurrence_count: number;
  distinct_clients: number;
  client_ids: string[];
  first_seen: string;
  last_seen: string;
  promoted: boolean;
  promoted_at: string | null;
}

/** Promotion threshold check result */
export interface PromotionResult {
  shouldPromote: boolean;
  reason: string;
}

/** Communication rule row from database */
export interface CommunicationRule {
  id: string;
  workspace_id: string;
  category: string;
  instruction: string;
  confidence: number;
  source_pattern_key: string;
  source_type: 'auto' | 'staff_flagged';
  example_edits: Array<{ original: string; final: string }> | null;
  active: boolean;
  promoted_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/types/extraction.ts supabase/functions/_shared/types/learning.ts
git commit -m "feat(sprint5): add shared types for note extraction and learning loop"
```

---

## Task 3: Deadline Resolver (F-13)

**Files:**
- Create: `src/lib/learning/__tests__/deadline-resolver.test.ts`
- Create: `supabase/functions/_shared/deadline-resolver.ts`

Pure function: converts relative date references ("by Friday", "next week", "tomorrow") to absolute ISO dates using workspace timezone and reference date.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/learning/__tests__/deadline-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { resolveDeadline } from '../deadline-resolver';

describe('resolveDeadline', () => {
  const BASE_DATE = '2026-03-20'; // Friday
  const TZ = 'Asia/Hong_Kong';

  it('should resolve "tomorrow" to next day', () => {
    expect(resolveDeadline('tomorrow', BASE_DATE, TZ)).toBe('2026-03-21');
  });

  it('should resolve "today" to same day', () => {
    expect(resolveDeadline('today', BASE_DATE, TZ)).toBe('2026-03-20');
  });

  it('should resolve "next week" to next Monday', () => {
    expect(resolveDeadline('next week', BASE_DATE, TZ)).toBe('2026-03-23');
  });

  it('should resolve "by Friday" to next Friday when today is Friday', () => {
    expect(resolveDeadline('by Friday', BASE_DATE, TZ)).toBe('2026-03-27');
  });

  it('should resolve "by Wednesday" to next Wednesday', () => {
    expect(resolveDeadline('by Wednesday', BASE_DATE, TZ)).toBe('2026-03-25');
  });

  it('should resolve "in 3 days" to 3 days later', () => {
    expect(resolveDeadline('in 3 days', BASE_DATE, TZ)).toBe('2026-03-23');
  });

  it('should resolve "next month" to 1st of next month', () => {
    expect(resolveDeadline('next month', BASE_DATE, TZ)).toBe('2026-04-01');
  });

  it('should resolve "end of week" to upcoming Sunday', () => {
    expect(resolveDeadline('end of week', BASE_DATE, TZ)).toBe('2026-03-22');
  });

  it('should return null for vague references like "soon"', () => {
    expect(resolveDeadline('soon', BASE_DATE, TZ)).toBeNull();
  });

  it('should return null for "sometime"', () => {
    expect(resolveDeadline('sometime', BASE_DATE, TZ)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(resolveDeadline('', BASE_DATE, TZ)).toBeNull();
  });

  it('should pass through absolute ISO dates unchanged', () => {
    expect(resolveDeadline('2026-04-15', BASE_DATE, TZ)).toBe('2026-04-15');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/deadline-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// supabase/functions/_shared/deadline-resolver.ts

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IN_N_DAYS_RE = /^in\s+(\d+)\s+days?$/i;
const BY_DAY_RE = /^by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

/**
 * Resolve a relative date reference to an absolute ISO date (YYYY-MM-DD).
 * Returns null if the reference is too vague to resolve.
 */
export function resolveDeadline(
  reference: string,
  baseDateStr: string,
  _timezone: string,
): string | null {
  const trimmed = reference.trim().toLowerCase();
  if (!trimmed) return null;

  // Pass through absolute dates
  if (ISO_DATE_RE.test(trimmed)) return trimmed;

  const base = new Date(baseDateStr + 'T00:00:00');
  const baseDay = base.getDay(); // 0=Sun..6=Sat

  // "today"
  if (trimmed === 'today') {
    return baseDateStr;
  }

  // "tomorrow"
  if (trimmed === 'tomorrow') {
    return addDays(base, 1);
  }

  // "in N days"
  const inNMatch = trimmed.match(IN_N_DAYS_RE);
  if (inNMatch) {
    return addDays(base, parseInt(inNMatch[1], 10));
  }

  // "next week" → next Monday
  if (trimmed === 'next week') {
    const daysUntilMonday = ((1 - baseDay + 7) % 7) || 7;
    return addDays(base, daysUntilMonday);
  }

  // "end of week" → upcoming Sunday
  if (trimmed === 'end of week') {
    const daysUntilSunday = ((0 - baseDay + 7) % 7) || 7;
    return addDays(base, daysUntilSunday);
  }

  // "next month" → 1st of next month
  if (trimmed === 'next month') {
    const next = new Date(base);
    next.setMonth(next.getMonth() + 1);
    next.setDate(1);
    return formatDate(next);
  }

  // "by [day]" → next occurrence of that day (not today)
  const byDayMatch = trimmed.match(BY_DAY_RE);
  if (byDayMatch) {
    const targetDay = DAY_NAMES.indexOf(byDayMatch[1].toLowerCase());
    const daysUntil = ((targetDay - baseDay + 7) % 7) || 7;
    return addDays(base, daysUntil);
  }

  // Vague or unrecognized → null
  return null;
}

function addDays(date: Date, days: number): string {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return formatDate(result);
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
```

- [ ] **Step 4: Create re-export for Node.js test side**

```typescript
// src/lib/learning/deadline-resolver.ts
// Re-export for Node.js test runner (Edge Functions use the _shared/ version directly)
export { resolveDeadline } from '../../../supabase/functions/_shared/deadline-resolver';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/deadline-resolver.test.ts`
Expected: All 12 tests PASS

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/deadline-resolver.ts src/lib/learning/deadline-resolver.ts src/lib/learning/__tests__/deadline-resolver.test.ts
git commit -m "feat(f13): add deadline resolver for relative date references"
```

---

## Task 4: Categorization Prompt & Response Parser (F-13)

**Files:**
- Create: `src/lib/learning/__tests__/categorization-parser.test.ts`
- Create: `supabase/functions/_shared/categorization-prompt.ts`
- Create: `supabase/functions/_shared/categorization-parser.ts`

- [ ] **Step 1: Write failing tests for the response parser**

```typescript
// src/lib/learning/__tests__/categorization-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseCategorizationResponse } from '../categorization-parser';

describe('parseCategorizationResponse', () => {
  it('should parse a valid response with follow-up', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'FOLLOW_UP',
        description: 'Follow up about wedding quote',
        due_date: '2026-03-27',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.extractions).toHaveLength(1);
    expect(result!.extractions[0].category).toBe('FOLLOW_UP');
  });

  it('should parse a response with promise', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'PROMISE',
        description: 'Send revised quote',
        due_date: '2026-03-25',
        is_duplicate: false,
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.extractions[0].category).toBe('PROMISE');
  });

  it('should filter out duplicate promises', () => {
    const raw = JSON.stringify({
      extractions: [
        { category: 'PROMISE', description: 'Send quote', due_date: null, is_duplicate: true },
        { category: 'FOLLOW_UP', description: 'Check pricing', due_date: null },
      ],
    });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.extractions).toHaveLength(1);
    expect(result!.extractions[0].category).toBe('FOLLOW_UP');
  });

  it('should reject CLIENT_UPDATE with unknown field', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'CLIENT_UPDATE',
        field: 'internal_id',
        before_value: '123',
        after_value: '456',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.extractions).toHaveLength(0);
  });

  it('should allow CLIENT_UPDATE with preferences.* field', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'CLIENT_UPDATE',
        field: 'preferences.preferred_time',
        before_value: 'afternoons',
        after_value: 'mornings',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result!.extractions).toHaveLength(1);
  });

  it('should allow CLIENT_UPDATE with valid top-level field', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'CLIENT_UPDATE',
        field: 'full_name',
        before_value: 'Elizabeth Chen',
        after_value: 'Liz Chen',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result!.extractions).toHaveLength(1);
  });

  it('should return null for invalid JSON', () => {
    expect(parseCategorizationResponse('not json')).toBeNull();
  });

  it('should return null for missing extractions key', () => {
    expect(parseCategorizationResponse('{}')).toBeNull();
  });

  it('should handle empty extractions array', () => {
    const raw = JSON.stringify({ extractions: [] });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.extractions).toHaveLength(0);
  });

  it('should reject invalid due_date format', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'FOLLOW_UP',
        description: 'Test',
        due_date: 'not-a-date',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result!.extractions[0]).toHaveProperty('due_date', null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/categorization-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the categorization prompt**

```typescript
// supabase/functions/_shared/categorization-prompt.ts
import type { CategorizationInput } from './types/extraction.ts';

export const CATEGORIZATION_SYSTEM_PROMPT = `You are a CRM note categorization engine. Your job is to analyze a staff note about a client and extract structured, actionable items.

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
   Do NOT propose changes to fields not in this list.

For each extracted item, include:
- A clear, concise description
- The category (FOLLOW_UP, PROMISE, or CLIENT_UPDATE)
- For follow-ups and promises: a due_date if a temporal reference exists, or null if none
- For client updates: the field name, current value (before_value), and proposed value (after_value)

DEDUPLICATION: Compare any detected promises against the existing open promises list provided. If a promise is semantically equivalent to an existing one, set is_duplicate to true.

DATE RESOLUTION: When the note contains relative date references ("by Friday", "next week", "tomorrow"), resolve them to absolute ISO 8601 dates (YYYY-MM-DD) using the provided current date and timezone. If the reference is too vague ("soon", "sometime"), set due_date to null.

If the note contains NO actionable items, return an empty extractions array.

Respond with ONLY valid JSON matching this schema:
{
  "extractions": [
    { "category": "FOLLOW_UP", "description": "...", "due_date": "YYYY-MM-DD" | null },
    { "category": "PROMISE", "description": "...", "due_date": "YYYY-MM-DD" | null, "is_duplicate": false },
    { "category": "CLIENT_UPDATE", "field": "field_name", "before_value": "...", "after_value": "..." }
  ]
}`;

export function buildCategorizationUserMessage(input: CategorizationInput): string {
  const promises = input.existing_open_promises.length > 0
    ? input.existing_open_promises.map(p =>
        `- "${p.content}" (due: ${p.due_date ?? 'no date'})`
      ).join('\n')
    : 'None';

  return `Note text:
"${input.note_content}"

Note saved at: ${input.note_created_at}
Today's date: ${input.current_date}
Timezone: ${input.workspace_timezone}

Client profile:
- Name: ${input.client_profile.full_name ?? 'Unknown'}
- Phone: ${input.client_profile.phone_number ?? 'Unknown'}
- Email: ${input.client_profile.email ?? 'Unknown'}
- Tags: ${input.client_profile.tags.join(', ') || 'None'}
- Preferences: ${JSON.stringify(input.client_profile.preferences)}
- Lifecycle status: ${input.client_profile.lifecycle_status}

Workspace custom fields: ${input.workspace_custom_fields.join(', ') || 'None'}

Existing open promises for this client:
${promises}

Extract all actionable items from the note.`;
}
```

- [ ] **Step 4: Write the response parser**

```typescript
// supabase/functions/_shared/categorization-parser.ts
import type { CategorizationResponse, Extraction } from './types/extraction.ts';
import { UPDATABLE_FIELDS, PREFERENCES_PREFIX } from './types/extraction.ts';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse and validate the LLM categorization response.
 * Returns null if the response is entirely unparseable.
 * Filters out invalid extractions (unknown fields, duplicates).
 */
export function parseCategorizationResponse(raw: string): CategorizationResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[categorize] Failed to parse JSON response');
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('extractions' in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).extractions)
  ) {
    console.error('[categorize] Response missing extractions array');
    return null;
  }

  const rawExtractions = (parsed as { extractions: unknown[] }).extractions;
  const validExtractions: Extraction[] = [];

  for (const item of rawExtractions) {
    if (!item || typeof item !== 'object' || !('category' in item)) continue;
    const e = item as Record<string, unknown>;

    switch (e.category) {
      case 'FOLLOW_UP': {
        validExtractions.push({
          category: 'FOLLOW_UP',
          description: String(e.description ?? ''),
          due_date: validateDate(e.due_date),
        });
        break;
      }
      case 'PROMISE': {
        // Filter out duplicates
        if (e.is_duplicate === true) continue;
        validExtractions.push({
          category: 'PROMISE',
          description: String(e.description ?? ''),
          due_date: validateDate(e.due_date),
          is_duplicate: false,
        });
        break;
      }
      case 'CLIENT_UPDATE': {
        const field = String(e.field ?? '');
        if (!isUpdatableField(field)) {
          console.warn('[categorize] Rejected CLIENT_UPDATE for unknown field:', field);
          continue;
        }
        validExtractions.push({
          category: 'CLIENT_UPDATE',
          field,
          before_value: e.before_value,
          after_value: e.after_value,
        });
        break;
      }
    }
  }

  return { extractions: validExtractions };
}

function isUpdatableField(field: string): boolean {
  if ((UPDATABLE_FIELDS as readonly string[]).includes(field)) return true;
  if (field.startsWith(PREFERENCES_PREFIX)) return true;
  return false;
}

function validateDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!ISO_DATE_RE.test(value)) return null;
  return value;
}
```

- [ ] **Step 5: Create re-export for Node.js test side**

```typescript
// src/lib/learning/categorization-parser.ts
export { parseCategorizationResponse } from '../../../supabase/functions/_shared/categorization-parser';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/categorization-parser.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/categorization-prompt.ts supabase/functions/_shared/categorization-parser.ts src/lib/learning/categorization-parser.ts src/lib/learning/__tests__/categorization-parser.test.ts
git commit -m "feat(f13): add categorization prompt and response parser with tests"
```

---

## Task 5: categorize-note Edge Function (F-13)

**Files:**
- Create: `supabase/functions/categorize-note/index.ts`

**Depends on:** Tasks 1 (migration), 3 (deadline resolver), 4 (categorization prompt/parser)

The Edge Function receives `{ note_id, workspace_id, client_id }` from the pg_net trigger, loads context, calls Haiku, and writes proposed_actions for each extraction.

- [ ] **Step 1: Create the Edge Function**

```typescript
// supabase/functions/categorize-note/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getSupabaseClient } from '../_shared/supabase-client.ts';
import { callLLM } from '../_shared/llm-client.ts';
import { logLLMUsage } from '../_shared/llm-usage-logger.ts';
import { CATEGORIZATION_SYSTEM_PROMPT, buildCategorizationUserMessage } from '../_shared/categorization-prompt.ts';
import { parseCategorizationResponse } from '../_shared/categorization-parser.ts';
import type { CategorizationInput } from '../_shared/types/extraction.ts';

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { note_id, workspace_id, client_id } = await req.json();
  if (!note_id || !workspace_id || !client_id) {
    return new Response('Missing required fields', { status: 400 });
  }

  const supabase = getSupabaseClient();

  // 1. Atomically claim note for processing (optimistic lock)
  // This prevents duplicate extraction when pg_cron and pg_net fire concurrently
  const { data: note, error: noteErr } = await supabase
    .from('notes')
    .update({ extraction_status: 'processing' })
    .eq('id', note_id)
    .eq('workspace_id', workspace_id)
    .eq('extraction_status', 'pending')
    .select('id, content, source, extraction_retry_count, created_at')
    .single();

  if (noteErr || !note) {
    // Either not found or already claimed by another worker
    return new Response(JSON.stringify({ skipped: true, reason: 'not_pending_or_not_found' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Skip merge history notes
  if (note.source === 'merge_history') {
    await supabase
      .from('notes')
      .update({ extraction_status: 'not_applicable' })
      .eq('id', note_id);
    return new Response(JSON.stringify({ skipped: true, reason: 'merge_history' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Increment retry count
  await supabase
    .from('notes')
    .update({ extraction_retry_count: note.extraction_retry_count + 1 })
    .eq('id', note_id);

  try {
    // 2. Load context in parallel
    const [clientResult, workspaceResult, promisesResult] = await Promise.all([
      supabase
        .from('clients')
        .select('full_name, phone_number, email, tags, preferences, lifecycle_status')
        .eq('id', client_id)
        .eq('workspace_id', workspace_id)
        .single(),
      supabase
        .from('workspaces')
        .select('timezone, vertical_config')
        .eq('id', workspace_id)
        .single(),
      supabase
        .from('follow_ups')
        .select('content, due_date')
        .eq('client_id', client_id)
        .eq('workspace_id', workspace_id)
        .eq('type', 'promise')
        .in('status', ['open', 'pending']),
    ]);

    const client = clientResult.data;
    const workspace = workspaceResult.data;
    if (!client || !workspace) {
      throw new Error('Client or workspace not found');
    }

    const tz = workspace.timezone || 'UTC';
    const customFields: string[] =
      (workspace.vertical_config as Record<string, unknown>)?.customFields as string[] ?? [];

    // Compute current date in workspace timezone
    const currentDate = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    // 3. Build LLM input
    const input: CategorizationInput = {
      note_content: note.content,
      note_created_at: note.created_at,
      client_profile: {
        full_name: client.full_name,
        phone_number: client.phone_number,
        email: client.email,
        tags: client.tags ?? [],
        preferences: client.preferences ?? {},
        lifecycle_status: client.lifecycle_status ?? 'open',
      },
      workspace_custom_fields: customFields,
      current_date: currentDate,
      workspace_timezone: tz,
      existing_open_promises: promisesResult.data ?? [],
    };

    const userMessage = buildCategorizationUserMessage(input);

    // 4. Call Haiku
    const startMs = Date.now();
    const llmResult = await callLLM({
      model: 'cheap',
      systemPrompt: CATEGORIZATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 2000,
    });
    const latencyMs = Date.now() - startMs;

    // 5. Parse response
    const responseText = llmResult.message.content?.[0]?.type === 'text'
      ? llmResult.message.content[0].text
      : typeof llmResult.message.content === 'string'
        ? llmResult.message.content
        : '';

    const parsed = parseCategorizationResponse(responseText);

    if (!parsed) {
      throw new Error('Failed to parse categorization response');
    }

    // 6. Write proposed_actions for each extraction
    for (const extraction of parsed.extractions) {
      if (extraction.category === 'FOLLOW_UP') {
        await supabase.from('proposed_actions').insert({
          workspace_id,
          client_id,
          action_type: 'followup_create',
          summary: extraction.description,
          tier: 'review',
          payload: {
            type: 'follow_up',
            description: extraction.description,
            due_date: extraction.due_date,
            source_note_id: note_id,
            extraction_source: 'note_categorization',
          },
          status: 'pending',
          source_note_id: note_id,
        });
      } else if (extraction.category === 'PROMISE') {
        await supabase.from('proposed_actions').insert({
          workspace_id,
          client_id,
          action_type: 'followup_create',
          summary: `Promise: ${extraction.description}`,
          tier: 'review',
          payload: {
            type: 'promise',
            description: extraction.description,
            due_date: extraction.due_date,
            source_note_id: note_id,
            extraction_source: 'note_categorization',
          },
          status: 'pending',
          source_note_id: note_id,
        });
      } else if (extraction.category === 'CLIENT_UPDATE') {
        // Build before/after state for confirmation card
        const beforeState: Record<string, unknown> = {};
        const afterState: Record<string, unknown> = {};
        beforeState[extraction.field] = extraction.before_value;
        afterState[extraction.field] = extraction.after_value;

        await supabase.from('proposed_actions').insert({
          workspace_id,
          client_id,
          action_type: 'client_update',
          summary: `Update ${extraction.field}: ${JSON.stringify(extraction.before_value)} → ${JSON.stringify(extraction.after_value)}`,
          tier: 'review',
          payload: {
            before_state: beforeState,
            after_state: afterState,
            changed_fields: [extraction.field],
            extraction_source: 'note_categorization',
            source_note_id: note_id,
          },
          status: 'pending',
          source_note_id: note_id,
        });
      }
    }

    // 7. Mark extraction complete
    await supabase
      .from('notes')
      .update({
        extraction_status: 'complete',
        extraction_completed_at: new Date().toISOString(),
        extraction_error: null,
      })
      .eq('id', note_id);

    // 8. Log LLM usage (fire-and-log)
    try {
      await logLLMUsage(supabase, {
        workspaceId: workspace_id,
        clientId: client_id,
        edgeFunctionName: 'categorize-note',
        model: llmResult.model,
        tokensIn: llmResult.usage?.input_tokens ?? 0,
        tokensOut: llmResult.usage?.output_tokens ?? 0,
        latencyMs,
      });
    } catch (logErr) {
      console.warn('[categorize-note] Failed to log LLM usage:', logErr);
    }

    return new Response(
      JSON.stringify({
        success: true,
        extractions: parsed.extractions.length,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[categorize-note] Error:', err);

    // Mark as failed
    await supabase
      .from('notes')
      .update({
        extraction_status: note.extraction_retry_count + 1 >= 3 ? 'failed' : 'pending',
        extraction_error: err instanceof Error ? err.message : String(err),
      })
      .eq('id', note_id);

    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Applications/Development/CRM-template && npx tsc --noEmit`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/categorize-note/index.ts
git commit -m "feat(f13): add categorize-note Edge Function"
```

---

## Task 6: Notes API Enhancement + Context Update Parser (F-13)

**Files:**
- Create: `src/lib/learning/__tests__/context-update-parser.test.ts`
- Create: `supabase/functions/_shared/context-update-parser.ts`
- Create: `src/lib/learning/context-update-parser.ts`
- Modify: `src/app/api/workspaces/[workspaceId]/notes/route.ts`
- Modify: `src/lib/notes/schemas.ts`

- [ ] **Step 1: Write failing tests for context update parser**

```typescript
// src/lib/learning/__tests__/context-update-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseContextUpdate } from '../context-update-parser';

describe('parseContextUpdate', () => {
  it('should detect "update her name to Liz"', () => {
    const result = parseContextUpdate('update her name to Liz');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('full_name');
    expect(result.parsedIntent?.value).toBe('Liz');
    expect(result.parsedIntent?.action).toBe('set');
  });

  it('should detect "change his phone number to +85291234567"', () => {
    const result = parseContextUpdate("change his phone number to +85291234567");
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('phone_number');
    expect(result.parsedIntent?.value).toBe('+85291234567');
  });

  it('should detect "set email to liz@example.com"', () => {
    const result = parseContextUpdate('set email to liz@example.com');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('email');
    expect(result.parsedIntent?.value).toBe('liz@example.com');
  });

  it('should detect "add tag VIP"', () => {
    const result = parseContextUpdate('add tag VIP');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('tags');
    expect(result.parsedIntent?.value).toBe('VIP');
    expect(result.parsedIntent?.action).toBe('add');
  });

  it('should detect "remove tag inactive"', () => {
    const result = parseContextUpdate('remove tag inactive');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('tags');
    expect(result.parsedIntent?.value).toBe('inactive');
    expect(result.parsedIntent?.action).toBe('remove');
  });

  it('should NOT classify regular notes as commands', () => {
    const result = parseContextUpdate('Client prefers morning appointments and likes green tea');
    expect(result.isCommand).toBe(false);
  });

  it('should NOT classify observations mentioning names as commands', () => {
    const result = parseContextUpdate("She told me her name is Liz but I didn't update it yet");
    expect(result.isCommand).toBe(false);
  });

  it('should handle empty input', () => {
    const result = parseContextUpdate('');
    expect(result.isCommand).toBe(false);
  });

  it('should be case-insensitive', () => {
    const result = parseContextUpdate('UPDATE HER NAME TO Elizabeth');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.value).toBe('Elizabeth');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/context-update-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write context update parser**

```typescript
// supabase/functions/_shared/context-update-parser.ts
import type { ContextUpdateResult } from './types/extraction.ts';

// Field name mapping: pattern captures → canonical field names
const FIELD_MAP: Record<string, string> = {
  name: 'full_name',
  'full name': 'full_name',
  fullname: 'full_name',
  phone: 'phone_number',
  number: 'phone_number',
  'phone number': 'phone_number',
  phonenumber: 'phone_number',
  email: 'email',
};

// Patterns for set/update commands
const SET_PATTERNS = [
  /^(?:update|change|set|modify)\s+(?:her|his|their|client'?s?)?\s*(name|full\s?name|phone|number|phone\s?number|email)\s+(?:to|as)\s+(.+)$/i,
];

// Patterns for tag add/remove
const TAG_ADD_RE = /^add\s+tag\s+(.+)$/i;
const TAG_REMOVE_RE = /^(?:remove|delete)\s+tag\s+(.+)$/i;

/**
 * Classify whether staff input is an update command or a regular note.
 * False negatives are acceptable (async categorization catches them).
 * False positives are NOT acceptable (never misinterpret an observation as a command).
 */
export function parseContextUpdate(input: string): ContextUpdateResult {
  const trimmed = input.trim();
  if (!trimmed) return { isCommand: false };

  // Check set/update patterns
  for (const pattern of SET_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const rawField = match[1].toLowerCase().replace(/\s+/g, ' ');
      const field = FIELD_MAP[rawField];
      if (field) {
        return {
          isCommand: true,
          source: 'conversation_update',
          parsedIntent: {
            field,
            value: match[2].trim(),
            action: 'set',
          },
        };
      }
    }
  }

  // Check tag operations
  const addMatch = trimmed.match(TAG_ADD_RE);
  if (addMatch) {
    return {
      isCommand: true,
      source: 'conversation_update',
      parsedIntent: {
        field: 'tags',
        value: addMatch[1].trim(),
        action: 'add',
      },
    };
  }

  const removeMatch = trimmed.match(TAG_REMOVE_RE);
  if (removeMatch) {
    return {
      isCommand: true,
      source: 'conversation_update',
      parsedIntent: {
        field: 'tags',
        value: removeMatch[1].trim(),
        action: 'remove',
      },
    };
  }

  return { isCommand: false };
}
```

- [ ] **Step 4: Create re-export for Node.js test side**

```typescript
// src/lib/learning/context-update-parser.ts
export { parseContextUpdate } from '../../../supabase/functions/_shared/context-update-parser';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/context-update-parser.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 6: Update notes schema to include extraction_status**

In `src/lib/notes/schemas.ts`, expand the `source` enum and add extraction_status support:

Add `'conversation_update'` to the source enum if not already present. The notes POST route will set `extraction_status = 'pending'` for sources that need categorization, and `'not_applicable'` for `merge_history`.

- [ ] **Step 7: Update notes POST handler**

In `src/app/api/workspaces/[workspaceId]/notes/route.ts`, modify the POST handler to set `extraction_status` based on source:

```typescript
// After validation, before INSERT:
const extraction_status = body.source === 'merge_history' ? 'not_applicable' : 'pending';

// Add to INSERT payload:
// extraction_status
```

- [ ] **Step 8: Verify TypeScript compiles**

Run: `cd /Applications/Development/CRM-template && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/context-update-parser.ts src/lib/learning/context-update-parser.ts src/lib/learning/__tests__/context-update-parser.test.ts src/app/api/workspaces/\[workspaceId\]/notes/route.ts src/lib/notes/schemas.ts
git commit -m "feat(f13): add context update parser and notes extraction_status"
```

---

## Task 7: Classification Prompt & Response Parser (F-15)

**Files:**
- Create: `src/lib/learning/__tests__/classification-parser.test.ts`
- Create: `supabase/functions/_shared/classification-prompt.ts`
- Create: `supabase/functions/_shared/classification-parser.ts`
- Create: `src/lib/learning/classification-parser.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/learning/__tests__/classification-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseClassificationResponse } from '../classification-parser';

describe('parseClassificationResponse', () => {
  it('should parse a valid single-category response', () => {
    const raw = JSON.stringify({
      edit_categories: ['tone_warmed'],
      severity: 'significant',
      pattern_keys: ['soften_greeting_tone'],
      analysis_notes: 'Staff warmed the greeting from formal to casual',
    });
    const result = parseClassificationResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.edit_categories).toEqual(['tone_warmed']);
    expect(result!.severity).toBe('significant');
    expect(result!.pattern_keys).toEqual(['soften_greeting_tone']);
  });

  it('should parse a multi-category response', () => {
    const raw = JSON.stringify({
      edit_categories: ['shortened', 'cta_softened', 'upsell_removed'],
      severity: 'rewrite',
      pattern_keys: ['shorten_and_soften_reminders'],
      analysis_notes: 'Multiple changes',
    });
    const result = parseClassificationResponse(raw);
    expect(result!.edit_categories).toHaveLength(3);
  });

  it('should filter out unknown categories', () => {
    const raw = JSON.stringify({
      edit_categories: ['tone_warmed', 'invented_category', 'shortened'],
      severity: 'minor',
      pattern_keys: ['test'],
      analysis_notes: 'test',
    });
    const result = parseClassificationResponse(raw);
    expect(result!.edit_categories).toEqual(['tone_warmed', 'shortened']);
  });

  it('should return null when all categories are invalid', () => {
    const raw = JSON.stringify({
      edit_categories: ['fake_one', 'fake_two'],
      severity: 'minor',
      pattern_keys: ['test'],
      analysis_notes: 'test',
    });
    expect(parseClassificationResponse(raw)).toBeNull();
  });

  it('should default severity to significant when invalid', () => {
    const raw = JSON.stringify({
      edit_categories: ['tone_warmed'],
      severity: 'extreme',
      pattern_keys: ['test'],
      analysis_notes: 'test',
    });
    const result = parseClassificationResponse(raw);
    expect(result!.severity).toBe('significant');
  });

  it('should return null for invalid JSON', () => {
    expect(parseClassificationResponse('not json')).toBeNull();
  });

  it('should handle missing pattern_keys gracefully', () => {
    const raw = JSON.stringify({
      edit_categories: ['shortened'],
      severity: 'minor',
      analysis_notes: 'test',
    });
    const result = parseClassificationResponse(raw);
    expect(result!.pattern_keys).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/classification-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the classification prompt**

```typescript
// supabase/functions/_shared/classification-prompt.ts
import { EDIT_CATEGORIES } from './types/learning.ts';

export function buildClassificationPrompt(
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

export const CLASSIFICATION_FEW_SHOT = [
  {
    role: 'user' as const,
    content: 'Original Draft:\n"Dear Mr. Chen, I trust this message finds you well. I am writing to confirm your appointment."\n\nFinal Version:\n"Hey David! Just confirming your appointment tomorrow 😊"',
  },
  {
    role: 'assistant' as const,
    content: '{"edit_categories":["tone_warmed","shortened"],"severity":"significant","pattern_keys":["soften_greeting_tone"],"analysis_notes":"Staff replaced formal greeting with casual, shortened the message, and added emoji."}',
  },
  {
    role: 'user' as const,
    content: 'Original Draft:\n"Your next facial is coming up! By the way, have you considered our premium anti-aging package?"\n\nFinal Version:\n"Just a reminder about your facial appointment this Thursday!"',
  },
  {
    role: 'assistant' as const,
    content: '{"edit_categories":["upsell_removed","shortened"],"severity":"significant","pattern_keys":["remove_upsell_reminders"],"analysis_notes":"Staff removed the upsell pitch and shortened to a simple reminder."}',
  },
];
```

- [ ] **Step 4: Write the response parser**

```typescript
// supabase/functions/_shared/classification-parser.ts
import { EDIT_CATEGORIES, type EditCategory, type ClassificationResponse } from './types/learning.ts';

const VALID_SEVERITIES = ['minor', 'significant', 'rewrite'];

/**
 * Parse and validate classification LLM response.
 * Returns null if response is unparseable or has no valid categories.
 */
export function parseClassificationResponse(raw: string): ClassificationResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[classify] Failed to parse JSON response');
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.edit_categories)) return null;

  // Filter to valid categories only
  const validCategories = (obj.edit_categories as string[]).filter(
    (c: string) => (EDIT_CATEGORIES as readonly string[]).includes(c),
  );

  if (validCategories.length === 0) {
    console.warn('[classify] No valid categories in response');
    return null;
  }

  const severity = VALID_SEVERITIES.includes(obj.severity as string)
    ? (obj.severity as string)
    : 'significant';

  return {
    edit_categories: validCategories,
    severity,
    pattern_keys: Array.isArray(obj.pattern_keys) ? obj.pattern_keys : [],
    analysis_notes: typeof obj.analysis_notes === 'string' ? obj.analysis_notes : '',
  };
}
```

- [ ] **Step 5: Create re-export for Node.js test side**

```typescript
// src/lib/learning/classification-parser.ts
export { parseClassificationResponse } from '../../../supabase/functions/_shared/classification-parser';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/classification-parser.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/classification-prompt.ts supabase/functions/_shared/classification-parser.ts src/lib/learning/classification-parser.ts src/lib/learning/__tests__/classification-parser.test.ts
git commit -m "feat(f15): add edit classification prompt and response parser with tests"
```

---

## Task 8: Pattern Tracking & Promotion Logic (F-15)

**Files:**
- Create: `src/lib/learning/__tests__/pattern-tracking.test.ts`
- Create: `supabase/functions/_shared/pattern-tracking.ts`
- Create: `src/lib/learning/pattern-tracking.ts`
- Create: `supabase/functions/_shared/instruction-generator.ts`

- [ ] **Step 1: Write failing tests for promotion logic**

```typescript
// src/lib/learning/__tests__/pattern-tracking.test.ts
import { describe, it, expect } from 'vitest';
import { checkPromotionThreshold, calculateConfidence } from '../pattern-tracking';
import type { PatternRecurrence } from '../../../../supabase/functions/_shared/types/learning';

function makeRecurrence(overrides: Partial<PatternRecurrence> = {}): PatternRecurrence {
  return {
    id: 'rec-1',
    workspace_id: 'ws-1',
    pattern_key: 'soften_greeting_tone',
    category: 'tone_warmed',
    recurrence_count: 3,
    distinct_clients: 2,
    client_ids: ['c1', 'c2'],
    first_seen: '2026-03-01T00:00:00Z',
    last_seen: '2026-03-20T00:00:00Z',
    promoted: false,
    promoted_at: null,
    ...overrides,
  };
}

describe('checkPromotionThreshold', () => {
  it('should promote when all criteria met (3+ occurrences, 2+ clients, <=30d window)', () => {
    const result = checkPromotionThreshold(makeRecurrence());
    expect(result.shouldPromote).toBe(true);
    expect(result.reason).toBe('threshold_met');
  });

  it('should not promote when already promoted', () => {
    const result = checkPromotionThreshold(makeRecurrence({ promoted: true }));
    expect(result.shouldPromote).toBe(false);
    expect(result.reason).toBe('already_promoted');
  });

  it('should not promote with insufficient recurrence count', () => {
    const result = checkPromotionThreshold(makeRecurrence({ recurrence_count: 2 }));
    expect(result.shouldPromote).toBe(false);
    expect(result.reason).toContain('recurrence_count=2');
  });

  it('should not promote with only 1 distinct client', () => {
    const result = checkPromotionThreshold(makeRecurrence({ distinct_clients: 1 }));
    expect(result.shouldPromote).toBe(false);
    expect(result.reason).toContain('distinct_clients=1');
  });

  it('should not promote when window exceeds 30 days', () => {
    const result = checkPromotionThreshold(makeRecurrence({
      first_seen: '2026-01-01T00:00:00Z',
      last_seen: '2026-03-20T00:00:00Z',
    }));
    expect(result.shouldPromote).toBe(false);
    expect(result.reason).toContain('window=');
  });

  it('should promote with exactly 3 occurrences and 2 clients', () => {
    const result = checkPromotionThreshold(makeRecurrence({
      recurrence_count: 3,
      distinct_clients: 2,
    }));
    expect(result.shouldPromote).toBe(true);
  });

  it('should promote with high counts', () => {
    const result = checkPromotionThreshold(makeRecurrence({
      recurrence_count: 15,
      distinct_clients: 8,
    }));
    expect(result.shouldPromote).toBe(true);
  });
});

describe('calculateConfidence', () => {
  it('should return 0.3 for 3 occurrences', () => {
    expect(calculateConfidence(3)).toBeCloseTo(0.3);
  });

  it('should return 0.5 for 5 occurrences', () => {
    expect(calculateConfidence(5)).toBeCloseTo(0.5);
  });

  it('should cap at 1.0 for 10+ occurrences', () => {
    expect(calculateConfidence(10)).toBe(1.0);
    expect(calculateConfidence(15)).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/pattern-tracking.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write pattern tracking module**

```typescript
// supabase/functions/_shared/pattern-tracking.ts
import type { PatternRecurrence, PromotionResult } from './types/learning.ts';

/**
 * Check if a pattern meets the promotion threshold.
 * Criteria: 3+ occurrences, 2+ distinct clients, within 30-day window.
 */
export function checkPromotionThreshold(recurrence: PatternRecurrence): PromotionResult {
  if (recurrence.promoted) {
    return { shouldPromote: false, reason: 'already_promoted' };
  }

  const windowDays = Math.ceil(
    (new Date(recurrence.last_seen).getTime() -
      new Date(recurrence.first_seen).getTime()) /
    (1000 * 60 * 60 * 24),
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

/**
 * Linear confidence: 3 occurrences = 0.3, 10+ = 1.0
 */
export function calculateConfidence(recurrenceCount: number): number {
  return Math.min(1.0, recurrenceCount / 10);
}
```

- [ ] **Step 4: Write instruction generator**

```typescript
// supabase/functions/_shared/instruction-generator.ts
import { callLLM } from './llm-client.ts';

/**
 * Generate a human-readable communication rule instruction from example edits.
 * Called once at promotion time, not per-signal.
 */
export async function generateRuleInstruction(
  patternKey: string,
  category: string,
  exampleEdits: Array<{ original: string; final: string }>,
): Promise<string> {
  const prompt = `You are writing a communication instruction for an AI messaging assistant. Based on these examples of staff corrections, write a single clear instruction that the AI should follow in all future drafts.

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

  const result = await callLLM({
    model: 'cheap',
    systemPrompt: 'You write clear, concise communication instructions.',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 200,
  });

  const text = result.message.content?.[0]?.type === 'text'
    ? result.message.content[0].text
    : typeof result.message.content === 'string'
      ? result.message.content
      : '';

  return text.trim();
}
```

- [ ] **Step 5: Create re-export for Node.js test side**

```typescript
// src/lib/learning/pattern-tracking.ts
export { checkPromotionThreshold, calculateConfidence } from '../../../supabase/functions/_shared/pattern-tracking';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Applications/Development/CRM-template && npx vitest run src/lib/learning/__tests__/pattern-tracking.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/pattern-tracking.ts supabase/functions/_shared/instruction-generator.ts src/lib/learning/pattern-tracking.ts src/lib/learning/__tests__/pattern-tracking.test.ts
git commit -m "feat(f15): add pattern tracking, promotion logic, and instruction generator"
```

---

## Task 9: classify-edits Edge Function (F-15)

**Files:**
- Create: `supabase/functions/classify-edits/index.ts`

**Depends on:** Tasks 1 (migration), 7 (classification prompt/parser), 8 (pattern tracking)

Async worker that dequeues unclassified `draft_edit_signals`, classifies via Haiku, updates pattern recurrences, and promotes to rules when threshold is met.

- [ ] **Step 1: Create the Edge Function**

```typescript
// supabase/functions/classify-edits/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getSupabaseClient } from '../_shared/supabase-client.ts';
import { callLLM } from '../_shared/llm-client.ts';
import { logLLMUsage } from '../_shared/llm-usage-logger.ts';
import { buildClassificationPrompt, CLASSIFICATION_FEW_SHOT } from '../_shared/classification-prompt.ts';
import { parseClassificationResponse } from '../_shared/classification-parser.ts';
import { checkPromotionThreshold, calculateConfidence } from '../_shared/pattern-tracking.ts';
import { generateRuleInstruction } from '../_shared/instruction-generator.ts';

const BATCH_SIZE = 10;

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const supabase = getSupabaseClient();
  const body = await req.json().catch(() => ({}));

  // Support both pgmq-triggered (single signal) and cron-triggered (batch) modes
  const singleSignalId = body.signal_id as string | undefined;
  const workspaceId = body.workspace_id as string | undefined;

  // If single signal mode, process just that signal
  if (singleSignalId && workspaceId) {
    // Acquire advisory lock per workspace to prevent duplicate processing
    const { data: lockResult } = await supabase
      .rpc('try_advisory_lock', { lock_key: hashCode(`classify_edits:${workspaceId}`) })
      .single();

    if (!lockResult) {
      return new Response(JSON.stringify({ skipped: true, reason: 'locked' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const processed = await processSignal(supabase, singleSignalId, workspaceId);
      return new Response(JSON.stringify({ success: true, processed }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      await supabase.rpc('advisory_unlock', { lock_key: hashCode(`classify_edits:${workspaceId}`) });
    }
  }

  // Batch mode: fetch unprocessed signals (always_do_this first)
  const { data: signals } = await supabase
    .from('draft_edit_signals')
    .select('id, workspace_id, client_id, original_draft, final_version, intent_classified, scenario_type, always_do_this')
    .eq('staff_action', 'edited_and_sent')
    .is('processed_at', null)
    .not('original_draft', 'is', null)
    .not('final_version', 'is', null)
    .order('always_do_this', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (!signals || signals.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let processed = 0;
  for (const signal of signals) {
    try {
      await processSignal(supabase, signal.id, signal.workspace_id, signal);
      processed++;
    } catch (err) {
      console.error('[classify-edits] Error processing signal:', signal.id, err);
    }
  }

  return new Response(JSON.stringify({ processed }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

async function processSignal(
  supabase: ReturnType<typeof getSupabaseClient>,
  signalId: string,
  workspaceId: string,
  preloaded?: Record<string, unknown>,
) {
  // Load signal if not preloaded
  const signal = preloaded ?? (await supabase
    .from('draft_edit_signals')
    .select('id, workspace_id, client_id, original_draft, final_version, intent_classified, scenario_type, always_do_this, created_at')
    .eq('id', signalId)
    .single()
    .then(r => r.data));

  if (!signal) throw new Error(`Signal ${signalId} not found`);

  // Check if already processed
  const { data: existing } = await supabase
    .from('edit_classifications')
    .select('id')
    .eq('signal_id', signalId)
    .single();

  if (existing) {
    // Already classified, mark as processed
    await supabase
      .from('draft_edit_signals')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', signalId);
    return false;
  }

  // Load existing pattern keys for this workspace
  const { data: patternRows } = await supabase
    .from('pattern_recurrences')
    .select('pattern_key')
    .eq('workspace_id', workspaceId)
    .order('recurrence_count', { ascending: false })
    .limit(50);

  const existingKeys = (patternRows ?? []).map((r: { pattern_key: string }) => r.pattern_key);

  // Call Haiku for classification
  const classificationPrompt = buildClassificationPrompt(
    signal.original_draft as string,
    signal.final_version as string,
    signal.intent_classified as string | null,
    signal.scenario_type as string | null,
    existingKeys,
  );

  const startMs = Date.now();
  const llmResult = await callLLM({
    model: 'cheap',
    systemPrompt: 'You are an edit classifier. Respond with valid JSON only.',
    messages: [
      ...CLASSIFICATION_FEW_SHOT,
      { role: 'user', content: classificationPrompt },
    ],
    maxTokens: 500,
  });
  const latencyMs = Date.now() - startMs;

  const responseText = llmResult.message.content?.[0]?.type === 'text'
    ? llmResult.message.content[0].text
    : typeof llmResult.message.content === 'string'
      ? llmResult.message.content
      : '';

  const classification = parseClassificationResponse(responseText);
  if (!classification) {
    throw new Error('Failed to parse classification response');
  }

  // Write edit_classifications row
  await supabase.from('edit_classifications').insert({
    workspace_id: workspaceId,
    signal_id: signalId,
    edit_categories: classification.edit_categories,
    severity: classification.severity,
    pattern_keys: classification.pattern_keys,
    analysis_notes: classification.analysis_notes,
    llm_model: llmResult.model,
    llm_latency_ms: latencyMs,
  });

  // Update signal with classification results
  const primaryKey = classification.pattern_keys[0] ?? null;
  await supabase
    .from('draft_edit_signals')
    .update({
      edit_categories: classification.edit_categories,
      pattern_key: primaryKey,
      processed_at: new Date().toISOString(),
    })
    .eq('id', signalId);

  // Update pattern recurrences for each pattern key
  const primaryCategory = classification.edit_categories[0];

  for (const patternKey of classification.pattern_keys) {
    const { data: recurrence } = await supabase.rpc('upsert_pattern_recurrence', {
      p_workspace_id: workspaceId,
      p_pattern_key: patternKey,
      p_category: primaryCategory,
      p_client_id: signal.client_id as string,
      p_signal_created_at: signal.created_at as string ?? new Date().toISOString(),
    });

    if (!recurrence) continue;

    // Check for promotion (or bypass if always_do_this)
    if (signal.always_do_this) {
      await createRule(supabase, workspaceId, patternKey, primaryCategory, recurrence, 'staff_flagged', 0.5);
    } else {
      const promotion = checkPromotionThreshold(recurrence);
      if (promotion.shouldPromote) {
        await createRule(
          supabase, workspaceId, patternKey, primaryCategory, recurrence, 'auto',
          calculateConfidence(recurrence.recurrence_count),
        );
      }
    }
  }

  // Log LLM usage (fire-and-log)
  try {
    await logLLMUsage(supabase, {
      workspaceId,
      clientId: signal.client_id as string,
      edgeFunctionName: 'classify-edits',
      model: llmResult.model,
      tokensIn: llmResult.usage?.input_tokens ?? 0,
      tokensOut: llmResult.usage?.output_tokens ?? 0,
      latencyMs,
    });
  } catch (logErr) {
    console.warn('[classify-edits] Failed to log usage:', logErr);
  }

  return true;
}

async function createRule(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  patternKey: string,
  category: string,
  recurrence: Record<string, unknown>,
  sourceType: 'auto' | 'staff_flagged',
  confidence: number,
) {
  // Idempotency: check if rule already exists
  const { data: existing } = await supabase
    .from('communication_rules')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('source_pattern_key', patternKey)
    .single();

  if (existing) return;

  // Fetch representative examples for instruction generation
  const { data: examples } = await supabase
    .from('draft_edit_signals')
    .select('original_draft, final_version')
    .eq('workspace_id', workspaceId)
    .eq('pattern_key', patternKey)
    .eq('staff_action', 'edited_and_sent')
    .not('original_draft', 'is', null)
    .not('final_version', 'is', null)
    .order('created_at', { ascending: false })
    .limit(3);

  const exampleEdits = (examples ?? []).map((e: { original_draft: string; final_version: string }) => ({
    original: e.original_draft,
    final: e.final_version,
  }));

  // Generate instruction via LLM
  const instruction = await generateRuleInstruction(patternKey, category, exampleEdits);

  // Create rule
  await supabase.from('communication_rules').insert({
    workspace_id: workspaceId,
    category,
    instruction,
    confidence,
    source_pattern_key: patternKey,
    source_type: sourceType,
    example_edits: exampleEdits,
    active: true,
  });

  // Mark pattern as promoted
  await supabase
    .from('pattern_recurrences')
    .update({ promoted: true, promoted_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('pattern_key', patternKey);
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Applications/Development/CRM-template && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/classify-edits/index.ts
git commit -m "feat(f15): add classify-edits Edge Function with pattern promotion"
```

---

## Task 10: Rule Management API Routes (F-15)

**Files:**
- Create: `src/lib/rules/schemas.ts`
- Create: `src/app/api/workspaces/[workspaceId]/rules/route.ts`
- Create: `src/app/api/workspaces/[workspaceId]/rules/[ruleId]/route.ts`
- Create: `src/app/api/workspaces/[workspaceId]/rules/[ruleId]/details/route.ts`

- [ ] **Step 1: Create Zod schemas**

```typescript
// src/lib/rules/schemas.ts
import { z } from 'zod';

export const patchRuleSchema = z.object({
  instruction: z.string().min(1).max(2000).optional(),
  active: z.boolean().optional(),
}).refine(data => data.instruction !== undefined || data.active !== undefined, {
  message: 'At least one of instruction or active must be provided',
});
```

- [ ] **Step 2: Create GET /api/workspaces/[workspaceId]/rules**

```typescript
// src/app/api/workspaces/[workspaceId]/rules/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  const supabase = await createClient();
  await assertWorkspaceMember(supabase, workspaceId);

  const { data, error } = await supabase
    .from('communication_rules')
    .select('id, category, instruction, confidence, source_pattern_key, source_type, active, promoted_at, updated_at')
    .eq('workspace_id', workspaceId)
    .order('active', { ascending: false })
    .order('confidence', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ rules: data });
}
```

- [ ] **Step 3: Create PATCH /api/workspaces/[workspaceId]/rules/[ruleId]**

```typescript
// src/app/api/workspaces/[workspaceId]/rules/[ruleId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member';
import { patchRuleSchema } from '@/lib/rules/schemas';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; ruleId: string }> },
) {
  const { workspaceId, ruleId } = await params;
  const supabase = await createClient();
  await assertWorkspaceMember(supabase, workspaceId);

  const body = await req.json();
  const parsed = patchRuleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.instruction !== undefined) updates.instruction = parsed.data.instruction;
  if (parsed.data.active !== undefined) updates.active = parsed.data.active;

  const { data, error } = await supabase
    .from('communication_rules')
    .update(updates)
    .eq('id', ruleId)
    .eq('workspace_id', workspaceId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  }

  return NextResponse.json({ rule: data });
}
```

- [ ] **Step 4: Create GET /api/workspaces/[workspaceId]/rules/[ruleId]/details**

```typescript
// src/app/api/workspaces/[workspaceId]/rules/[ruleId]/details/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; ruleId: string }> },
) {
  const { workspaceId, ruleId } = await params;
  const supabase = await createClient();
  await assertWorkspaceMember(supabase, workspaceId);

  // Load rule
  const { data: rule, error: ruleErr } = await supabase
    .from('communication_rules')
    .select('*')
    .eq('id', ruleId)
    .eq('workspace_id', workspaceId)
    .single();

  if (ruleErr || !rule) {
    return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  }

  // Load source pattern recurrence
  const { data: pattern } = await supabase
    .from('pattern_recurrences')
    .select('recurrence_count, distinct_clients, first_seen, last_seen')
    .eq('workspace_id', workspaceId)
    .eq('pattern_key', rule.source_pattern_key)
    .single();

  // Load recent edit examples (up to 5)
  const { data: recentEdits } = await supabase
    .from('draft_edit_signals')
    .select('original_draft, final_version, created_at')
    .eq('workspace_id', workspaceId)
    .eq('pattern_key', rule.source_pattern_key)
    .eq('staff_action', 'edited_and_sent')
    .not('original_draft', 'is', null)
    .not('final_version', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5);

  return NextResponse.json({
    rule,
    pattern: pattern ?? null,
    recent_edits: recentEdits ?? [],
  });
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /Applications/Development/CRM-template && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/rules/schemas.ts src/app/api/workspaces/\[workspaceId\]/rules/
git commit -m "feat(f15): add rule management API routes (list, update, details)"
```

---

## Task 11: Context Assembly Rule Injection (F-15)

**Files:**
- Modify: `supabase/functions/_shared/context-assembly.ts`

This is the integration point where active communication rules are loaded and injected into the global context section of every Client Worker invocation. Read the file first.

- [ ] **Step 1: Read current context-assembly.ts**

Read `supabase/functions/_shared/context-assembly.ts` to understand the current structure and find the exact insertion point.

- [ ] **Step 2: Add loadCommunicationRules function**

Add a new loader function alongside the existing loaders (loadWorkspaceConfig, loadClientProfile, etc.):

```typescript
async function loadCommunicationRules(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('communication_rules')
    .select('instruction, confidence')
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .order('confidence', { ascending: false })
    .limit(20);

  return (data ?? []).map(
    (r: { instruction: string; confidence: number }) => r.instruction,
  );
}
```

- [ ] **Step 3: Integrate into assembleContext**

In the `Promise.all()` call within `assembleContext()`, add `loadCommunicationRules(supabase, workspaceId)` as an additional parallel query. Then include the rules in the returned context object, adding them to the global context section alongside tone profile and vertical config.

The rules should be formatted as a bullet list under a "## Communication Rules" heading in the global context string:

```typescript
// After loading rules in parallel:
const rulesSection = communicationRules.length > 0
  ? `\n\n## Communication Rules (learned from staff edits)\n${communicationRules.map(r => `- ${r}`).join('\n')}`
  : '';
// Append rulesSection to the global context string
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Applications/Development/CRM-template && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/context-assembly.ts
git commit -m "feat(f15): inject active communication rules into context assembly"
```

---

## Task 12: Integration Verification

**Files:** None created — verification only

- [ ] **Step 1: Run full TypeScript compilation**

Run: `cd /Applications/Development/CRM-template && npx tsc --noEmit`
Expected: PASS — zero type errors

- [ ] **Step 2: Run all tests**

Run: `cd /Applications/Development/CRM-template && npx vitest run`
Expected: All tests PASS (including new tests from Tasks 3, 4, 6, 7, 8)

- [ ] **Step 3: Verify new test count**

Run: `cd /Applications/Development/CRM-template && npx vitest run --reporter=verbose 2>&1 | grep -c "✓"`
Expected: At least 47 new test assertions across 4 test files:
- `deadline-resolver.test.ts` — 12 tests
- `categorization-parser.test.ts` — 10 tests
- `context-update-parser.test.ts` — 9 tests
- `classification-parser.test.ts` — 7 tests
- `pattern-tracking.test.ts` — 9 tests

- [ ] **Step 4: Verify Edge Function file structure**

Run: `ls supabase/functions/categorize-note/ supabase/functions/classify-edits/`
Expected: Both directories contain `index.ts`

- [ ] **Step 5: Verify API route structure**

Run: `find src/app/api/workspaces/\[workspaceId\]/rules -name "*.ts"`
Expected:
```
src/app/api/workspaces/[workspaceId]/rules/route.ts
src/app/api/workspaces/[workspaceId]/rules/[ruleId]/route.ts
src/app/api/workspaces/[workspaceId]/rules/[ruleId]/details/route.ts
```

- [ ] **Step 6: Verify migration file exists**

Run: `ls supabase/migrations/20260323000001_sprint5_intelligence.sql`
Expected: File exists

- [ ] **Step 7: Final commit (if any uncommitted verification fixes)**

```bash
git status
# If clean: no action needed
# If dirty: fix issues, commit with "fix(sprint5): address verification findings"
```

---

## Sprint 5 Exit Criteria Checklist

From `docs/phase-4-feature-design/priority-stack.md`:

- [ ] Staff notes are automatically categorized (follow-up extraction, preference updates, promise detection)
- [ ] Promise tracking creates follow-up records from conversational commitments with confirmation cards
- [ ] The LearningWorker classifies staff edits into stable pattern types
- [ ] Patterns meeting promotion threshold (3+ occurrences, 2+ clients, 30-day window) are promoted to CommunicationRules
- [ ] Active rules are injected into context assembly and measurably improve draft acceptance rate
- [ ] Staff can view, edit, and disable communication rules via API

---

## Architecture Alignment

All Sprint 5 code adheres to these locked architectural decisions:

| ADR | How Sprint 5 Follows It |
|-----|------------------------|
| ADR-1 (single agent) | Rules injected into Client Worker context, not as a separate agent. Categorization and classification are async LLM calls, not agent interactions. |
| ADR-3 (deterministic context) | Rules loaded via `loadCommunicationRules()` in `assembleContext()` — deterministic SQL query, not LLM-driven selection. |
| ADR-4 (COS → Client Worker) | Promise extraction from conversations dispatches through Client Worker path. Note categorization writes proposed_actions for F-06 approval flow. |
| ADR-6 (pg_net async) | Note categorization triggered by pg_net on INSERT. Edit classification triggered by pgmq on INSERT. Both non-blocking. |
