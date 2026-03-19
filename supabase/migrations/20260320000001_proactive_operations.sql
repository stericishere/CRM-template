-- ============================================================
-- PROACTIVE OPERATIONS SCHEMA
-- Tables, columns, indexes, RPC functions, pg_cron schedules
-- for Pattern A (morning scan) and Pattern B (event timers)
-- ============================================================

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

-- 2d. Heartbeat tracking
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

-- 2e. Booking reminder tracking
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- 2f. Client compaction tracking
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS last_compacted_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════
-- 3. Indexes
-- ═══════════════════════════════════════════════════════════

-- Supports morning scan Scan 2 NOT EXISTS subquery at scale
CREATE INDEX IF NOT EXISTS idx_messages_conv_direction_ts
  ON messages (conversation_id, direction, created_at DESC);

-- Client compaction activity detection
CREATE INDEX IF NOT EXISTS idx_clients_last_compacted
  ON clients (workspace_id, last_compacted_at)
  WHERE deleted_at IS NULL;

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
        SELECT id FROM workspaces WHERE onboarding_status = 'complete'
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
