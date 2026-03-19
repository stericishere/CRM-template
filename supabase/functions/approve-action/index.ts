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
//         ├─ fetch proposed_actions row
//         │         └─ 404 if not found
//         │
//         ├─ guard: status must be 'pending'
//         │         └─ 409 if already resolved
//         │
//         ├─ UPDATE proposed_actions SET status=decision, resolved_at, resolved_by
//         │
//         ├─ if approved ──► executeApprovedAction(supabase, action)
//         │                        └─ execution failure is logged but does NOT revert approval
//         │
//         └─ INSERT audit_events (fire-and-log; failure is non-blocking)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { executeApprovedAction } from '../_shared/action-executor.ts'

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

    // 1. Fetch the proposed action
    const { data: action, error: fetchError } = await supabase
      .from('proposed_actions')
      .select('*')
      .eq('id', action_id)
      .single()

    if (fetchError || !action) {
      return new Response(
        JSON.stringify({ error: 'Action not found' }),
        { status: 404 }
      )
    }

    // 2. Check action is still pending
    if (action.status !== 'pending') {
      return new Response(
        JSON.stringify({ error: `Action already ${action.status}` }),
        { status: 409 }
      )
    }

    // 3. If rejected, update status immediately and return
    if (decision === 'rejected') {
      const { error: updateError } = await supabase
        .from('proposed_actions')
        .update({
          status: 'rejected',
          resolved_at: new Date().toISOString(),
          resolved_by: staff_id,
        })
        .eq('id', action_id)

      if (updateError) {
        return new Response(JSON.stringify({ error: updateError.message }), { status: 500 })
      }
    }

    // 4. If approved, execute FIRST — only mark approved after success.
    //    If execution fails, the action stays pending so staff can retry.
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
        console.error('[approve-action] Execution failed, action stays pending:', executionResult.error)
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
        .update({
          status: 'approved',
          resolved_at: new Date().toISOString(),
          resolved_by: staff_id,
        })
        .eq('id', action_id)

      if (updateError) {
        // Execution succeeded but status update failed — log but don't fail
        // The action was executed; worst case staff sees it as pending still
        console.error('[approve-action] Status update failed after execution:', updateError.message)
      }
    }

    // 5. Audit event (fire-and-log; failure is non-blocking)
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
