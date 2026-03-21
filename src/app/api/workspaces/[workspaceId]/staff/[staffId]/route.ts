import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'
import { assertWorkspaceRole } from '@/lib/supabase/assert-workspace-role'
import { updateStaffSchema } from '@/lib/staff/schemas'

type RouteParams = { params: Promise<{ workspaceId: string; staffId: string }> }

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/staff/:staffId
//
// Get a single staff member by ID.
// Returns { staff: {...} }
// ──────────────────────────────────────────────────────────
export async function GET(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, staffId } = await params

    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('staff')
      .select('*')
      .eq('id', staffId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (error) {
      console.error('[GET /staff/:id] Query failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to fetch staff member' },
        { status: 500 }
      )
    }

    if (!data) {
      return NextResponse.json(
        { error: 'Staff member not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ staff: data })
  } catch (err) {
    console.error('[GET /staff/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// PATCH /api/workspaces/:workspaceId/staff/:staffId
//
// Update a staff member's role or status.
// Body: { role?, status? }
// Requires owner role.
// Returns { staff: {...} }
//
// Guards:
//   - Cannot change own role from 'owner'
//   - Cannot set role to 'owner'
//   - Cannot change own status
//   - If status = 'removed', sets removed_at = now()
// ──────────────────────────────────────────────────────────
export async function PATCH(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, staffId } = await params

    const auth = await assertWorkspaceRole(workspaceId, ['owner'])
    if (auth instanceof NextResponse) return auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = updateStaffSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const isSelf = auth.staffId === staffId

    // Guard: cannot change own role from owner
    if (isSelf && parsed.data.role !== undefined) {
      return NextResponse.json(
        { error: 'Cannot change owner role' },
        { status: 400 }
      )
    }

    // Guard: cannot set role to owner
    if (parsed.data.role === 'owner') {
      return NextResponse.json(
        { error: 'Cannot create additional owners' },
        { status: 400 }
      )
    }

    // Guard: cannot change own status
    if (isSelf && parsed.data.status !== undefined) {
      return NextResponse.json(
        { error: 'Cannot modify own status' },
        { status: 400 }
      )
    }

    // Build update payload from validated fields
    const updates: Record<string, unknown> = {}
    if (parsed.data.role !== undefined) {
      updates.role = parsed.data.role
    }
    if (parsed.data.status !== undefined) {
      updates.status = parsed.data.status
      if (parsed.data.status === 'removed') {
        updates.removed_at = new Date().toISOString()
      }
    }
    updates.updated_at = new Date().toISOString()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('staff')
      .update(updates)
      .eq('id', staffId)
      .eq('workspace_id', workspaceId)
      .select('*')
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Staff member not found' },
          { status: 404 }
        )
      }
      console.error('[PATCH /staff/:id]', error.message)
      return NextResponse.json(
        { error: 'Failed to update staff member' },
        { status: 500 }
      )
    }

    return NextResponse.json({ staff: data })
  } catch (err) {
    console.error('[PATCH /staff/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// DELETE /api/workspaces/:workspaceId/staff/:staffId
//
// Soft-delete a staff member (set status='removed').
// Requires owner role. Cannot remove self.
// Returns { success: true }
// ──────────────────────────────────────────────────────────
export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, staffId } = await params

    const auth = await assertWorkspaceRole(workspaceId, ['owner'])
    if (auth instanceof NextResponse) return auth

    // Guard: cannot remove self
    if (auth.staffId === staffId) {
      return NextResponse.json(
        { error: 'Cannot remove yourself' },
        { status: 400 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('staff')
      .update({
        status: 'removed',
        removed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', staffId)
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE /staff/:id]', error.message)
      return NextResponse.json(
        { error: 'Failed to remove staff member' },
        { status: 500 }
      )
    }

    if (!data) {
      return NextResponse.json(
        { error: 'Staff member not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /staff/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
