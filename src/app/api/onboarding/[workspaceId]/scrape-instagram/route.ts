import { NextRequest, NextResponse } from 'next/server'
import { scrapeInstagramSchema } from '@/lib/onboarding/schemas'
import { getServiceClient } from '@/lib/supabase/service'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

// ──────────────────────────────────────────────────────────
// POST /api/onboarding/:workspaceId/scrape-instagram
//
// Triggers Instagram scraping via the onboarding-scrape Edge Function.
// Stores results in workspace.instagram_scrape_data.
// ──────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

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

    const parsed = scrapeInstagramSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    // Invoke the onboarding-scrape Edge Function
    const efResponse = await fetch(`${SUPABASE_URL}/functions/v1/onboarding-scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        handle: parsed.data.handle,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!efResponse.ok) {
      const errText = await efResponse.text().catch(() => 'Unknown error')
      console.error('[POST /scrape-instagram] EF failed:', efResponse.status, errText)
      return NextResponse.json(
        { error: 'Instagram scraping failed', details: errText },
        { status: 502 }
      )
    }

    const result = await efResponse.json()

    // Also save the scrape data to workspace for future reference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any
    await supabase
      .from('workspaces')
      .update({ instagram_scrape_data: result.profile })
      .eq('id', workspaceId)

    return NextResponse.json(result)
  } catch (err) {
    console.error('[POST /scrape-instagram]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
