-- ============================================================
-- SPRINT 3 SCHEMA CHANGES
-- F-07 (Booking), F-09 (Notes/FU/KB), F-08 (Media)
-- All statements are idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================

-- 1. F-08: Media processing columns on messages
--    media_type, media_url, media_transcription already exist from initial schema.
--    Add transcription_status and media_metadata.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription_status TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_metadata JSONB;

-- 2. F-09: Knowledge management — updated_at + source_ref on knowledge_chunks
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
-- source_ref already exists from initial schema

-- 3. F-09: Client merge RPC
--    Atomically transfers all records from source_client to target_client,
--    then soft-deletes the source. Returns counts of each record type transferred.
CREATE OR REPLACE FUNCTION merge_clients(
  p_workspace_id UUID,
  p_source_client_id UUID,
  p_target_client_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_counts JSONB;
  v_msg_count INT;
  v_note_count INT;
  v_fu_count INT;
  v_booking_count INT;
BEGIN
  -- Validate both clients belong to the workspace
  IF NOT EXISTS (
    SELECT 1 FROM clients
    WHERE id = p_source_client_id AND workspace_id = p_workspace_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Source client not found in workspace';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM clients
    WHERE id = p_target_client_id AND workspace_id = p_workspace_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Target client not found in workspace';
  END IF;

  -- Transfer conversations (and their messages follow via FK)
  UPDATE conversations SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id AND workspace_id = p_workspace_id;

  -- Transfer notes
  UPDATE notes SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id AND workspace_id = p_workspace_id;
  GET DIAGNOSTICS v_note_count = ROW_COUNT;

  -- Transfer follow-ups
  UPDATE follow_ups SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id AND workspace_id = p_workspace_id;
  GET DIAGNOSTICS v_fu_count = ROW_COUNT;

  -- Transfer bookings
  UPDATE bookings SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id AND workspace_id = p_workspace_id;
  GET DIAGNOSTICS v_booking_count = ROW_COUNT;

  -- Transfer proposed actions
  UPDATE proposed_actions SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id AND workspace_id = p_workspace_id;

  -- Transfer draft edit signals
  UPDATE draft_edit_signals SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id AND workspace_id = p_workspace_id;

  -- Transfer memories
  UPDATE memories SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id AND workspace_id = p_workspace_id;

  -- Soft-delete source client
  UPDATE clients SET deleted_at = now()
  WHERE id = p_source_client_id AND workspace_id = p_workspace_id;

  -- Count transferred messages via conversations
  SELECT COUNT(*) INTO v_msg_count
  FROM messages m
  JOIN conversations c ON m.conversation_id = c.id
  WHERE c.client_id = p_target_client_id AND c.workspace_id = p_workspace_id;

  v_counts = jsonb_build_object(
    'notes', v_note_count,
    'follow_ups', v_fu_count,
    'bookings', v_booking_count,
    'messages_now_accessible', v_msg_count
  );

  RETURN v_counts;
END;
$$;

-- 4. F-09: Knowledge upsert RPC
--    Atomic delete+insert for re-embedding a source.
CREATE OR REPLACE FUNCTION upsert_knowledge_chunks(
  p_workspace_id UUID,
  p_source TEXT,
  p_chunks JSONB  -- array of { content, source_ref, embedding }
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INT;
BEGIN
  -- Delete existing chunks for this source
  DELETE FROM knowledge_chunks
  WHERE workspace_id = p_workspace_id AND source = p_source;

  -- Insert new chunks
  INSERT INTO knowledge_chunks (workspace_id, content, source, source_ref, embedding, updated_at)
  SELECT
    p_workspace_id,
    (item->>'content')::TEXT,
    p_source,
    (item->>'source_ref')::TEXT,
    (item->>'embedding')::vector(1536),
    now()
  FROM jsonb_array_elements(p_chunks) AS item;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 5. Indexes for Sprint 3 query patterns
CREATE INDEX IF NOT EXISTS idx_notes_client ON notes(workspace_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follow_ups_client ON follow_ups(workspace_id, client_id, status);
CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups(workspace_id, due_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(workspace_id, client_id, start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings(workspace_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks(workspace_id, source);
CREATE INDEX IF NOT EXISTS idx_messages_transcription ON messages(transcription_status)
  WHERE transcription_status = 'pending';
