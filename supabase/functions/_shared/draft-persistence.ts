// supabase/functions/_shared/draft-persistence.ts
// Saves draft to drafts table + updates conversation state
// The INSERT triggers Supabase Realtime ("draft ready" notification)

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { bestEffortStartTimer } from './timer-helpers.ts'

interface SaveDraftParams {
  conversationId: string
  workspaceId: string
  sourceMessageId: string
  content: string
  intentClassified: string
  confidenceScore: number
  knowledgeSources: string[]
  scenarioType: string
}

export async function saveDraft(
  supabase: SupabaseClient,
  params: SaveDraftParams
): Promise<{ draftId: string }> {
  const { data: draft, error } = await supabase
    .from('drafts')
    .insert({
      conversation_id: params.conversationId,
      workspace_id: params.workspaceId,
      source_message_id: params.sourceMessageId,
      content: params.content,
      intent_classified: params.intentClassified,
      confidence_score: params.confidenceScore,
      knowledge_sources: params.knowledgeSources,
      scenario_type: params.scenarioType,
      staff_action: null,
      edited_content: null,
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to save draft: ${error.message}`)

  // Update conversation state -> 'awaiting_staff_review'
  const { error: stateError } = await supabase
    .from('conversations')
    .update({ state: 'awaiting_staff_review' })
    .eq('id', params.conversationId)

  if (stateError) {
    console.error('[draft_persistence] Failed to update conversation state:', stateError.message)
    // Non-fatal: draft is saved, staff will see it
  }

  // Start draft_review_nudge timer (1h) — fire-and-forget
  // If staff doesn't review the draft within 1 hour, the timer scanner
  // will insert a staff_notifications reminder.
  await bestEffortStartTimer(
    params.workspaceId,
    'draft_review_nudge',
    'draft',
    draft.id,
    60 * 60 * 1000 // 1 hour
  )

  return { draftId: draft.id }
}

/**
 * Log LLM usage to the llm_usage table.
 * Best-effort: failures are logged but never block processing.
 */
export async function logLLMUsage(
  supabase: SupabaseClient,
  params: {
    workspaceId: string
    clientId: string | null
    edgeFunctionName: string
    model: string
    tokensIn: number
    tokensOut: number
    latencyMs: number
    costUsd: number
  }
): Promise<void> {
  try {
    const { error } = await supabase.from('llm_usage').insert({
      workspace_id: params.workspaceId,
      client_id: params.clientId,
      edge_function_name: params.edgeFunctionName,
      model: params.model,
      tokens_in: params.tokensIn,
      tokens_out: params.tokensOut,
      latency_ms: params.latencyMs,
      cost_usd: params.costUsd,
    })

    if (error) {
      console.error('[llm_usage] Insert failed:', error.message)
    }
  } catch (err) {
    console.error('[llm_usage] Exception:', err)
  }
}
