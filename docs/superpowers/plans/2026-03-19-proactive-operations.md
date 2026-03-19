# Proactive Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the two-pattern time-sensitive operations system — morning scan against live data (Pattern A) and event-driven timers with cancellation (Pattern B) — transforming the CRM from reactive to proactive.

**Architecture:** Daily 9 AM HK morning scan fans out per-workspace Edge Functions that query live tables for reminders, follow-ups, confirmations, inactivity, and journal generation. Event-driven timers (24h stale conversation, 1h draft nudge) use a `pending_timer` table scanned every 3 minutes. Separate 3 AM compaction cron compacts previous day's per-client memory. All proactive outputs flow through the existing ProposedAction approval system.

**Tech Stack:** Supabase Edge Functions (Deno), pg_cron + pg_net, PostgreSQL RPC functions, Vitest, OpenRouter (Haiku for compaction/journal), Supabase Realtime (staff notifications)

**Spec:** `docs/phase-4-feature-design/feature-specs/proactive-operations-cron.md`

---

## Dependency Graph

```
Task 1 (migration) ──── MUST GO FIRST
    │
    ├── Task 2 (shared types) ──── AFTER Task 1
    │       │
    │       ├── Task 3 (conversation state machine) ─┐
    │       ├── Task 4 (timer system + hooks)  ──────┤── PARALLEL
    │       ├── Task 5 (heartbeat)  ─────────────────┤
    │       └── Task 7 (compaction)  ────────────────┘
    │               │
    │               ├── Task 6 (morning scan)  ── depends on Tasks 3, 4
    │               │       │
    │               └── Task 8 (journal + verify) ── depends on Tasks 6, 7
    │
    └── Task 9 (staff notifications + Realtime) ── PARALLEL with Tasks 3-5
```

**Parallel execution groups:**
- Group A: Tasks 3, 4, 5, 7, 9 (all parallel after Task 2)
- Group B: Task 6 (after Tasks 3, 4 from Group A)
- Group C: Task 8 (after Tasks 6, 7)

---

## File Structure

### New files

```
supabase/migrations/
  20260320000001_proactive_operations.sql    # All schema changes + RPC + pg_cron

supabase/functions/_shared/
  conversation-state.ts                      # transitionConversation(), TRANSITION_MAP
  timer-helpers.ts                           # bestEffortStartTimer, bestEffortCancelTimer
  scan-and-propose.ts                        # Shared scan → Client Worker → ProposedAction pipeline
  proactive-types.ts                         # Types for proactive ops (PendingTimer, DailyJournal, etc.)

supabase/functions/cron-timer-scanner/
  index.ts                                   # Processes expired pending_timer rows in batches

supabase/functions/cron-morning-coordinator/
  index.ts                                   # Fans out per-workspace morning scans

supabase/functions/cron-morning-scan/
  index.ts                                   # Per-workspace: day-init + 5 sub-scans

supabase/functions/cron-compaction-coordinator/
  index.ts                                   # Fans out per-workspace compaction jobs

supabase/functions/cron-compaction/
  index.ts                                   # Per-workspace: compact previous day's client memory

supabase/functions/cron-heartbeat/
  index.ts                                   # Infrastructure health checks

src/lib/proactive/
  types.ts                                   # ConversationState, ConversationEvent, TimerType types
  __tests__/conversation-state.test.ts       # State machine unit tests
  __tests__/timer-helpers.test.ts            # Timer helper unit tests
  __tests__/morning-scan.test.ts             # Morning scan logic tests
  __tests__/compaction.test.ts               # Compaction logic tests
  conversation-state.ts                      # Next.js-side copy of state machine (shared logic)
  timer-helpers.ts                           # Next.js-side copy of timer helpers
```

### Modified files

```
supabase/functions/_shared/types.ts          # Add proactive ops type re-exports + AuditActionType additions
supabase/functions/process-message/index.ts  # Add bestEffortCancelTimer on inbound message
supabase/functions/approve-action/index.ts   # Add bestEffortCancelTimer on staff draft action
src/app/(dashboard)/inbox/[conversationId]/actions.ts  # Add bestEffortStartTimer on staff send
supabase/functions/_shared/draft-persistence.ts        # Add bestEffortStartTimer on draft created
supabase/functions/_shared/action-executor.ts          # Add bestEffortCancelTimer on booking confirmed
```

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/20260320000001_proactive_operations.sql`

This migration adds ALL schema changes for proactive operations in a single file. It must run first — every other task depends on it.

- [ ] **Step 1: Create the migration file with new tables**

```sql
-- supabase/migrations/20260320000001_proactive_operations.sql
-- Proactive Operations: tables, columns, indexes, RPC functions, pg_cron

-- ═══════════════════════════════════════════════════════════
-- 1. New tables
-- ═══════════════════════════════════════════════════════════

-- 1a. pending_timer — event-driven timers with cancellation
CREATE TABLE pending_timer (
  timer_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  timer_type    TEXT NOT NULL,
  trigger_at    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'fired', 'cancelled', 'error')),
  target_entity TEXT NOT NULL,
  target_id     UUID NOT NULL,
  payload       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fired_at      TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT,
  error_details JSONB
);

-- Partial unique: one active timer per target per type
CREATE UNIQUE INDEX idx_pending_timer_dedup
  ON pending_timer (target_id, timer_type)
  WHERE status = 'pending';

