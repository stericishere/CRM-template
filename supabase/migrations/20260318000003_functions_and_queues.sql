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

-- ============================================================
-- Unread counts RPC (used by /api/notifications/unread-count)
-- Groups unread inbound messages by conversation, leveraging
-- the idx_messages_unread partial index.
-- ============================================================
CREATE OR REPLACE FUNCTION get_unread_counts(p_workspace_id UUID)
RETURNS TABLE(
  conversation_id UUID,
  unread_count BIGINT,
  last_message_at TIMESTAMPTZ
) AS $$
  SELECT
    m.conversation_id,
    COUNT(m.id) AS unread_count,
    MAX(m.created_at) AS last_message_at
  FROM messages m
  WHERE m.workspace_id = p_workspace_id
    AND m.direction = 'inbound'
    AND m.is_read = false
  GROUP BY m.conversation_id
  ORDER BY last_message_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
