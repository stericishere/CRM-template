import { NextRequest, NextResponse } from 'next/server'
import { patchFollowUpSchema } from '@/lib/notes/schemas'
import { getServiceClient } from '@/lib/supabase/service'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

type RouteParams = { params: Promise<{ workspaceId: string; followUpId: string }> }

// ──────────────────────────────────────────────────────────
// PATCH /api/workspaces/:workspaceId/follow-ups/:followUpId
//
// Body: { status?, content?, due_date? }
// ──────────────────────────────────────────────────────────
export async function PATCH(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, followUpId } = await params

    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = patchFollowUpSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    // Ensure at least one field is being updated
    const updates = parsed.data
    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'At least one field must be provided' },
        { status: 400 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('follow_ups')
      .update(updates)
      .eq('id', followUpId)
      .eq('workspace_id', workspaceId)
      .select('*')
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Follow-up not found' }, { status: 404 })
      }
      console.error('[PATCH /follow-ups/:id]', error.message)
      return NextResponse.json(
        { error: 'Failed to update follow-up' },
        { status: 500 }
      )
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[PATCH /follow-ups/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
