import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'
import { assertWorkspaceRole } from '@/lib/supabase/assert-workspace-role'
import { inviteStaffSchema } from '@/lib/staff/schemas'
import {
  generateInvitationToken,
  buildInvitationUrl,
} from '@/lib/staff/invitation'

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/staff
//
// Lists all staff members (active + invited) and pending
// invitations for the workspace.
// Returns { staff: [...], invitations: [...] }
// ──────────────────────────────────────────────────────────
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const [staffResult, invitationsResult] = await Promise.all([
      supabase
        .from('staff')
        .select('*')
        .eq('workspace_id', workspaceId)
        .in('status', ['active', 'invited'])
        .order('role', { ascending: true })
        .order('created_at', { ascending: true }),
      supabase
        .from('staff_invitations')
        .select('id, workspace_id, email, full_name, role, status, expires_at, created_at')
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
    ])

    if (staffResult.error) {
      console.error('[GET /staff] Staff query failed:', staffResult.error.message)
      return NextResponse.json(
        { error: 'Failed to fetch staff' },
        { status: 500 }
      )
    }

    if (invitationsResult.error) {
      console.error('[GET /staff] Invitations query failed:', invitationsResult.error.message)
      return NextResponse.json(
        { error: 'Failed to fetch invitations' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      staff: staffResult.data ?? [],
      invitations: invitationsResult.data ?? [],
    })
  } catch (err) {
    console.error('[GET /staff]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// POST /api/workspaces/:workspaceId/staff
//
// Invite a new staff member to the workspace.
// Body: { email, full_name, role }
// Requires owner or admin role.
// Returns { invitation: { id, email, role, token, url, expires_at } }
// ──────────────────────────────────────────────────────────
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    const auth = await assertWorkspaceRole(workspaceId, ['owner', 'admin'])
    if (auth instanceof NextResponse) return auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = inviteStaffSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { email, full_name, role } = parsed.data

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    // Check for existing active staff with this email
    const { data: existingStaff } = await supabase
      .from('staff')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('email', email)
      .eq('status', 'active')
      .maybeSingle()

    if (existingStaff) {
      return NextResponse.json(
        { error: 'A staff member with this email already exists in the workspace' },
        { status: 409 }
      )
    }

    // Expire any stale pending invitations so the partial unique index
    // (workspace_id, email WHERE status='pending') doesn't block re-invites.
    await supabase
      .from('staff_invitations')
      .update({ status: 'expired' })
      .eq('workspace_id', workspaceId)
      .eq('email', email)
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString())

    // Check for existing pending AND non-expired invitation.
    const { data: existingInvitation } = await supabase
      .from('staff_invitations')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('email', email)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (existingInvitation) {
      return NextResponse.json(
        { error: 'A pending invitation already exists for this email' },
        { status: 409 }
      )
    }

    // Generate token and insert invitation
    const token = generateInvitationToken()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days

    const { data: invitation, error } = await supabase
      .from('staff_invitations')
      .insert({
        workspace_id: workspaceId,
        email,
        full_name,
        role,
        token,
        invited_by: auth.staffId,
        expires_at: expiresAt,
        status: 'pending',
      })
      .select('id, email, role, token, expires_at')
      .single()

    if (error) {
      console.error('[POST /staff] Insert invitation failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to create invitation' },
        { status: 500 }
      )
    }

    return NextResponse.json(
      {
        invitation: {
          ...invitation,
          url: buildInvitationUrl(token),
        },
      },
      { status: 201 }
    )
  } catch (err) {
    console.error('[POST /staff]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
