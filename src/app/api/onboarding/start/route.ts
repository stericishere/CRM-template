import { NextRequest, NextResponse } from 'next/server'
import { startOnboardingSchema } from '@/lib/onboarding/schemas'
import { getServiceClient } from '@/lib/supabase/service'
import { assertAuthenticated } from '@/lib/supabase/assert-workspace-member'

// ──────────────────────────────────────────────────────────
// POST /api/onboarding/start
//
// Creates a workspace + staff record for the owner.
// Returns the workspace ID for subsequent onboarding steps.
//
//  Client                    API                          DB
//  ──────  POST /start ──>  validate  ──>  INSERT workspace
//                                          INSERT staff
//                           <── { workspace_id, status } ──
// ──────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const auth = await assertAuthenticated()
    if (auth instanceof NextResponse) return auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = startOnboardingSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { owner_name, owner_phone, owner_email } = parsed.data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    // 1. Create workspace with pending onboarding status
    const { data: workspace, error: wsError } = await supabase
      .from('workspaces')
      .insert({
        business_name: null,
        onboarding_status: 'in_progress',
        whatsapp_connection_status: 'disconnected',
      })
      .select('id')
      .single()

    if (wsError || !workspace) {
      console.error('[POST /onboarding/start] Workspace insert failed:', wsError?.message)
      return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 })
    }

    const wsId = (workspace as { id: string }).id

    // 2. Create staff record for the owner — id MUST match the auth user
    //    so that assertWorkspaceMember(workspaceId) passes on follow-up routes.
    const { error: staffError } = await supabase
      .from('staff')
      .insert({
        id: auth.user.id,
        workspace_id: wsId,
        full_name: owner_name,
        phone: owner_phone,
        email: owner_email ?? null,
        role: 'owner',
      })

    if (staffError) {
      console.error('[POST /onboarding/start] Staff insert failed:', staffError.message)
      await supabase.from('workspaces').delete().eq('id', wsId)
      return NextResponse.json({ error: 'Failed to create staff record' }, { status: 500 })
    }

    return NextResponse.json(
      { workspace_id: wsId, onboarding_status: 'in_progress' },
      { status: 201 }
    )
  } catch (err) {
    console.error('[POST /onboarding/start]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
