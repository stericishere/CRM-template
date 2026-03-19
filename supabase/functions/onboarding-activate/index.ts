// supabase/functions/onboarding-activate/index.ts
// Verify all onboarding prerequisites and activate the workspace.
//
// POST body: { workspace_id }
//
// Flow:
//
//   POST /onboarding-activate { workspace_id }
//         |
//         +-- fetch workspace row
//         |
//         +-- verify prerequisites:
//         |     - whatsapp_connection_status = 'connected'
//         |     - business_name is set
//         |     - vertical_config is set
//         |     - knowledge_base is set OR knowledge_chunks exist
//         |
//         +-- if any missing --> 400 { error, missing_steps[] }
//         |
//         +-- UPDATE onboarding_status = 'complete'
//         |
//         +-- return capability map { status, capabilities }

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    const body = await req.json()
    const { workspace_id } = body

    if (!workspace_id) {
      return new Response(
        JSON.stringify({ error: 'Missing workspace_id' }),
        { status: 400 }
      )
    }

    const supabase = getSupabaseClient()

    // 1. Fetch workspace
    const { data: workspace, error: fetchError } = await supabase
      .from('workspaces')
      .select(`
        id,
        business_name,
        vertical_config,
        knowledge_base,
        whatsapp_connection_status,
        calendar_config,
        onboarding_status
      `)
      .eq('id', workspace_id)
      .single()

    if (fetchError || !workspace) {
      return new Response(
        JSON.stringify({ error: 'Workspace not found' }),
        { status: 404 }
      )
    }

    // 2. Check for knowledge_chunks if knowledge_base column is empty
    let hasKnowledgeChunks = false
    if (!workspace.knowledge_base) {
      const { count, error: countError } = await supabase
        .from('knowledge_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace_id)

      if (!countError && (count ?? 0) > 0) {
        hasKnowledgeChunks = true
      }
    }

    const hasKnowledge = !!workspace.knowledge_base || hasKnowledgeChunks

    // 3. Verify prerequisites
    const missingSteps: string[] = []

    if (workspace.whatsapp_connection_status !== 'connected') {
      missingSteps.push('whatsapp')
    }
    if (!workspace.business_name) {
      missingSteps.push('business_name')
    }
    if (!workspace.vertical_config) {
      missingSteps.push('vertical_config')
    }
    if (!hasKnowledge) {
      missingSteps.push('knowledge_base')
    }

    if (missingSteps.length > 0) {
      return new Response(
        JSON.stringify({
          error: 'Onboarding prerequisites not met',
          missing_steps: missingSteps,
        }),
        { status: 400 }
      )
    }

    // 4. Activate — set onboarding_status = 'complete'
    const { error: updateError } = await supabase
      .from('workspaces')
      .update({ onboarding_status: 'complete' })
      .eq('id', workspace_id)

    if (updateError) {
      console.error('[onboarding-activate] Failed to update status:', updateError.message)
      return new Response(
        JSON.stringify({ error: 'Failed to activate workspace' }),
        { status: 500 }
      )
    }

    // 5. Build capability map
    const capabilities = {
      whatsapp: true,
      ai_drafts: true,
      knowledge_search: hasKnowledge,
      calendar: !!workspace.calendar_config,
      proactive_scans: true,
    }

    console.log('[onboarding-activate] Workspace activated:', workspace_id, capabilities)

    return new Response(
      JSON.stringify({ status: 'activated', capabilities }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[onboarding-activate]', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
