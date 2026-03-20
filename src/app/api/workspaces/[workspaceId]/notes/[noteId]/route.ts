import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'

type RouteParams = { params: Promise<{ workspaceId: string; noteId: string }> }

// ──────────────────────────────────────────────────────────
// DELETE /api/workspaces/:workspaceId/notes/:noteId
//
// Hard-deletes a note, scoped to workspace.
// ──────────────────────────────────────────────────────────
export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, noteId } = await params

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('notes')
      .delete()
      .eq('id', noteId)
      .eq('workspace_id', workspaceId)
      .select('*')
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Note not found' }, { status: 404 })
      }
      console.error('[DELETE /notes/:id]', error.message)
      return NextResponse.json(
        { error: 'Failed to delete note' },
        { status: 500 }
      )
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[DELETE /notes/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
