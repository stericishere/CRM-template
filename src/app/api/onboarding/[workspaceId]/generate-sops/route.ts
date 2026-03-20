import { NextRequest, NextResponse } from 'next/server'
import { generateSopsSchema } from '@/lib/onboarding/schemas'

// ──────────────────────────────────────────────────────────
// POST /api/onboarding/:workspaceId/generate-sops
//
// Triggers AI SOP generation via the onboarding-sops Edge Function.
// Returns the generated VerticalConfig for review before confirmation.
//
//  Client              API                    EF
//  ──────  POST ──>  validate body  ──>  onboarding-sops (generate)
//                                        LLM → VerticalConfig
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

    const parsed = generateSopsSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    // Invoke the onboarding-sops Edge Function in generate mode
    const efResponse = await fetch(`${SUPABASE_URL}/functions/v1/onboarding-sops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        mode: 'generate',
        ...parsed.data,
      }),
      signal: AbortSignal.timeout(60_000),
    })

    if (!efResponse.ok) {
      const errText = await efResponse.text().catch(() => 'Unknown error')
      console.error('[POST /generate-sops] EF failed:', efResponse.status, errText)
      return NextResponse.json(
        { error: 'SOP generation failed', details: errText },
        { status: 502 }
      )
    }

    const result = await efResponse.json()

    return NextResponse.json(result)
  } catch (err) {
    console.error('[POST /generate-sops]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
