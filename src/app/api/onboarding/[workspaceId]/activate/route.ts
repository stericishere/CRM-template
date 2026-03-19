import { NextRequest, NextResponse } from 'next/server'

// ──────────────────────────────────────────────────────────
// POST /api/onboarding/:workspaceId/activate
//
// Activate workspace after all onboarding steps complete.
// Delegates prerequisite verification to the onboarding-activate
// Edge Function — this route is a thin proxy.
//
//  Client              API                           EF
//  ──────  POST ──>  forward  ──>  onboarding-activate
//                    workspace_id  verify prereqs + flip status
// ──────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    const efResponse = await fetch(`${SUPABASE_URL}/functions/v1/onboarding-activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ workspace_id: workspaceId }),
      signal: AbortSignal.timeout(30_000),
    })

    const result = await efResponse.json()

    if (!efResponse.ok) {
      return NextResponse.json(result, { status: efResponse.status })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[POST /onboarding/activate]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
