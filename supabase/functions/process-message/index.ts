// supabase/functions/process-message/index.ts
// Sprint 1: Dequeue + advisory lock + audit event
// Sprint 2: Context assembly + LLM + draft generation

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import type { InboundMessagePayload, AuditEvent } from '../_shared/types.ts'

serve(async (_req) => {
  const supabase = getSupabaseClient()

  try {
    // Dequeue one message from pgmq
    const { data: messages, error: dequeueError } = await supabase.rpc('pgmq_read', {
      queue_name: 'inbound_messages',
      vt: 60, // visibility timeout: 60 seconds
      qty: 1,
    })

    if (dequeueError) {
      console.error('Failed to dequeue:', dequeueError)
      return new Response(JSON.stringify({ error: 'Dequeue failed' }), { status: 500 })
    }

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 })
    }

    const queueMsg = messages[0]
    const payload = queueMsg.message as InboundMessagePayload

    console.log('Processing message:', {
      messageId: payload.message_id,
      workspaceId: payload.workspace_id,
      clientId: payload.client_id,
    })

    // Acquire advisory lock on client_id for per-client ordering
    // This ensures only one worker processes messages for a given client at a time
    //
    // ┌─────────────┐    ┌──────────────┐    ┌─────────────┐
    // │  pgmq_read   │───>│ advisory lock │───>│ process msg │
    // │  dequeue msg │    │ on client_id  │    │ + audit     │
    // └─────────────┘    └──────────────┘    └─────────────┘
    //                         │ fail              │ success
    //                         v                   v
    //                    ┌──────────┐       ┌─────────────┐
    //                    │ skip msg │       │ pgmq_delete  │
    //                    │ (retry)  │       │ from queue   │
    //                    └──────────┘       └─────────────┘
    //
    const lockKey = payload.client_id.replace(/-/g, '').slice(0, 8)
    const { data: lockAcquired } = await supabase.rpc('pg_try_advisory_xact_lock', {
      key: parseInt(lockKey, 16),
    })

    if (!lockAcquired) {
      // Another worker is processing this client's messages
      // Don't delete from queue — it will become visible again after VT expires
      console.log('Advisory lock not acquired, skipping:', payload.client_id)
      return new Response(JSON.stringify({ processed: 0, locked: true }), { status: 200 })
    }

    // Write audit event (fire-and-log pattern)
    const auditEvent: AuditEvent = {
      workspace_id: payload.workspace_id,
      actor_type: 'system',
      actor_id: null,
      action_type: 'message_received',
      target_type: 'message',
      target_id: payload.message_id,
      metadata: {
        client_id: payload.client_id,
        conversation_id: payload.conversation_id,
        phone: payload.phone,
        has_content: !!payload.content,
        media_type: payload.media_type,
      },
    }

    try {
      await supabase.from('audit_events').insert(auditEvent)
    } catch (auditErr) {
      // Audit failure never blocks processing
      console.error('Audit write failed (non-blocking):', auditErr)
    }

    // === Sprint 2: Context Assembly + LLM + Draft Generation ===
    // TODO: Implement in Sprint 2:
    // 1. Assemble context (client profile, recent messages, knowledge search)
    // 2. Call LLM (Claude Sonnet) with tool calling
    // 3. Execute tool results
    // 4. Save draft to drafts table (triggers Realtime: "draft ready")
    // 5. Save proposed_actions if any
    // 6. Log LLM usage to llm_usage table

    // Delete message from queue (successfully processed)
    await supabase.rpc('pgmq_delete', {
      queue_name: 'inbound_messages',
      msg_id: queueMsg.msg_id,
    })

    console.log('Message processed successfully:', payload.message_id)

    return new Response(
      JSON.stringify({ processed: 1, messageId: payload.message_id }),
      { status: 200 }
    )
  } catch (err) {
    console.error('Process-message error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
