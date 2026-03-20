import { NextRequest, NextResponse } from 'next/server'
import { lifecycleStatusSchema } from '@/lib/clients/types'
import * as clientRepo from '@/lib/clients/repository'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

// ──────────────────────────────────────────────────────────
// PATCH /api/workspaces/:workspaceId/clients/:clientId/lifecycle
//
// Body: { lifecycle_status: LifecycleStatus }
// ──────────────────────────────────────────────────────────
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; clientId: string }> }
) {
  try {
    const { workspaceId, clientId } = await params

    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // Validate that body is an object with lifecycle_status
    if (typeof body !== 'object' || body === null || !('lifecycle_status' in body)) {
      return NextResponse.json(
        { error: 'Validation failed', details: 'lifecycle_status is required' },
        { status: 400 }
      )
    }

    const parsed = lifecycleStatusSchema.safeParse(
      (body as Record<string, unknown>).lifecycle_status
    )
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid lifecycle_status', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const updated = await clientRepo.updateLifecycleStatus(
      workspaceId,
      clientId,
      parsed.data
    )
    if (!updated) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    return NextResponse.json(updated)
  } catch (err) {
    console.error('[PATCH /clients/:id/lifecycle]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