-- Scanner index: only pending timers by trigger time
CREATE INDEX idx_pending_timer_scan
  ON pending_timer (trigger_at)
  WHERE status = 'pending';

-- RLS
ALTER TABLE pending_timer ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on pending_timer"
  ON pending_timer FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY "Workspace members read own timers"
  ON pending_timer FOR SELECT
  TO authenticated
  USING (workspace_id = auth.workspace_id());

-- 1b. daily_journal — workspace daily operational diary
CREATE TABLE daily_journal (
  journal_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  date          DATE NOT NULL,
  stats         JSONB NOT NULL,
  narrative     TEXT,
  learning_snapshot JSONB,
  alerts        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, date)
);

ALTER TABLE daily_journal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on daily_journal"
  ON daily_journal FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY "Workspace members read own journals"
  ON daily_journal FOR SELECT
  TO authenticated
  USING (workspace_id = auth.workspace_id());

-- 1c. staff_notifications — Realtime-powered notification records
CREATE TABLE staff_notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id),
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  metadata        JSONB,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE staff_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on staff_notifications"
  ON staff_notifications FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY "Workspace members read own notifications"
  ON staff_notifications FOR SELECT
  TO authenticated
  USING (workspace_id = auth.workspace_id());

-- Enable Supabase Realtime for push notifications
ALTER PUBLICATION supabase_realtime ADD TABLE staff_notifications;

-- 1d. cron_run_log — audit log for cron job executions
CREATE TABLE cron_run_log (
  run_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID REFERENCES workspaces(id),
  job_type       TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'success', 'partial_failure', 'failed')),
  items_found    INTEGER DEFAULT 0,
  items_actioned INTEGER DEFAULT 0,
  error_details  JSONB,
  metadata       JSONB
);

ALTER TABLE cron_run_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on cron_run_log"
  ON cron_run_log FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
```

- [ ] **Step 2: Add columns to existing tables**

```sql
-- ═══════════════════════════════════════════════════════════
-- 2. New columns on existing tables
-- ═══════════════════════════════════════════════════════════

-- 2a. Conversation state constraint
ALTER TABLE conversations
  ADD CONSTRAINT chk_conversation_state
  CHECK (state IN ('idle', 'awaiting_staff_review', 'awaiting_client_reply', 'follow_up_pending'));

-- 2b. Follow-up tracking on conversations
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS follow_up_attempt_count INTEGER NOT NULL DEFAULT 0;

-- 2c. Workspace config fields for proactive operations
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS follow_up_check_days INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS follow_up_max_attempts INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS confirmation_check_days INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS inactivity_days INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS journal_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminder_mode TEXT NOT NULL DEFAULT 'template'
    CHECK (reminder_mode IN ('template', 'ai_draft'));

-- 2d. Booking reminder tracking
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- 2e. Client compaction tracking
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS last_compacted_at TIMESTAMPTZ;
```

- [ ] **Step 3: Add indexes**

```sql
-- ═══════════════════════════════════════════════════════════
-- 3. Indexes
-- ═══════════════════════════════════════════════════════════

-- Supports morning scan Scan 2 NOT EXISTS subquery at scale
CREATE INDEX IF NOT EXISTS idx_messages_conv_direction_ts
  ON messages (conversation_id, direction, timestamp DESC);

-- Client compaction activity detection
CREATE INDEX IF NOT EXISTS idx_clients_last_compacted
  ON clients (workspace_id, last_compacted_at)
  WHERE deleted_at IS NULL;
```

- [ ] **Step 4: Add RPC functions for timer lifecycle**

```sql
-- ═══════════════════════════════════════════════════════════
-- 4. RPC functions (timer lifecycle)
-- ═══════════════════════════════════════════════════════════

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

- [ ] **Step 5: Add pg_cron schedule definitions**

```sql
-- ═══════════════════════════════════════════════════════════
-- 5. pg_cron schedules (all UTC, hardcoded for HK UTC+8)
-- ═══════════════════════════════════════════════════════════

-- Morning scan coordinator: 9 AM HK = 1:00 UTC
SELECT cron.schedule(
  'morning-scan',
  '0 1 * * *',
  $cron$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/cron-morning-coordinator',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- Morning scan retry: 9:30 AM HK = 1:30 UTC
SELECT cron.schedule(
  'morning-scan-retry',
  '30 1 * * *',
  $cron$
  DO $$
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
          'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
          'Content-Type', 'application/json'
        ),
        body := '{"retry": true}'::jsonb
      );
    END IF;
  END $$;
  $cron$
);

-- Compaction coordinator: 3 AM HK (+1 day) = 19:00 UTC
SELECT cron.schedule(
  'compaction',
  '0 19 * * *',
  $cron$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/cron-compaction-coordinator',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- Timer scanner: every 3 minutes
SELECT cron.schedule(
  'timer-scanner',
  '*/3 * * * *',
  $cron$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/cron-timer-scanner',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- System heartbeat: every 2 hours
SELECT cron.schedule(
  'system-heartbeat',
  '0 */2 * * *',
  $cron$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/cron-heartbeat',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cron$
);
```

- [ ] **Step 6: Verify migration applies cleanly**

Run: `npx supabase db diff` or review the migration SQL for syntax errors.
Expected: No syntax errors. All table/column/function definitions are valid.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260320000001_proactive_operations.sql
git commit -m "feat: add proactive operations database migration

