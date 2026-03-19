-- ============================================================
-- SPRINT 2 SCHEMA CHANGES
-- Extends the base schema with columns and functions needed
-- for the AI pipeline (F-01, F-05, F-06, F-10).
-- All statements are idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================

-- 1. Add scenario_type + source_message_id to drafts (F-05 / F-10 classification + idempotency)
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS scenario_type TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS source_message_id UUID REFERENCES messages(id);
CREATE INDEX IF NOT EXISTS idx_drafts_source_message
  ON drafts(conversation_id, source_message_id);

-- 2. Extend proposed_actions (F-06: link actions to drafts, expiry, renotify)
ALTER TABLE proposed_actions
  ADD COLUMN IF NOT EXISTS draft_id UUID REFERENCES drafts(id);
ALTER TABLE proposed_actions
  ADD COLUMN IF NOT EXISTS renotified_at TIMESTAMPTZ;
ALTER TABLE proposed_actions
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 3. Extend draft_edit_signals (F-10: scenario classification + CHECK + indexes)
ALTER TABLE draft_edit_signals
  ADD COLUMN IF NOT EXISTS scenario_type TEXT NOT NULL DEFAULT 'unclassified';

-- Guard: only add the CHECK constraint if it does not already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_staff_action'
      AND conrelid = 'draft_edit_signals'::regclass
  ) THEN
    ALTER TABLE draft_edit_signals
      ADD CONSTRAINT chk_staff_action CHECK (staff_action IN (
        'sent_as_is', 'edited_and_sent', 'regenerated', 'discarded'
      ));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_draft_edit_signals_workspace
  ON draft_edit_signals(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_draft_edit_signals_draft
  ON draft_edit_signals(draft_id);
CREATE INDEX IF NOT EXISTS idx_draft_edit_signals_workspace_action
  ON draft_edit_signals(workspace_id, staff_action, created_at DESC);

-- 4. Add workspace onboarding columns (F-01)
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS knowledge_base TEXT;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS whatsapp_connection_status TEXT DEFAULT 'disconnected';
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number TEXT;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS instagram_scrape_data JSONB;

-- 5. Knowledge search RPC (F-05 pgvector similarity search)
--
--  Flow:
--    caller                 search_knowledge_chunks()           knowledge_chunks
--    ──────   query_emb ──>  cosine distance filter        ──>  vector index
--             workspace_id   similarity >= min_similarity        workspace scope
--             match_count  <──────── ranked results ───────────
--
CREATE OR REPLACE FUNCTION search_knowledge_chunks(
  query_embedding vector(1536),
  match_workspace_id UUID,
  match_count INT DEFAULT 5,
  min_similarity FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  source TEXT,
  source_ref TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.source,
    kc.source_ref,
    (1 - (kc.embedding <=> query_embedding))::FLOAT AS similarity
  FROM knowledge_chunks kc
  WHERE kc.workspace_id = match_workspace_id
    AND (1 - (kc.embedding <=> query_embedding)) >= min_similarity
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 6. RLS for draft_edit_signals (F-10)
--    Migration 0002 already enables RLS and creates a broad "workspace_isolation"
--    policy (FOR ALL). We add a named SELECT-only policy here only if it is
--    absent, so re-running this migration is safe.
ALTER TABLE draft_edit_signals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'draft_edit_signals'
      AND policyname = 'workspace_isolation_select'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "workspace_isolation_select" ON draft_edit_signals
        FOR SELECT TO authenticated
        USING (workspace_id = auth.workspace_id())
    $policy$;
  END IF;
END;
$$;

-- 7. RLS for knowledge_chunks
--    Migration 0002 already enables RLS and creates a broad "workspace_isolation"
--    policy (FOR ALL). Re-enabling RLS is a no-op; we skip recreating the policy.
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- 8. Indexes for proposed_actions lookup patterns (F-06)
CREATE INDEX IF NOT EXISTS idx_proposed_actions_conversation
  ON proposed_actions(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_proposed_actions_workspace
  ON proposed_actions(workspace_id, status, created_at DESC);
