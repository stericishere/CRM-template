-- ============================================================
-- STAFF MANAGEMENT (F-16)
-- Adds multi-user workspace support: roles, status, invitations
-- ============================================================

-- 1. Staff table alterations
ALTER TABLE staff ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE staff ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES staff(id);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE staff ADD CONSTRAINT chk_staff_status
    CHECK (status IN ('active', 'invited', 'removed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE staff ADD CONSTRAINT chk_staff_role
    CHECK (role IN ('owner', 'admin', 'member'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_staff_workspace_active
  ON staff(workspace_id) WHERE status = 'active';

-- 2. Staff invitations table
CREATE TABLE IF NOT EXISTS staff_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by UUID NOT NULL REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'pending',
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_invitation_role CHECK (role IN ('admin', 'member')),
  CONSTRAINT chk_invitation_status CHECK (status IN ('pending', 'accepted', 'expired', 'revoked'))
);

-- Partial unique: prevent duplicate pending invitations for same email
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_invitations_workspace_email_pending') THEN
    CREATE UNIQUE INDEX uq_invitations_workspace_email_pending
      ON staff_invitations(workspace_id, email) WHERE status = 'pending';
  END IF;
END $$;

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_invitations_token
  ON staff_invitations(token) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_invitations_workspace
  ON staff_invitations(workspace_id);

-- 4. RLS policies
ALTER TABLE staff_invitations ENABLE ROW LEVEL SECURITY;

-- Invitations: workspace members can read
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'workspace_read' AND tablename = 'staff_invitations') THEN
    CREATE POLICY "workspace_read" ON staff_invitations
      FOR SELECT USING (workspace_id = auth.workspace_id());
  END IF;
END $$;

-- Invitations: owner/admin can insert
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'owner_admin_write' AND tablename = 'staff_invitations') THEN
    CREATE POLICY "owner_admin_write" ON staff_invitations
      FOR INSERT WITH CHECK (
        workspace_id = auth.workspace_id()
        AND EXISTS (
          SELECT 1 FROM staff
          WHERE id = auth.uid()
          AND workspace_id = staff_invitations.workspace_id
          AND role IN ('owner', 'admin')
          AND status = 'active'
        )
      );
  END IF;
END $$;

-- Update staff policies: expand from SELECT-only to role-based
DROP POLICY IF EXISTS "workspace_isolation" ON staff;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'staff_read' AND tablename = 'staff') THEN
    CREATE POLICY "staff_read" ON staff
      FOR SELECT USING (workspace_id = auth.workspace_id());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'owner_write' AND tablename = 'staff') THEN
    CREATE POLICY "owner_write" ON staff
      FOR UPDATE USING (
        workspace_id = auth.workspace_id()
        AND EXISTS (
          SELECT 1 FROM staff s
          WHERE s.id = auth.uid()
          AND s.workspace_id = staff.workspace_id
          AND s.role = 'owner'
          AND s.status = 'active'
        )
      );
  END IF;
END $$;

-- 5. Helper functions
-- Tighten workspace_id to only resolve for active staff — removed users
-- must not pass RLS checks even with a valid JWT.
CREATE OR REPLACE FUNCTION auth.workspace_id()
RETURNS UUID AS $$
  SELECT workspace_id FROM public.staff WHERE id = auth.uid() AND status = 'active'
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION auth.staff_role()
RETURNS TEXT AS $$
  SELECT role FROM public.staff WHERE id = auth.uid() AND status = 'active'
$$ LANGUAGE sql SECURITY DEFINER STABLE;
