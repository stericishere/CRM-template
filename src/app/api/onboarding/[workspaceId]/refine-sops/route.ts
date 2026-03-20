import { NextRequest, NextResponse } from 'next/server'
import { refineSopsSchema } from '@/lib/onboarding/schemas'

// ──────────────────────────────────────────────────────────
// POST /api/onboarding/:workspaceId/refine-sops
//
// One round of conversational SOP refinement via the
// onboarding-sops Edge Function.
//
//  Client              API                    EF
//  ──────  POST ──>  validate body  ──>  onboarding-sops (refine)
//                                        LLM → updated VerticalConfig
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

    const parsed = refineSopsSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    // Invoke the onboarding-sops Edge Function in refine mode
    const efResponse = await fetch(`${SUPABASE_URL}/functions/v1/onboarding-sops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        mode: 'refine',
        ...parsed.data,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!efResponse.ok) {
      const errText = await efResponse.text().catch(() => 'Unknown error')
      console.error('[POST /refine-sops] EF failed:', efResponse.status, errText)
      return NextResponse.json(
        { error: 'SOP refinement failed', details: errText },
        { status: 502 }
      )
    }

    const result = await efResponse.json()

    return NextResponse.json(result)
  } catch (err) {
    console.error('[POST /refine-sops]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
