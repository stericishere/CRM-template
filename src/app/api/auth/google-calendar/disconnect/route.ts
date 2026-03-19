import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getServiceClient } from '@/lib/supabase/service'

// ──────────────────────────────────────────────────────────
// POST /api/auth/google-calendar/disconnect
//
// Clears calendar_config for the given workspace.
//
// Body: { workspace_id: string }
// ──────────────────────────────────────────────────────────

const disconnectSchema = z.object({
  workspace_id: z.string().uuid(),
})

export async function POST(request: NextRequest) {
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = disconnectSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { workspace_id } = parsed.data

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { error: updateError } = await supabase
      .from('workspaces')
      .update({ calendar_config: null })
      .eq('id', workspace_id)

    if (updateError) {
      console.error('[POST /auth/google-calendar/disconnect]', updateError.message)
      return NextResponse.json(
        { error: 'Failed to disconnect calendar' },
        { status: 500 }
      )
    }

    return NextResponse.json({ status: 'disconnected' })
  } catch (err) {
    console.error('[POST /auth/google-calendar/disconnect]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
