import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

// ──────────────────────────────────────────────────────────
// GET /api/onboarding/:workspaceId/status
//
// Returns current onboarding state for step resumption.
// Checks which steps are complete based on column values.
// ──────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string
  business_name: string | null
  vertical_type: string | null
  timezone: string | null
  knowledge_base: string | null
  whatsapp_connection_status: string
  whatsapp_phone_number: string | null
  instagram_scrape_data: unknown
  onboarding_status: string
  vertical_config: unknown
  tone_profile: unknown
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params
    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('workspaces')
      .select(`
        id,
        business_name,
        vertical_type,
        timezone,
        knowledge_base,
        whatsapp_connection_status,
        whatsapp_phone_number,
        instagram_scrape_data,
        onboarding_status,
        vertical_config,
        tone_profile
      `)
      .eq('id', workspaceId)
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }

    const workspace = data as WorkspaceRow

    // Derive step completion from column values
    const steps = {
      whatsapp: workspace.whatsapp_connection_status === 'connected',
      identity: !!(workspace.business_name && workspace.vertical_type),
      knowledge: !!workspace.knowledge_base,
      sops: !!workspace.vertical_config,
      tone: !!workspace.tone_profile,
      activation: workspace.onboarding_status === 'complete',
    }

    // Find current step (first incomplete)
    const stepOrder = ['whatsapp', 'identity', 'knowledge', 'sops', 'tone', 'activation'] as const
    const currentStep = stepOrder.find(s => !steps[s]) ?? 'complete'

    return NextResponse.json({
      workspace_id: workspace.id,
      onboarding_status: workspace.onboarding_status,
      current_step: currentStep,
      steps,
      workspace: {
        business_name: workspace.business_name,
        vertical: workspace.vertical_type,
        timezone: workspace.timezone,
        whatsapp_connection_status: workspace.whatsapp_connection_status,
        whatsapp_phone_number: workspace.whatsapp_phone_number,
        has_knowledge_base: !!workspace.knowledge_base,
        has_instagram_data: !!workspace.instagram_scrape_data,
        has_vertical_config: !!workspace.vertical_config,
        has_tone_profile: !!workspace.tone_profile,
      },
    })
  } catch (err) {
    console.error('[GET /onboarding/status]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
