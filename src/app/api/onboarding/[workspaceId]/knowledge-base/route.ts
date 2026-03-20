import { NextRequest, NextResponse } from 'next/server'
import { knowledgeBaseSchema } from '@/lib/onboarding/schemas'
import { getServiceClient } from '@/lib/supabase/service'

// ──────────────────────────────────────────────────────────
// PUT /api/onboarding/:workspaceId/knowledge-base
//
// Save knowledge base text and trigger embedding via the
// embed-knowledge Edge Function.
//
//  Client              API                    EF
//  ──────  PUT ──>  save KB text  ──>  embed-knowledge
//                   to workspace       chunk + vectorize
// ──────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

export async function PUT(
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

    const parsed = knowledgeBaseSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { content, source } = parsed.data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    // 1. Save raw KB text to workspace
    const { error: updateError } = await supabase
      .from('workspaces')
      .update({ knowledge_base: content })
      .eq('id', workspaceId)

    if (updateError) {
      console.error('[PUT /knowledge-base] Update failed:', updateError.message)
      return NextResponse.json({ error: 'Failed to save knowledge base' }, { status: 500 })
    }

    // 2. Trigger embedding (fire-and-await — we want to confirm success)
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
      console.error('[PUT /knowledge-base] Embed failed:', efResponse.status, errText)
      // KB text is saved even if embedding fails — can retry later
      return NextResponse.json(
        { status: 'saved', embedding: 'failed', details: errText },
        { status: 207 }
      )
    }

    const embedResult = await efResponse.json()

    return NextResponse.json({
      status: 'saved',
      embedding: 'complete',
      chunks: embedResult.chunks,
    })
  } catch (err) {
    console.error('[PUT /knowledge-base]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
