import { NextRequest, NextResponse } from 'next/server'
import { createKnowledgeSchema } from '@/lib/notes/schemas'
import { getServiceClient } from '@/lib/supabase/service'

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/knowledge
//
// Query params: source (optional — filter by source)
// Returns knowledge chunks ordered by created_at DESC.
// ──────────────────────────────────────────────────────────
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params
    const url = request.nextUrl
    const source = url.searchParams.get('source')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    let query = supabase
      .from('knowledge_chunks')
      .select('id, workspace_id, content, source, source_ref, created_at, updated_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })

    if (source) {
      query = query.eq('source', source)
    }

    const { data, error } = await query

    if (error) {
      console.error('[GET /knowledge] Query failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to fetch knowledge chunks' },
        { status: 500 }
      )
    }

    return NextResponse.json({ data: data ?? [] })
  } catch (err) {
    console.error('[GET /knowledge]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// POST /api/workspaces/:workspaceId/knowledge
//
// Body: { content, source }
// Creates a text knowledge chunk and triggers embedding.
//
//  API ──insert──> knowledge_chunks ──call──> embed-knowledge EF
// ──────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createKnowledgeSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { content, source } = parsed.data

    // Trigger embed-knowledge Edge Function which handles chunking + vectorization
    const efResponse = await fetch(`${SUPABASE_URL}/functions/v1/embed-knowledge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        content,
        source,
      }),
      signal: AbortSignal.timeout(60_000),
    })

    if (!efResponse.ok) {
      const errText = await efResponse.text().catch(() => 'Unknown error')
      console.error('[POST /knowledge] Embed failed:', efResponse.status, errText)
      return NextResponse.json(
        { error: 'Failed to embed knowledge', details: errText },
        { status: 500 }
      )
    }

    const embedResult = await efResponse.json()

    return NextResponse.json(
      { status: 'created', chunks: embedResult.chunks },
      { status: 201 }
    )
  } catch (err) {
    console.error('[POST /knowledge]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// DELETE /api/workspaces/:workspaceId/knowledge?source=...
//
// Deletes all knowledge chunks for a given source.
// Requires ?source query param.
// ──────────────────────────────────────────────────────────
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params
    const url = request.nextUrl
    const source = url.searchParams.get('source')

    if (!source) {
      return NextResponse.json(
        { error: 'source query param is required' },
        { status: 400 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { error, count } = await supabase
      .from('knowledge_chunks')
      .delete({ count: 'exact' })
      .eq('workspace_id', workspaceId)
      .eq('source', source)

    if (error) {
      console.error('[DELETE /knowledge] Delete failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to delete knowledge chunks' },
        { status: 500 }
      )
    }

    return NextResponse.json({ deleted: count ?? 0 })
  } catch (err) {
    console.error('[DELETE /knowledge]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
