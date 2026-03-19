-- ============================================================
-- Heartbeat infrastructure: last_heartbeat_at column
-- ============================================================

-- Track when the heartbeat cron last checked this workspace
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
