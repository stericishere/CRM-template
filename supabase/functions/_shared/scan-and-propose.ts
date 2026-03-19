// supabase/functions/_shared/scan-and-propose.ts
// Shared helper for morning scan sub-scans that produce ProposedActions.
//
// Flow per candidate:
//
//   candidate ──> INSERT proposed_actions (tier, reason)
//             └──> [if LLM-powered] pgmq_send to client_worker queue
//
// Returns { found, actioned } counts for cron_run_log aggregation.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { ScanConfig, ScanResult } from './proactive-types.ts'

/**
 * For each candidate: create a ProposedAction with the given tier and reason.
 * For LLM-powered scans (follow-up, confirmation), queue a pgmq message
 * to invoke the Client Worker for contextual drafting.
 *
 * Per-candidate try-catch: single candidate failure never blocks others.
 */
export async function scanAndPropose(
  supabase: SupabaseClient,
  workspaceId: string,
  config: ScanConfig
): Promise<ScanResult> {
  const { candidates, proposalType, reason, tier, metadata } = config
  let actioned = 0

  for (const candidate of candidates) {
    try {
      // 1. Insert proposed_action
      const { error: insertError } = await supabase
        .from('proposed_actions')
        .insert({
          workspace_id: workspaceId,
          client_id: candidate.clientId,
          conversation_id: candidate.conversationId,
          action_type: proposalType,
          summary: reason,
          tier,
          payload: {
            source: 'morning_scan',
            reason,
            ...metadata,
            ...candidate,
          },
          status: 'pending',
        })

      if (insertError) {
        console.error(
          `[scan-and-propose] Failed to insert proposed_action for client ${candidate.clientId}:`,
          insertError.message
        )
        continue
      }

      // 2. For LLM-powered scans, queue a pgmq message for the Client Worker
      //    to generate a contextual draft. The worker will pick this up
      //    on its next poll cycle.
      if (proposalType === 'message_send') {
        try {
          await supabase.rpc('pgmq_send', {
            queue_name: 'client_worker',
            msg: {
              workspace_id: workspaceId,
              client_id: candidate.clientId,
              conversation_id: candidate.conversationId,
              trigger: 'morning_scan',
              scan_type: reason,
            },
          })
        } catch (queueErr) {
          // Queue failure is non-fatal: the proposed_action exists,
          // staff can still act on it manually.
          console.warn(
            `[scan-and-propose] Failed to queue client_worker for ${candidate.clientId}:`,
            queueErr
          )
        }
      }

      actioned++
    } catch (err) {
      console.error(
        `[scan-and-propose] Error processing candidate ${candidate.clientId}:`,
        err
      )
    }
  }

  return { found: candidates.length, actioned }
}