Tables: pending_timer, daily_journal, staff_notifications, cron_run_log
Columns: conversation state CHECK, follow_up_attempt_count, workspace config fields,
booking reminder_sent_at, client last_compacted_at
RPC: create_or_reset_timer, cancel_timer (partial unique index safe)
pg_cron: morning-scan, retry, compaction, timer-scanner, heartbeat
Indexes: messages(conversation_id, direction, timestamp DESC), clients(last_compacted_at)"
```

---

## Task 2: Shared Types

**Files:**
- Create: `supabase/functions/_shared/proactive-types.ts`
- Modify: `supabase/functions/_shared/types.ts`

- [ ] **Step 1: Create proactive-types.ts**

```typescript
// supabase/functions/_shared/proactive-types.ts
// Types for proactive operations (Pattern A + B)

// ─── Conversation State Machine ──────────────────────────

export type ConversationState =
  | 'idle'
  | 'awaiting_staff_review'
  | 'awaiting_client_reply'
  | 'follow_up_pending'

export type ConversationEvent =
  | 'inbound_message'
  | 'staff_sends'
  | 'staff_resolves'
  | 'client_messages'
  | 'timeout_24h'
  | 'follow_up_sent'

export type TransitionTriggerSource =
  | 'timer'
  | 'morning_scan'
  | 'staff_action'
  | 'inbound_message'

// ─── Timer Types ─────────────────────────────────────────

export type TimerType = 'stale_conversation' | 'draft_review_nudge'

export type TimerStatus = 'pending' | 'fired' | 'cancelled' | 'error'

export interface PendingTimer {
  timer_id: string
  workspace_id: string
  timer_type: TimerType
  trigger_at: string
  status: TimerStatus
  target_entity: string
  target_id: string
  payload: Record<string, unknown> | null
  created_at: string
  fired_at: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  error_details: Record<string, unknown> | null
}

// ─── Morning Scan Types ──────────────────────────────────

export interface ScanConfig {
  candidates: Array<{
    clientId: string
    conversationId: string
    [key: string]: unknown
  }>
  proposalType: string
  reason: string
  tier: 'auto' | 'review' | 'human_only'
  metadata?: Record<string, unknown>
}

export interface ScanResult {
  found: number
  actioned: number
}

export interface CronRunLog {
  run_id: string
  workspace_id: string | null
  job_type: string
  started_at: string
  completed_at: string | null
  status: 'running' | 'success' | 'partial_failure' | 'failed'
  items_found: number
  items_actioned: number
  error_details: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}

// ─── Daily Journal Types ─────────────────────────────────

export interface DailyJournalStats {
  clients_interacted: number
  new_clients: number
  messages_inbound: number
  messages_outbound: number
  drafts_generated: number
  drafts_sent_as_is: number
  drafts_edited: number
  drafts_discarded: number
  bookings_created: number
  bookings_cancelled: number
  bookings_completed: number
  follow_ups_sent: number
  follow_ups_dismissed: number
  clients_marked_inactive: number
}

export interface LearningSnapshot {
  acceptance_rate_today: number
  common_edit_categories: string[]
  new_patterns_detected: string[]
  rules_promoted_today: string[]
}

export interface DailyJournal {
  journal_id: string
  workspace_id: string
  date: string
  stats: DailyJournalStats
  narrative: string | null
  learning_snapshot: LearningSnapshot | null
  alerts: string[] | null
  created_at: string
}

// ─── Staff Notification Types ────────────────────────────

export interface StaffNotification {
  notification_id: string
  workspace_id: string
  type: string
  title: string
  body: string | null
  metadata: Record<string, unknown> | null
  read_at: string | null
  created_at: string
}
```

- [ ] **Step 2: Update types.ts to add new audit action types**

Add `'conversation_state_transition'` and `'cron_scan_completed'` to `AuditActionType` in `supabase/functions/_shared/types.ts`, and re-export proactive types.

```typescript
// Add to AuditActionType union:
  | 'conversation_state_transition'
  | 'cron_scan_completed'
  | 'timer_fired'
  | 'timer_cancelled'
  | 'client_marked_inactive'

// Add re-export at bottom:
export type {
  ConversationState,
  ConversationEvent,
  TransitionTriggerSource,
  TimerType,
  TimerStatus,
  PendingTimer,
  ScanConfig,
  ScanResult,
  CronRunLog,
  DailyJournal,
  DailyJournalStats,
  LearningSnapshot,
  StaffNotification,
} from './proactive-types.ts'
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/proactive-types.ts supabase/functions/_shared/types.ts
git commit -m "feat: add shared types for proactive operations

