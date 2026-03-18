-- ============================================================
-- Helper function: get workspace_id for authenticated user
-- ============================================================
CREATE OR REPLACE FUNCTION auth.workspace_id()
RETURNS UUID AS $$
  SELECT workspace_id FROM public.staff WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- Enable RLS on ALL tables
-- ============================================================
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposed_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_edit_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS policies
-- ============================================================

-- WORKSPACES
CREATE POLICY "workspace_isolation" ON workspaces
  FOR ALL USING (id = auth.workspace_id())
  WITH CHECK (id = auth.workspace_id());

-- STAFF
CREATE POLICY "workspace_isolation" ON staff
  FOR SELECT USING (workspace_id = auth.workspace_id());

-- CLIENTS
CREATE POLICY "workspace_isolation" ON clients
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- CONVERSATIONS
CREATE POLICY "workspace_isolation" ON conversations
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- MESSAGES
CREATE POLICY "workspace_isolation" ON messages
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- DRAFTS
CREATE POLICY "workspace_isolation" ON drafts
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- BOOKINGS
CREATE POLICY "workspace_isolation" ON bookings
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- NOTES
CREATE POLICY "workspace_isolation" ON notes
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- FOLLOW-UPS
CREATE POLICY "workspace_isolation" ON follow_ups
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- MEMORIES
CREATE POLICY "workspace_isolation" ON memories
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- KNOWLEDGE CHUNKS
CREATE POLICY "workspace_isolation" ON knowledge_chunks
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- PROPOSED ACTIONS
CREATE POLICY "workspace_isolation" ON proposed_actions
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- AUDIT EVENTS (read-only for staff, service role writes)
CREATE POLICY "staff_read_own_workspace" ON audit_events
  FOR SELECT USING (workspace_id = auth.workspace_id());

-- DRAFT EDIT SIGNALS
CREATE POLICY "workspace_isolation" ON draft_edit_signals
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- MESSAGE TEMPLATES
CREATE POLICY "workspace_isolation" ON message_templates
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- LLM USAGE (read-only for staff)
CREATE POLICY "staff_read_own_workspace" ON llm_usage
  FOR SELECT USING (workspace_id = auth.workspace_id());

-- BAILEYS AUTH (no RLS — service role only, no staff access)
-- baileys_auth is NOT exposed to the client
