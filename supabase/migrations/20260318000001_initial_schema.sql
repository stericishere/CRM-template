-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS pgmq;       -- message queue

-- ============================================================
-- WORKSPACES
-- ============================================================
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  vertical_type TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  business_hours JSONB,
  tone_profile TEXT,
  vertical_config JSONB,
  communication_profile JSONB,
  calendar_config JSONB,
  instagram_handle TEXT,
  onboarding_status TEXT NOT NULL DEFAULT 'pending',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'trialing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- STAFF (users / operators)
-- ============================================================
CREATE TABLE staff (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  full_name TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'open'
    CHECK (lifecycle_status IN (
      'open', 'chosen_service', 'upcoming_appointment',
      'follow_up', 'review_complete', 'inactive'
    )),
  tags TEXT[] DEFAULT '{}',
  preferences JSONB DEFAULT '{}',
  summary TEXT,
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(workspace_id, phone)
);

CREATE INDEX idx_clients_workspace ON clients(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_clients_phone ON clients(workspace_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX idx_clients_lifecycle ON clients(workspace_id, lifecycle_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_clients_last_contacted ON clients(workspace_id, last_contacted_at) WHERE deleted_at IS NULL AND lifecycle_status != 'inactive';

-- ============================================================
-- CONVERSATIONS
-- ============================================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  state TEXT NOT NULL DEFAULT 'idle',
  last_message_at TIMESTAMPTZ,
  last_client_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(client_id)
);

CREATE INDEX idx_conversations_workspace ON conversations(workspace_id);
CREATE INDEX idx_conversations_state ON conversations(workspace_id, state);

-- ============================================================
-- MESSAGES (workspace_id denormalized for Supabase Realtime)
-- ============================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  direction TEXT NOT NULL,
  content TEXT,
  media_type TEXT,
  media_url TEXT,
  media_transcription TEXT,
  sender_type TEXT NOT NULL,
  delivery_status TEXT DEFAULT 'sent',
  wamid TEXT,
  draft_id UUID,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_wamid ON messages(wamid) WHERE wamid IS NOT NULL;
CREATE INDEX idx_messages_workspace ON messages(workspace_id, direction, created_at DESC);
CREATE INDEX idx_messages_unread ON messages(workspace_id, conversation_id) WHERE is_read = false AND direction = 'inbound';

-- ============================================================
-- DRAFTS (workspace_id denormalized for Realtime)
-- ============================================================
CREATE TABLE drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  content TEXT NOT NULL,
  intent_classified TEXT,
  confidence_score REAL,
  knowledge_sources TEXT[],
  staff_action TEXT,
  edited_content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES staff(id)
);

CREATE INDEX idx_drafts_workspace ON drafts(workspace_id, created_at DESC);

-- ============================================================
-- AUDIT EVENTS (immutable log)
-- ============================================================
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id UUID,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_workspace ON audit_events(workspace_id, created_at DESC);

-- ============================================================
-- MESSAGE INBOX (deduplication by wamid)
-- ============================================================
CREATE TABLE message_inbox (
  wamid TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- BAILEYS AUTH (WhatsApp session credentials)
-- ============================================================
CREATE TABLE baileys_auth (
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- ============================================================
-- LLM USAGE (cost tracking)
-- ============================================================
CREATE TABLE llm_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID,
  edge_function_name TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  cost_usd NUMERIC(10,6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_usage_workspace ON llm_usage(workspace_id, created_at DESC);
CREATE INDEX idx_llm_usage_daily ON llm_usage(workspace_id, created_at::date);

-- ============================================================
-- DRAFT EDIT SIGNALS (learning loop — Phase 2 recording only)
-- ============================================================
CREATE TABLE draft_edit_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  draft_id UUID NOT NULL REFERENCES drafts(id),
  staff_action TEXT NOT NULL,
  original_draft TEXT NOT NULL,
  final_version TEXT,
  intent_classified TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- BOOKINGS (needed for FK references, populated in Sprint 3)
-- ============================================================
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  appointment_type TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  calendar_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  confirmation_status TEXT DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- NOTES (needed for FK references, populated in Sprint 3)
-- ============================================================
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- FOLLOW-UPS (needed for FK references, populated in Sprint 3)
-- ============================================================
CREATE TABLE follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL DEFAULT 'follow_up',
  content TEXT NOT NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MEMORIES (compaction, populated in Sprint 4)
-- ============================================================
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  period_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- KNOWLEDGE CHUNKS (pgvector, populated in Sprint 2)
-- ============================================================
CREATE TABLE knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_workspace ON knowledge_chunks(workspace_id);

-- ============================================================
-- PROPOSED ACTIONS (approval boundary, populated in Sprint 2)
-- ============================================================
CREATE TABLE proposed_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  conversation_id UUID REFERENCES conversations(id),
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  tier TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES staff(id)
);

-- ============================================================
-- MESSAGE TEMPLATES
-- ============================================================
CREATE TABLE message_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  whatsapp_template_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