ConversationState machine types, PendingTimer, DailyJournal, ScanConfig,
StaffNotification, CronRunLog, LearningSnapshot. New AuditActionTypes for
state transitions, cron scans, timer lifecycle."
```

---

## Task 3: Conversation State Machine

**Files:**
- Create: `supabase/functions/_shared/conversation-state.ts`
- Create: `src/lib/proactive/__tests__/conversation-state.test.ts`
- Create: `src/lib/proactive/conversation-state.ts` (Next.js-side copy for tests)

**Test coverage:** T55 (valid transition), T56 (invalid transition), T57 (audit event written)

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/proactive/__tests__/conversation-state.test.ts
import { describe, it, expect } from 'vitest'
import { TRANSITION_MAP, getNextState } from '../conversation-state'

describe('ConversationStateMachine', () => {
  describe('getNextState', () => {
    it('should transition idle → awaiting_staff_review on inbound_message', () => {
      expect(getNextState('idle', 'inbound_message')).toBe('awaiting_staff_review')
    })

    it('should transition awaiting_staff_review → awaiting_client_reply on staff_sends', () => {
      expect(getNextState('awaiting_staff_review', 'staff_sends')).toBe('awaiting_client_reply')
    })

    it('should transition awaiting_client_reply → follow_up_pending on timeout_24h', () => {
      expect(getNextState('awaiting_client_reply', 'timeout_24h')).toBe('follow_up_pending')
    })

    it('should transition awaiting_client_reply → idle on client_messages', () => {
      expect(getNextState('awaiting_client_reply', 'client_messages')).toBe('idle')
    })

    it('should transition follow_up_pending → awaiting_client_reply on follow_up_sent', () => {
      expect(getNextState('follow_up_pending', 'follow_up_sent')).toBe('awaiting_client_reply')
    })

    it('should transition follow_up_pending → idle on client_messages', () => {
      expect(getNextState('follow_up_pending', 'client_messages')).toBe('idle')
    })

    it('should transition follow_up_pending → idle on staff_resolves', () => {
      expect(getNextState('follow_up_pending', 'staff_resolves')).toBe('idle')
    })

    it('should throw on invalid transition idle → follow_up_pending', () => {
      expect(() => getNextState('idle', 'timeout_24h')).toThrow('Invalid transition')
    })

    it('should throw on unknown state', () => {
      expect(() => getNextState('bogus' as any, 'staff_sends')).toThrow('Invalid transition')
    })

    it('should throw on unknown event', () => {
      expect(() => getNextState('idle', 'bogus' as any)).toThrow('Invalid transition')
    })
  })

  describe('TRANSITION_MAP', () => {
    it('should have entries for all 4 states', () => {
      expect(Object.keys(TRANSITION_MAP)).toHaveLength(4)
      expect(TRANSITION_MAP).toHaveProperty('idle')
      expect(TRANSITION_MAP).toHaveProperty('awaiting_staff_review')
      expect(TRANSITION_MAP).toHaveProperty('awaiting_client_reply')
      expect(TRANSITION_MAP).toHaveProperty('follow_up_pending')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/proactive/__tests__/conversation-state.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the state machine (Next.js-side for tests)**

```typescript
// src/lib/proactive/conversation-state.ts
import type { ConversationState, ConversationEvent } from './types'

export type { ConversationState, ConversationEvent }

export const TRANSITION_MAP: Record<string, Record<string, string>> = {
  idle: {
    inbound_message: 'awaiting_staff_review',
  },
  awaiting_staff_review: {
    staff_sends: 'awaiting_client_reply',
    staff_resolves: 'idle',
  },
  awaiting_client_reply: {
    client_messages: 'idle',
    timeout_24h: 'follow_up_pending',
    staff_resolves: 'idle',
  },
  follow_up_pending: {
    client_messages: 'idle',
    follow_up_sent: 'awaiting_client_reply',
    staff_resolves: 'idle',
  },
}

export function getNextState(
  currentState: string,
  event: string
): string {
  const nextState = TRANSITION_MAP[currentState]?.[event]
  if (!nextState) {
    throw new Error(
      `Invalid transition: state="${currentState}" event="${event}"`
    )
  }
  return nextState
}
```

Also create `src/lib/proactive/types.ts` with the type definitions:

```typescript
// src/lib/proactive/types.ts
export type ConversationState =
  | 'idle'
  | 'awaiting_staff_review'
  | 'awaiting_client_reply'
  | 'follow_up_pending'

export type ConversationEvent =
  | 'inbound_message'
  | 'staff_sends'
  | 'staff_resolves'
  | 'client_messages'
  | 'timeout_24h'
  | 'follow_up_sent'

export type TransitionTriggerSource =
  | 'timer'
  | 'morning_scan'
  | 'staff_action'
  | 'inbound_message'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/proactive/__tests__/conversation-state.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Create Edge Function version**

```typescript
// supabase/functions/_shared/conversation-state.ts
import type { ConversationState, ConversationEvent, TransitionTriggerSource } from './proactive-types.ts'
import { getSupabaseClient } from './db.ts'

export const TRANSITION_MAP: Record<string, Record<string, string>> = {
  idle: { inbound_message: 'awaiting_staff_review' },
  awaiting_staff_review: { staff_sends: 'awaiting_client_reply', staff_resolves: 'idle' },
  awaiting_client_reply: { client_messages: 'idle', timeout_24h: 'follow_up_pending', staff_resolves: 'idle' },
  follow_up_pending: { client_messages: 'idle', follow_up_sent: 'awaiting_client_reply', staff_resolves: 'idle' },
}

export function getNextState(currentState: string, event: string): string {
  const nextState = TRANSITION_MAP[currentState]?.[event]
  if (!nextState) {
    throw new Error(`Invalid transition: state="${currentState}" event="${event}"`)
  }
  return nextState
}

export async function transitionConversation(
  conversationId: string,
  event: ConversationEvent,
  triggerSource: TransitionTriggerSource
): Promise<void> {
  const supabase = getSupabaseClient()

  // Fetch current state
  const { data: conv, error: fetchError } = await supabase
    .from('conversations')
    .select('state, workspace_id')
    .eq('id', conversationId)
    .single()

  if (fetchError || !conv) {
    throw new Error(`Conversation ${conversationId} not found`)
  }

  const nextState = getNextState(conv.state, event)

  // Update state
  const { error: updateError } = await supabase
    .from('conversations')
    .update({ state: nextState })
    .eq('id', conversationId)

  if (updateError) {
    throw new Error(`Failed to update conversation state: ${updateError.message}`)
  }

  // Write audit event (fire-and-log)
  await supabase.from('audit_events').insert({
    workspace_id: conv.workspace_id,
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
  }).then(({ error }) => {
    if (error) console.error('[state] Audit event failed:', error)
  })
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/proactive/ supabase/functions/_shared/conversation-state.ts
git commit -m "feat: add conversation state machine with transition map and audit trail

TRANSITION_MAP enforces valid state transitions. getNextState() throws on invalid.
transitionConversation() updates DB state + writes audit event.
States: idle, awaiting_staff_review, awaiting_client_reply, follow_up_pending
Events: inbound_message, staff_sends, staff_resolves, client_messages, timeout_24h, follow_up_sent"
```

