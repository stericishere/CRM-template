import { NextRequest, NextResponse } from 'next/server'
import { mergeClientsSchema } from '@/lib/notes/schemas'
import { getServiceClient } from '@/lib/supabase/service'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

// ──────────────────────────────────────────────────────────
// POST /api/workspaces/:workspaceId/clients/merge
//
// Body: { source_client_id, target_client_id }
//
// Calls the merge_clients RPC which atomically:
//   1. Transfers all records (conversations, notes, follow-ups,
//      bookings, proposed_actions, memories) from source to target
//   2. Soft-deletes the source client
//
// After merge, creates a merge_history note on the target client.
//
//  API ──rpc──> merge_clients() ──> insert merge_history note
// ──────────────────────────────────────────────────────────
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = mergeClientsSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { source_client_id, target_client_id } = parsed.data

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    // 1. Call merge_clients RPC
    const { data: counts, error: rpcError } = await supabase
      .rpc('merge_clients', {
        p_workspace_id: workspaceId,
        p_source_client_id: source_client_id,
        p_target_client_id: target_client_id,
      })

    if (rpcError) {
      console.error('[POST /clients/merge] RPC failed:', rpcError.message)

      // Surface RPC validation errors (e.g. "Source client not found")
      if (rpcError.message.includes('not found')) {
        return NextResponse.json(
          { error: rpcError.message },
          { status: 404 }
        )
      }

      return NextResponse.json(
        { error: 'Merge failed', details: rpcError.message },
        { status: 500 }
      )
    }

    // 2. Create merge_history note on target client
    const mergeNote = `Merged from client ${source_client_id}. Records transferred: ${JSON.stringify(counts)}`

    const { error: noteError } = await supabase
      .from('notes')
      .insert({
        workspace_id: workspaceId,
        client_id: target_client_id,
        content: mergeNote,
        source: 'merge_history',
      })

    if (noteError) {
      // Non-fatal: merge succeeded, just log the note failure
      console.error('[POST /clients/merge] Note insert failed:', noteError.message)
    }

    return NextResponse.json({
      status: 'merged',
      source_client_id,
      target_client_id,
      counts,
    })
  } catch (err) {
    console.error('[POST /clients/merge]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
