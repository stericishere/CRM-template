import { NextRequest, NextResponse } from 'next/server'
import { identitySchema } from '@/lib/onboarding/schemas'
import { getServiceClient } from '@/lib/supabase/service'

// ──────────────────────────────────────────────────────────
// PUT /api/onboarding/:workspaceId/identity
//
// Save business identity: name, vertical, timezone, IG handle.
// ──────────────────────────────────────────────────────────
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

    const parsed = identitySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { business_name, vertical, timezone, instagram_handle, description } = parsed.data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { error } = await supabase
      .from('workspaces')
      .update({
        business_name,
        vertical_type: vertical,
        timezone,
        instagram_handle: instagram_handle ?? null,
      })
      .eq('id', workspaceId)

    if (error) {
      console.error('[PUT /identity]', error.message)
      return NextResponse.json({ error: 'Failed to save identity' }, { status: 500 })
    }

    return NextResponse.json({ status: 'saved' })
  } catch (err) {
    console.error('[PUT /identity]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