---

## Task 4: Timer System + Hooks

**Files:**
- Create: `supabase/functions/_shared/timer-helpers.ts`
- Create: `supabase/functions/cron-timer-scanner/index.ts`
- Create: `src/lib/proactive/__tests__/timer-helpers.test.ts`
- Modify: `supabase/functions/process-message/index.ts`
- Modify: `supabase/functions/approve-action/index.ts`
- Modify: `src/app/(dashboard)/inbox/[conversationId]/actions.ts`
- Modify: `supabase/functions/_shared/draft-persistence.ts`

**Test coverage:** T29-T49 (timer lifecycle, hooks, scanner)

This is the largest task. It implements the full timer lifecycle: helpers, scanner Edge Function, and hooks in existing code.

- [ ] **Step 1: Write timer helper tests**

```typescript
// src/lib/proactive/__tests__/timer-helpers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase
const mockRpc = vi.fn()
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    rpc: mockRpc,
  }),
}))

import { bestEffortStartTimer, bestEffortCancelTimer } from '../timer-helpers'

describe('TimerHelpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRpc.mockResolvedValue({ error: null })
  })

  describe('bestEffortStartTimer', () => {
    it('should call create_or_reset_timer RPC with correct params', async () => {
      await bestEffortStartTimer(
        'ws-1', 'stale_conversation', 'conversation', 'conv-1', 86400000
      )

      expect(mockRpc).toHaveBeenCalledWith('create_or_reset_timer', {
        p_workspace_id: 'ws-1',
        p_timer_type: 'stale_conversation',
        p_target_entity: 'conversation',
        p_target_id: 'conv-1',
        p_trigger_at: expect.any(String),
        p_payload: null,
      })
    })

    it('should not throw when RPC fails', async () => {
      mockRpc.mockRejectedValue(new Error('DB down'))
      await expect(
        bestEffortStartTimer('ws-1', 'stale_conversation', 'conversation', 'conv-1', 86400000)
      ).resolves.not.toThrow()
    })

    it('should pass payload when provided', async () => {
      await bestEffortStartTimer(
        'ws-1', 'draft_review_nudge', 'draft', 'd-1', 3600000, { draftId: 'd-1' }
      )
      expect(mockRpc).toHaveBeenCalledWith('create_or_reset_timer', expect.objectContaining({
        p_payload: { draftId: 'd-1' },
      }))
    })
  })

  describe('bestEffortCancelTimer', () => {
    it('should call cancel_timer RPC with correct params', async () => {
      await bestEffortCancelTimer('conv-1', 'stale_conversation', 'client_messaged')
      expect(mockRpc).toHaveBeenCalledWith('cancel_timer', {
        p_target_id: 'conv-1',
        p_timer_type: 'stale_conversation',
        p_reason: 'client_messaged',
      })
    })

    it('should not throw when RPC fails', async () => {
      mockRpc.mockRejectedValue(new Error('DB down'))
      await expect(
        bestEffortCancelTimer('conv-1', 'stale_conversation', 'client_messaged')
      ).resolves.not.toThrow()
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/proactive/__tests__/timer-helpers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement timer helpers (Next.js-side for tests)**

```typescript
// src/lib/proactive/timer-helpers.ts
import { getServiceClient } from '@/lib/supabase/service'
import type { TimerType } from './types'

export async function bestEffortStartTimer(
  workspaceId: string,
  timerType: TimerType,
  targetEntity: string,
  targetId: string,
  durationMs: number,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = getServiceClient()
    await supabase.rpc('create_or_reset_timer', {
      p_workspace_id: workspaceId,
      p_timer_type: timerType,
      p_target_entity: targetEntity,
      p_target_id: targetId,
      p_trigger_at: new Date(Date.now() + durationMs).toISOString(),
      p_payload: payload ?? null,
    })
  } catch (err) {
    console.error(`[timer] Failed to start ${timerType} for ${targetId}:`, err)
  }
}

export async function bestEffortCancelTimer(
  targetId: string,
  timerType: string,
  reason: string
): Promise<void> {
  try {
    const supabase = getServiceClient()
    await supabase.rpc('cancel_timer', {
      p_target_id: targetId,
      p_timer_type: timerType,
      p_reason: reason,
    })
  } catch (err) {
    console.error(`[timer] Failed to cancel ${timerType} for ${targetId}:`, err)
  }
}
```

Add `TimerType` to `src/lib/proactive/types.ts`:

```typescript
export type TimerType = 'stale_conversation' | 'draft_review_nudge'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/proactive/__tests__/timer-helpers.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Create Edge Function timer helpers**

