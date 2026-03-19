import type { SupabaseClient } from '@supabase/supabase-js'

export type StaffAction = 'sent_as_is' | 'edited_and_sent' | 'regenerated' | 'discarded'

export interface DraftEditSignalInput {
  workspaceId: string
  clientId: string
  draftId: string
  staffAction: StaffAction
  originalDraft: string
  finalVersion: string | null
  intentClassified: string
  scenarioType: string
}

/**
 * Determine staff action by comparing original draft to sent text.
 */
export function determineStaffAction(
  originalContent: string,
  sentText: string
): 'sent_as_is' | 'edited_and_sent' {
  return originalContent === sentText ? 'sent_as_is' : 'edited_and_sent'
}

/**
 * Record a draft edit signal. Non-blocking: never throws.
 * Returns { success: true } or { success: false, error }.
 */
export async function recordDraftEditSignal(
  supabase: SupabaseClient,
  input: DraftEditSignalInput
): Promise<{ success: boolean; error?: string }> {
  try {
    // Validate: sent_as_is and edited_and_sent require finalVersion
    if ((input.staffAction === 'sent_as_is' || input.staffAction === 'edited_and_sent') && !input.finalVersion) {
      const msg = `finalVersion required for ${input.staffAction}`
      console.error('[learning] validation failed', { draftId: input.draftId, error: msg })
      return { success: false, error: msg }
    }

    // Sentinel substitution for missing classifications
    const intentClassified = input.intentClassified || 'unclassified'
    const scenarioType = input.scenarioType || 'unclassified'

    if (!input.intentClassified || !input.scenarioType) {
      const missingFields = []
      if (!input.intentClassified) missingFields.push('intentClassified')
      if (!input.scenarioType) missingFields.push('scenarioType')
      console.warn('[learning] missing classification on signal write', {
        draftId: input.draftId,
        missingFields,
      })
    }

    const { error } = await supabase
      .from('draft_edit_signals')
      .insert({
        workspace_id: input.workspaceId,
        client_id: input.clientId,
        draft_id: input.draftId,
        staff_action: input.staffAction,
        original_draft: input.originalDraft,
        final_version: input.finalVersion,
        intent_classified: intentClassified,
        scenario_type: scenarioType,
      })

    if (error) {
      console.error('[learning] signal write failed', {
        draftId: input.draftId,
        action: input.staffAction,
        error: error.message,
        code: error.code,
      })
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[learning] signal write threw', {
      draftId: input.draftId,
      action: input.staffAction,
      error: message,
    })
    return { success: false, error: message }
  }
}
