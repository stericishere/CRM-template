import { NextRequest, NextResponse } from 'next/server'
import { patchKnowledgeSchema } from '@/lib/notes/schemas'
import { getServiceClient } from '@/lib/supabase/service'

type RouteParams = { params: Promise<{ workspaceId: string; chunkId: string }> }

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

// ──────────────────────────────────────────────────────────
// PATCH /api/workspaces/:workspaceId/knowledge/:chunkId
//
// Body: { content }
// Updates content and triggers re-embedding via EF.
//
//  API ──update──> knowledge_chunks ──call──> embed-knowledge EF
// ──────────────────────────────────────────────────────────
export async function PATCH(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, chunkId } = await params

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = patchKnowledgeSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    // 1. Fetch existing chunk to get its source (needed for re-embedding)
    const { data: existing, error: fetchError } = await supabase
      .from('knowledge_chunks')
      .select('id, source')
      .eq('id', chunkId)
      .eq('workspace_id', workspaceId)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Knowledge chunk not found' }, { status: 404 })
      }
      console.error('[PATCH /knowledge/:id] Fetch failed:', fetchError.message)
      return NextResponse.json(
        { error: 'Failed to fetch chunk' },
        { status: 500 }
      )
    }

    // 2. Update content and reset updated_at
    const { data: updated, error: updateError } = await supabase
      .from('knowledge_chunks')
      .update({
        content: parsed.data.content,
        updated_at: new Date().toISOString(),
      })
      .eq('id', chunkId)
      .eq('workspace_id', workspaceId)
      .select('id, workspace_id, content, source, source_ref, created_at, updated_at')
      .single()

    if (updateError) {
      console.error('[PATCH /knowledge/:id] Update failed:', updateError.message)
      return NextResponse.json(
        { error: 'Failed to update chunk' },
        { status: 500 }
      )
    }

    // 3. Re-embed via Edge Function (fire-and-await)
    let embeddingStatus = 'pending'
    try {
      const efResponse = await fetch(`${SUPABASE_URL}/functions/v1/embed-knowledge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          content: parsed.data.content,
          source: existing.source,
        }),
        signal: AbortSignal.timeout(60_000),
      })

      embeddingStatus = efResponse.ok ? 'complete' : 'failed'
    } catch (efErr) {
      console.error('[PATCH /knowledge/:id] Re-embed failed:', efErr)
      embeddingStatus = 'failed'
    }

    return NextResponse.json({ ...updated, embedding: embeddingStatus })
  } catch (err) {
    console.error('[PATCH /knowledge/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// DELETE /api/workspaces/:workspaceId/knowledge/:chunkId
//
// Deletes a single knowledge chunk.
// ──────────────────────────────────────────────────────────
export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, chunkId } = await params

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('knowledge_chunks')
      .delete()
      .eq('id', chunkId)
      .eq('workspace_id', workspaceId)
      .select('id')
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Knowledge chunk not found' }, { status: 404 })
      }
      console.error('[DELETE /knowledge/:id]', error.message)
      return NextResponse.json(
        { error: 'Failed to delete chunk' },
        { status: 500 }
      )
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[DELETE /knowledge/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