```typescript
// supabase/functions/_shared/timer-helpers.ts
import type { TimerType } from './proactive-types.ts'
import { getSupabaseClient } from './db.ts'

export async function bestEffortStartTimer(
  workspaceId: string,
  timerType: TimerType,
  targetEntity: string,
  targetId: string,
  durationMs: number,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = getSupabaseClient()
    await supabase.rpc('create_or_reset_timer', {
      p_workspace_id: workspaceId,
      p_timer_type: timerType,
      p_target_entity: targetEntity,
      p_target_id: targetId,
      p_trigger_at: new Date(Date.now() + durationMs).toISOString(),
      p_payload: payload ?? null,
    })
  } catch (err) {
    console.error(`[timer] Failed to start ${timerType} for ${targetId}:`, err)
  }
}

export async function bestEffortCancelTimer(
  targetId: string,
  timerType: string,
  reason: string
): Promise<void> {
  try {
    const supabase = getSupabaseClient()
    await supabase.rpc('cancel_timer', {
      p_target_id: targetId,
      p_timer_type: timerType,
      p_reason: reason,
    })
  } catch (err) {
    console.error(`[timer] Failed to cancel ${timerType} for ${targetId}:`, err)
  }
}
```

- [ ] **Step 6: Create timer scanner Edge Function**

See spec §3.4 for full implementation. Key points:
- Query `pending_timer WHERE status = 'pending' AND trigger_at <= NOW()` with limit 50
- Process in batches of 10 via `Promise.allSettled()`
- Optimistic lock: UPDATE status='fired' before dispatch
- Per-handler try-catch: on error, set status='error' + error_details
- `handleStaleConversation`: re-check state, call `transitionConversation('timeout_24h', 'timer')`
- `handleDraftReviewNudge`: re-check draft status, INSERT to `staff_notifications`

```typescript
// supabase/functions/cron-timer-scanner/index.ts
// Full implementation from spec §3.4 — see proactive-operations-cron.md
```

- [ ] **Step 7: Add timer hooks to process-message (inbound cancel)**

In `supabase/functions/process-message/index.ts`, after the advisory lock section and before idempotency check, add:

```typescript
import { bestEffortCancelTimer } from '../_shared/timer-helpers.ts'

// After resolving conversation_id, before idempotency check:
// Cancel stale_conversation timer — client just messaged back
await bestEffortCancelTimer(conversationId, 'stale_conversation', 'client_messaged')
```

- [ ] **Step 8: Add timer hooks to approve-action (draft action cancel)**

In `supabase/functions/approve-action/index.ts`, after the action is resolved (approved or rejected), add:

```typescript
import { bestEffortCancelTimer } from '../_shared/timer-helpers.ts'

// After UPDATE proposed_actions SET status=decision:
// Cancel draft_review_nudge timer — staff acted on the draft
if (action.draft_id) {
  await bestEffortCancelTimer(action.draft_id, 'draft_review_nudge', 'staff_acted')
}
```

- [ ] **Step 9: Add timer hooks to actions.ts (staff send → start stale timer)**

In `src/app/(dashboard)/inbox/[conversationId]/actions.ts`, in the send action after successful WhatsApp send, add:

```typescript
import { bestEffortStartTimer } from '@/lib/proactive/timer-helpers'

// After successful message send, if conversation is now awaiting_client_reply:
await bestEffortStartTimer(
  draft.workspace_id,
  'stale_conversation',
  'conversation',
  draft.conversation_id,
  24 * 60 * 60 * 1000 // 24 hours
)
```

- [ ] **Step 10: Add timer hooks to draft-persistence.ts (draft created → start nudge timer)**

In `supabase/functions/_shared/draft-persistence.ts`, after successfully saving a draft, add:

```typescript
import { bestEffortStartTimer } from './timer-helpers.ts'

// After draft INSERT succeeds:
await bestEffortStartTimer(
  params.workspaceId,
  'draft_review_nudge',
  'draft',
  draftId,
  60 * 60 * 1000 // 1 hour
)
```

- [ ] **Step 11: Add T40 hook — booking confirmed cancels stale timer**

In `supabase/functions/_shared/action-executor.ts`, in the `booking_create` case after successful booking creation, add:

```typescript
import { bestEffortCancelTimer } from './timer-helpers.ts'

// After booking INSERT succeeds:
// Cancel stale_conversation timer — booking confirms the conversation is active
if (conversationId) {
  await bestEffortCancelTimer(conversationId, 'stale_conversation', 'booking_confirmed')
}
```

- [ ] **Step 12: Run build to verify no type errors**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors

- [ ] **Step 13: Commit**

