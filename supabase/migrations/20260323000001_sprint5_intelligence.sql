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
  ADD COLUMN IF NOT EXISTS extraction_error TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

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
SELECT cron.schedule(
  'recover-stuck-processing-notes',
  '*/5 * * * *',
  $$
  UPDATE notes
  SET extraction_status = 'pending'
  WHERE extraction_status = 'processing'
    AND extraction_completed_at IS NULL
    AND updated_at < now() - interval '5 minutes';
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

-- 2f. pg_net trigger: fire classify-edits on edited_and_sent signal INSERT
CREATE OR REPLACE FUNCTION trigger_edit_classification()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.staff_action = 'edited_and_sent' AND NEW.processed_at IS NULL THEN
    PERFORM net.http_post(
      url := current_setting('app.supabase_url')
             || '/functions/v1/classify-edits',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'signal_id', NEW.id,
        'workspace_id', NEW.workspace_id
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_classify_edit_signal ON draft_edit_signals;
CREATE TRIGGER trg_classify_edit_signal
  AFTER INSERT ON draft_edit_signals
  FOR EACH ROW
  EXECUTE FUNCTION trigger_edit_classification();

-- 2g. pg_cron: batch-process unclassified edits every 5 minutes (safety net)
SELECT cron.schedule(
  'retry-unclassified-edits',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url')
           || '/functions/v1/classify-edits',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  WHERE EXISTS (
    SELECT 1 FROM draft_edit_signals
    WHERE staff_action = 'edited_and_sent'
      AND processed_at IS NULL
    LIMIT 1
  );
  $$
);

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
