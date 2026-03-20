import { NextRequest, NextResponse } from 'next/server'
import { clientPatchSchema } from '@/lib/clients/types'
import * as clientRepo from '@/lib/clients/repository'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

type RouteParams = { params: Promise<{ workspaceId: string; clientId: string }> }

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/clients/:clientId
// ──────────────────────────────────────────────────────────
export async function GET(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, clientId } = await params

    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

    const client = await clientRepo.getById(workspaceId, clientId)
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    return NextResponse.json(client)
  } catch (err) {
    console.error('[GET /clients/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// PATCH /api/workspaces/:workspaceId/clients/:clientId
//
// Body: ClientPatch (full_name?, email?, tags?, preferences?)
// ──────────────────────────────────────────────────────────
export async function PATCH(
  request: NextRequest,
  { params }: RouteParams
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

    const parsed = clientPatchSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const updated = await clientRepo.patch(workspaceId, clientId, parsed.data)
    if (!updated) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    return NextResponse.json(updated)
  } catch (err) {
    console.error('[PATCH /clients/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// DELETE /api/workspaces/:workspaceId/clients/:clientId
//
// Soft-delete: sets deleted_at timestamp
// ──────────────────────────────────────────────────────────
export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, clientId } = await params

    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

    const deleted = await clientRepo.softDelete(workspaceId, clientId)
    if (!deleted) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    return NextResponse.json(deleted)
  } catch (err) {
    console.error('[DELETE /clients/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