```bash
git add supabase/functions/_shared/timer-helpers.ts \
  supabase/functions/cron-timer-scanner/ \
  src/lib/proactive/timer-helpers.ts \
  src/lib/proactive/__tests__/timer-helpers.test.ts \
  supabase/functions/process-message/index.ts \
  supabase/functions/approve-action/index.ts \
  src/app/(dashboard)/inbox/[conversationId]/actions.ts \
  supabase/functions/_shared/draft-persistence.ts
git commit -m "feat: add timer system — helpers, scanner, and hooks

Timer helpers: bestEffortStartTimer/CancelTimer (fire-and-forget, non-blocking)
Scanner: cron-timer-scanner Edge Function, batches of 10, optimistic locking,
  per-handler try-catch with error status
Hooks: cancel stale timer on inbound message, cancel nudge on staff action,
  start stale timer on staff send, start nudge on draft creation"
```

---

## Task 5: Heartbeat Edge Function

**Files:**
- Create: `supabase/functions/cron-heartbeat/index.ts`

**Test coverage:** T (heartbeat writes status, alerts flagged)

- [ ] **Step 1: Implement heartbeat**

```typescript
// supabase/functions/cron-heartbeat/index.ts
// Checks: WhatsApp connection, pgmq depth, LLM availability, calendar auth
// Writes: workspace.last_heartbeat_at, workspace.whatsapp_connection_status
// Alerts: INSERT staff_notifications on failure
// Log: cron_run_log entry
```

See spec §6 for full checks. Key implementation points:
- Iterate active workspaces
- Per-workspace: 4 health checks (WhatsApp webhook age, pgmq queue/DLQ depth, OpenRouter HEAD, calendar token expiry)
- Update `workspace.last_heartbeat_at = NOW()`
- If any check fails: INSERT to `staff_notifications` with type='heartbeat_alert'
- Write `cron_run_log` entry

- [ ] **Step 2: Run build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/cron-heartbeat/
git commit -m "feat: add cron-heartbeat Edge Function

Checks: WhatsApp connection age, pgmq queue depth + DLQ, OpenRouter availability,
Google Calendar auth status. Writes workspace.last_heartbeat_at. Inserts
staff_notifications on failures. Logs to cron_run_log."
```

---

## Task 6: Morning Scan

**Files:**
- Create: `supabase/functions/cron-morning-coordinator/index.ts`
- Create: `supabase/functions/cron-morning-scan/index.ts`
- Create: `supabase/functions/_shared/scan-and-propose.ts`
- Create: `src/lib/proactive/__tests__/morning-scan.test.ts`

**Test coverage:** T1-T28 (coordinator, day-init, scans 1-5, retry, scan isolation)

**Depends on:** Task 3 (conversation state machine), Task 4 (timer helpers)

- [ ] **Step 1: Write morning scan logic tests**

Test the pure query logic and scan orchestration. Mock Supabase client.
Cover: day-init transitions stale conversations, follow-up scan filters correctly,
inactivity CTE, journal stats aggregation, scan isolation (one failing doesn't block others).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/proactive/__tests__/morning-scan.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement scanAndPropose helper**

```typescript
// supabase/functions/_shared/scan-and-propose.ts
// Shared pipeline: candidates → Client Worker invocation → ProposedAction creation
// See spec §2.9 for interface
```

- [ ] **Step 4: Implement morning coordinator**

```typescript
// supabase/functions/cron-morning-coordinator/index.ts
// 1. Query active workspaces (onboarding_status = 'complete')
// 2. For each, fire-and-forget fetch to cron-morning-scan with workspace_id
// 3. Write coordinator-level cron_run_log entry
```

- [ ] **Step 5: Implement per-workspace morning scan**

```typescript
// supabase/functions/cron-morning-scan/index.ts
// Structure:
//   Step 0: Day-init stale sweep (§2.3)
//     - Query conversations stale > 24h
//     - transitionConversation('timeout_24h', 'morning_scan')
//     - cancel_timer for each (reason: 'morning_scan_handled')
//   Scan 1: Appointment reminders (§2.4)
//     - Query bookings tomorrow, confirmed, no reminder sent
//     - Template fill or Client Worker (based on reminder_mode)
//     - ProposedAction (tier: review)
//   Scan 2: Follow-up candidates (§2.5)
//     - Query via follow_up_check_days, state, attempt_count, no recent outbound
//     - scanAndPropose()
//   Scan 3: Booking confirmation (§2.6)
//     - Query bookings within confirmation_check_days, confirmation pending
//     - scanAndPropose()
//   Scan 4: Inactivity detection (§2.7)
//     - NOTE: spec says `last_interaction_at` but actual column is `last_contacted_at`
//     - CTE: UPDATE clients → inactive, UPDATE conversations → idle
//     - ProposedAction (tier: auto, type: lifecycle_transition)
//   Scan 5: Journal (§2.8)
//     - Aggregate stats (SQL)
//     - LLM narrative (cheap model)
//     - Write daily_journal record
//
// Each scan in try-catch. Partial failures logged. cron_run_log at end.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/proactive/__tests__/morning-scan.test.ts`
Expected: PASS

- [ ] **Step 7: Run build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/cron-morning-coordinator/ \
  supabase/functions/cron-morning-scan/ \
  supabase/functions/_shared/scan-and-propose.ts \
  src/lib/proactive/__tests__/morning-scan.test.ts
git commit -m "feat: add morning scan — coordinator, per-workspace scans, scanAndPropose

