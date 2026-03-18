-- ============================================================
-- PGMQ Queues
-- ============================================================
SELECT pgmq.create('inbound_messages');
SELECT pgmq.create('inbound_dlq');
SELECT pgmq.create('audit_retry');
SELECT pgmq.create('audit_dlq');

-- ============================================================
-- Trigger: notify process-message Edge Function on new pgmq message
-- Uses pg_net to call the Edge Function asynchronously
-- ============================================================
-- NOTE: pg_net trigger for process-message will be configured
-- when the Edge Function is deployed. For local dev, use
-- pg_cron polling as the safety net.

-- ============================================================
-- Updated_at trigger for clients table
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
