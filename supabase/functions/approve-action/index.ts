// supabase/functions/approve-action/index.ts
// Staff approves or rejects a proposed action
// Called from the Next.js staff app when staff clicks approve/reject on a confirmation card
//
// Flow:
//
//   POST /approve-action { action_id, decision, staff_id }
//         │
//         ├─ validate inputs (method, required fields, decision enum)
//         │
//         ├─ atomic claim: UPDATE proposed_actions SET reviewed_by, reviewed_at
//         │         WHERE status='pending' AND reviewed_by IS NULL
//         │         └─ 409 if already claimed or resolved
//         │
//         ├─ if approved ──► executeApprovedAction(supabase, action)
//         │                        └─ execution failure is logged but does NOT revert approval
//         │
//         └─ INSERT audit_events (fire-and-log; failure is non-blocking)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { executeApprovedAction } from '../_shared/action-executor.ts'
import { bestEffortCancelTimer } from '../_shared/timer-helpers.ts'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    const { action_id, decision, staff_id } = await req.json()

    if (!action_id || !decision || !staff_id) {
      return new Response(
        JSON.stringify({ error: 'Missing action_id, decision, or staff_id' }),
        { status: 400 }
      )
    }

    if (decision !== 'approved' && decision !== 'rejected') {
      return new Response(
        JSON.stringify({ error: 'decision must be "approved" or "rejected"' }),
        { status: 400 }
      )
    }

    const supabase = getSupabaseClient()

    // 1. Atomically claim the action row via UPDATE WHERE status='pending'.
    //    This prevents two concurrent approvals from both executing side effects.
    const { data: action, error: claimError } = await supabase
      .from('proposed_actions')
      .update({
        reviewed_by: staff_id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', action_id)
      .eq('status', 'pending')
      .is('reviewed_by', null)
      .select('*')
      .single()

    if (claimError || !action) {
      // PGRST116 = no rows matched — either not found or already resolved/claimed
      const is409 = claimError?.code === 'PGRST116'
      return new Response(
        JSON.stringify({ error: is409 ? 'Action not found or already resolved' : (claimError?.message ?? 'Claim failed') }),
        { status: is409 ? 409 : 500 }
      )
    }

    // 2. If rejected, finalize status and return
    if (decision === 'rejected') {
      const { error: updateError } = await supabase
        .from('proposed_actions')
        .update({ status: 'rejected' })
        .eq('id', action_id)

      if (updateError) {
        return new Response(JSON.stringify({ error: updateError.message }), { status: 500 })
      }
    }

    // 3. If approved, execute FIRST — only mark approved after success.
    //    If execution fails, unclaim the row so staff can retry.
    let executionResult = null
    if (decision === 'approved') {
      executionResult = await executeApprovedAction(supabase, {
        id: action.id,
        workspaceId: action.workspace_id,
        clientId: action.client_id,
        conversationId: action.conversation_id,
        draftId: action.draft_id,
        actionType: action.action_type,
        summary: action.summary,
        tier: action.tier,
        payload: action.payload,
        status: 'approved',
      })

      if (!executionResult.success) {
        console.error('[approve-action] Execution failed, unclaiming row:', executionResult.error)
        // Unclaim so staff can retry
        await supabase
          .from('proposed_actions')
          .update({ reviewed_by: null, reviewed_at: null })
          .eq('id', action_id)

        return new Response(
          JSON.stringify({
            success: false,
            error: `Action execution failed: ${executionResult.error}`,
            retryable: true,
          }),
          { status: 500 }
        )
      }

      // Execution succeeded — now mark as approved
      const { error: updateError } = await supabase
        .from('proposed_actions')
        .update({ status: 'approved' })
        .eq('id', action_id)

      if (updateError) {
        // Execution succeeded but status update failed — log but don't fail
        console.error('[approve-action] Status update failed after execution:', updateError.message)
      }
    }

    // 5. Cancel draft_review_nudge timer — staff acted on the draft
    if (action.draft_id) {
      await bestEffortCancelTimer(action.draft_id, 'draft_review_nudge', 'staff_acted')
    }

    // 6. Audit event (fire-and-log; failure is non-blocking)
    try {
      await supabase.from('audit_events').insert({
        workspace_id: action.workspace_id,
        actor_type: 'staff',
        actor_id: staff_id,
        action_type: `action_${decision}`,
        target_type: 'proposed_action',
        target_id: action_id,
        metadata: {
          action_type: action.action_type,
          execution_result: executionResult,
        },
      })
    } catch (auditErr) {
      console.error('[approve-action] Audit write failed:', auditErr)
    }

    return new Response(
      JSON.stringify({
        success: true,
        decision,
        execution: executionResult,
      }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[approve-action] Error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