Coordinator fans out per-workspace Edge Function calls.
Per-workspace scan: day-init sweep, appointment reminders, follow-up candidates,
booking confirmations, inactivity detection, daily journal.
scanAndPropose() shared helper for DRY follow-up/confirmation pipeline.
Each scan runs in try-catch for failure isolation."
```

---

## Task 7: Compaction

**Files:**
- Create: `supabase/functions/cron-compaction-coordinator/index.ts`
- Create: `supabase/functions/cron-compaction/index.ts`
- Create: `src/lib/proactive/__tests__/compaction.test.ts`

**Test coverage:** T50-T54 (fan-out, compact, skip, defer, LLM fail)

**Depends on:** Task 3 (conversation state machine for state checks)

- [ ] **Step 1: Write compaction tests**

Test: clients with activity → compact, no activity → skip, flush-before-compact pending → defer, LLM failure → skip and log.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/proactive/__tests__/compaction.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement compaction coordinator**

```typescript
// supabase/functions/cron-compaction-coordinator/index.ts
// Same fan-out pattern as morning coordinator.
// Query active workspaces, fire-and-forget per-workspace calls.
```

- [ ] **Step 4: Implement per-workspace compaction**

```typescript
// supabase/functions/cron-compaction/index.ts
// 1. Query clients with message activity on CURRENT_DATE - 1 (yesterday)
// 2. For each client:
//    a. Flush-before-compact: check notes.extraction_status = 'pending' → skip if pending
//    b. Load existing compact_summary + yesterday's messages
//    c. LLM call (FLASH_MODEL via OpenRouter) → generate updated summary
//    d. Write Memory record (type: 'compact_summary', version: N+1)
//    e. Update clients.summary + clients.last_compacted_at
// 3. Per-client try-catch: skip on failure, log to cron_run_log
// 4. Write cron_run_log entry
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/proactive/__tests__/compaction.test.ts`
Expected: PASS

- [ ] **Step 6: Run build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/cron-compaction-coordinator/ \
  supabase/functions/cron-compaction/ \
  src/lib/proactive/__tests__/compaction.test.ts
git commit -m "feat: add memory compaction — coordinator + per-client summarization

Compaction runs at 3 AM HK, processes previous day's activity.
Flush-before-compact invariant: skips clients with pending note extractions.
LLM call via FLASH_MODEL for cheap summarization.
Writes versioned Memory records + updates client.summary.
Per-client error isolation."
```

---

## Task 8: Journal + Integration Verification

**Files:**
- (Journal is part of Task 6 morning scan, Scan 5)
- No new files — this task verifies the full system

**Depends on:** Tasks 6, 7

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new proactive ops tests)

- [ ] **Step 2: Run TypeScript build**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Run Next.js build**

Run: `npx next build`
Expected: Build succeeds

- [ ] **Step 4: Verify migration applies**

Run: `npx supabase db reset` (local) or review migration SQL for syntax
Expected: Migration applies cleanly, all tables/functions/indexes created

- [ ] **Step 5: Verify Edge Function structure**

Run: `ls supabase/functions/` — verify all 6 new Edge Functions exist:
- `cron-timer-scanner/index.ts`
- `cron-morning-coordinator/index.ts`
- `cron-morning-scan/index.ts`
- `cron-compaction-coordinator/index.ts`
- `cron-compaction/index.ts`
- `cron-heartbeat/index.ts`

- [ ] **Step 6: Write integration test for timer + morning scan interaction**

Test T58: day-init cancels pending stale_conversation timers.
Test T59: per-conversation error isolation in day-init sweep.

- [ ] **Step 7: Run integration tests**

Run: `npx vitest run src/lib/proactive/__tests__/ --reporter=verbose`
Expected: All proactive ops tests pass

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: proactive operations integration verification

All tests passing: conversation state machine, timer system, morning scan,
compaction. Build clean. Migration verified. 59 test cases covering
infrastructure, timer lifecycle, morning scan sub-scans, compaction,
and interaction tests (timer+scan race, per-conversation error isolation)."
```

---

## Task 9: Staff Notifications + Realtime

**Files:**
- (Table already created in Task 1 migration)
- This task verifies Realtime is enabled and the staff app can subscribe

- [ ] **Step 1: Verify staff_notifications table has Realtime enabled**

Check migration includes: `ALTER PUBLICATION supabase_realtime ADD TABLE staff_notifications;`

- [ ] **Step 2: Add useNotificationRealtime hook stub (if needed for future staff app work)**

This is a placeholder — the full staff app UI for notifications is out of scope for this plan. The infrastructure (table + Realtime) is ready for the staff app team to consume.

- [ ] **Step 3: Commit (if any changes)**

```bash
git add -A
git commit -m "chore: verify staff_notifications Realtime integration"
```

---

## Summary

| Task | Description | Depends on | Parallel group |
|------|-------------|------------|----------------|
| 1 | Database migration | — | Sequential |
| 2 | Shared types | 1 | Sequential |
| 3 | Conversation state machine | 2 | Group A |
| 4 | Timer system + hooks | 2 | Group A |
| 5 | Heartbeat | 2 | Group A |
| 6 | Morning scan | 3, 4 | Group B |
| 7 | Compaction | 2 | Group A |
| 8 | Journal + integration verify | 6, 7 | Group C |
| 9 | Staff notifications | 1 | Group A |

**Total new Edge Functions:** 6
**Total new shared modules:** 4
**Total new tables:** 4 (pending_timer, daily_journal, staff_notifications, cron_run_log)
**Total test cases:** 59
**Estimated implementation time:** Tasks 1-2 sequential (1 session), Group A parallel (1 session), Group B parallel (1 session), Group C (1 session) = 4 sessions
