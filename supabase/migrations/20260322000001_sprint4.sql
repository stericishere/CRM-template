-- ============================================================
-- SPRINT 4 SCHEMA CHANGES
-- F-11 (Compaction Polish), F-12 (COS Improvements), F-14 (Metrics)
-- All statements are idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================

-- 1. F-14: Reply tracking columns on draft_edit_signals
ALTER TABLE draft_edit_signals ADD COLUMN IF NOT EXISTS client_replied BOOLEAN;
ALTER TABLE draft_edit_signals ADD COLUMN IF NOT EXISTS client_reply_latency_minutes INT;
ALTER TABLE draft_edit_signals ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id);

CREATE INDEX IF NOT EXISTS idx_draft_edit_signals_reply_pending
  ON draft_edit_signals(workspace_id, created_at)
  WHERE client_replied IS NULL;

-- 2. F-12: Urgency scoring on proposed_actions
ALTER TABLE proposed_actions ADD COLUMN IF NOT EXISTS urgency_score INT;
ALTER TABLE proposed_actions ADD COLUMN IF NOT EXISTS rank INT;

CREATE INDEX IF NOT EXISTS idx_proposed_actions_urgency
  ON proposed_actions(workspace_id, urgency_score DESC)
  WHERE status = 'pending';

-- 3. F-11: Atomic compaction RPC
--    Writes compaction result (memory + client summary) in a single transaction.
--    Prevents partial updates that leave client/memory out of sync.
CREATE OR REPLACE FUNCTION write_compaction_result(
  p_workspace_id UUID,
  p_client_id UUID,
  p_memory_type TEXT,
  p_memory_content TEXT,
  p_period_date DATE,
  p_client_summary TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_memory_id UUID;
BEGIN
  -- Upsert memory (create or update for this period)
  INSERT INTO memories (workspace_id, client_id, type, content, period_date, version)
  VALUES (p_workspace_id, p_client_id, p_memory_type, p_memory_content, p_period_date, 1)
  ON CONFLICT (workspace_id, client_id, type, period_date)
    DO UPDATE SET
      content = EXCLUDED.content,
      version = memories.version + 1,
      created_at = now()
  RETURNING id INTO v_memory_id;

  -- Update client summary
  UPDATE clients SET
    summary = p_client_summary,
    updated_at = now()
  WHERE id = p_client_id AND workspace_id = p_workspace_id;

  RETURN v_memory_id;
END;
$$;

-- Add unique constraint for memory upsert if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'memories_workspace_client_type_period_unique'
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_workspace_client_type_period_unique
      UNIQUE (workspace_id, client_id, type, period_date);
  END IF;
END;
$$;
