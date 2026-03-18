-- Seed data for local development
-- Note: Auth users must be created via Supabase Auth API, not direct SQL

-- Create test workspace
INSERT INTO workspaces (id, business_name, vertical_type, timezone, onboarding_status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Test Bespoke Tailor',
  'bespoke_tailor',
  'Asia/Hong_Kong',
  'completed'
);

-- Note: Staff user will be created after Supabase Auth user is set up
-- The staff record links to auth.users via FK

-- Create test clients
INSERT INTO clients (id, workspace_id, phone, full_name, lifecycle_status, last_contacted_at)
VALUES
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', '+85291234567', 'Alex Chen', 'open', now()),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', '+85292345678', 'Ben Wong', 'chosen_service', now() - interval '5 days'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', '+85293456789', 'Carol Liu', 'inactive', now() - interval '45 days');

-- Create conversations for test clients
INSERT INTO conversations (id, workspace_id, client_id, state, last_message_at)
VALUES
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'idle', now()),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000012', 'idle', now() - interval '5 days');

-- Create test messages
INSERT INTO messages (conversation_id, workspace_id, direction, content, sender_type, wamid, is_read)
VALUES
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001', 'inbound', 'Hi, I''d like to book a fitting for a new suit', 'client', 'wamid.test001', false),
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001', 'outbound', 'Hello Alex! I''d be happy to help you with that. When works best for you?', 'staff', NULL, true),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000001', 'inbound', 'When can I pick up my suit?', 'client', 'wamid.test002', false);
