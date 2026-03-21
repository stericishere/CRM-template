-- ============================================================
-- Enable RLS on baileys_auth (service-role only)
--
-- baileys_auth stores WhatsApp session credentials and must
-- never be accessible via the PostgREST (anon/authenticated)
-- API. Enabling RLS with no permissive policies means only
-- the service_role key can read/write this table.
-- ============================================================
ALTER TABLE baileys_auth ENABLE ROW LEVEL SECURITY;
