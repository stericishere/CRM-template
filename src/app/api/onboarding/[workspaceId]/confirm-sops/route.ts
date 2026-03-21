import { NextRequest, NextResponse } from 'next/server'
import { confirmSopsSchema } from '@/lib/onboarding/schemas'
import { getServiceClient } from '@/lib/supabase/service'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

// ──────────────────────────────────────────────────────────
// PUT /api/onboarding/:workspaceId/confirm-sops
//
// Finalize SOPs: save the approved vertical_config to
// the workspace row. No Edge Function call needed — direct
// service-client write.
// ──────────────────────────────────────────────────────────

export async function PUT(
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

    const parsed = confirmSopsSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { error } = await supabase
      .from('workspaces')
      .update({ vertical_config: parsed.data.vertical_config })
      .eq('id', workspaceId)

    if (error) {
      console.error('[PUT /confirm-sops]', error.message)
      return NextResponse.json({ error: 'Failed to save vertical config' }, { status: 500 })
    }

    return NextResponse.json({ status: 'confirmed' })
  } catch (err) {
    console.error('[PUT /confirm-sops]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
