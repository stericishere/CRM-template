// supabase/functions/process-message/index.ts
// Sprint 1: Dequeue + advisory lock + audit event
// Sprint 2: DLQ check + context assembly + LLM + approval policy + draft generation
//
// Full pipeline flow:
//
//  ┌──────────────┐
//  │ pgmq_read    │  Dequeue one message (VT=120s for LLM processing)
//  └──────┬───────┘
//         │
//         v
//  ┌──────────────┐
//  │ DLQ check    │  read_ct > 3 → move to inbound_dlq, skip processing
//  └──────┬───────┘
//         │
//         v
//  ┌──────────────┐
//  │ Advisory lock│  Per-client lock — skip if another worker holds it
//  └──────┬───────┘
//         │
//         v
//  ┌──────────────┐
//  │ Audit event  │  Fire-and-log (non-blocking)
//  └──────┬───────┘
//         │
//         v
//  ┌──────────────┐
//  │ Idempotency  │  Skip if pending draft already exists for conversation
//  └──────┬───────┘
//         │
//         v
//  ┌──────────────────────────────────────────────────────────┐
//  │                    AI Pipeline                           │
//  │  assembleContext → invokeClientWorker → approval policy  │
//  │  → save auto actions → save review actions               │
//  │  → saveDraft → logLLMUsage                               │
//  └──────┬───────────────────────────────────────────────────┘
//         │
//         v
//  ┌──────────────┐
//  │ pgmq_delete  │  ACK message from queue
//  └──────────────┘

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import type { InboundMessagePayload, AuditEvent } from '../_shared/types.ts'
import type { InboundMessage } from '../_shared/sprint2-types.ts'
import { assembleContext } from '../_shared/context-assembly.ts'
import { invokeClientWorker } from '../_shared/agent-runtime.ts'
import { createToolRegistry } from '../_shared/tool-registry.ts'
import { evaluateApprovalPolicy } from '../_shared/approval-policy.ts'
import { saveDraft, logLLMUsage } from '../_shared/draft-persistence.ts'
import { estimateCost, PRO_MODEL } from '../_shared/llm-client.ts'
import { bestEffortCancelTimer } from '../_shared/timer-helpers.ts'
import { processMedia } from '../_shared/media-processor.ts'

// VT raised to 120s to give the LLM pipeline time to complete before
// the message becomes visible again for retry.
const QUEUE_VT_SECONDS = 120
// Messages read more than this many times go to DLQ instead of retrying.
const DLQ_READ_CT_THRESHOLD = 3

serve(async (_req) => {
  const supabase = getSupabaseClient()

  try {
    // -------------------------------------------------------------------------
    // 1. Dequeue one message from pgmq
    // -------------------------------------------------------------------------
    const { data: messages, error: dequeueError } = await supabase.rpc('pgmq_read', {
      queue_name: 'inbound_messages',
      vt: QUEUE_VT_SECONDS,
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
      readCt: queueMsg.read_ct,
    })

    // -------------------------------------------------------------------------
    // 2. DLQ check: if read_ct > threshold, move to inbound_dlq and stop
    // -------------------------------------------------------------------------
    if (queueMsg.read_ct > DLQ_READ_CT_THRESHOLD) {
      console.warn('Message exceeded retry limit, routing to DLQ:', {
        messageId: payload.message_id,
        readCt: queueMsg.read_ct,
      })

      // Send to DLQ via pgmq (inbound_dlq is a pgmq queue, not a regular table)
      const { error: dlqError } = await supabase.rpc('pgmq_send', {
        queue_name: 'inbound_dlq',
        msg: {
          ...payload,
          original_msg_id: queueMsg.msg_id,
          read_ct: queueMsg.read_ct,
          failed_at: new Date().toISOString(),
        },
      })

      if (dlqError) {
        // DLQ write failed — do NOT delete from main queue, let VT expire for retry
        console.error('DLQ write failed, leaving message in queue for retry:', dlqError.message)
        return new Response(
          JSON.stringify({ processed: 0, dlq_error: true }),
          { status: 500 }
        )
      }

      // Only delete from main queue after successful DLQ write
      await supabase.rpc('pgmq_delete', {
        queue_name: 'inbound_messages',
        msg_id: queueMsg.msg_id,
      })

      return new Response(
        JSON.stringify({ processed: 0, dlq: true, messageId: payload.message_id }),
        { status: 200 }
      )
    }

    // -------------------------------------------------------------------------
    // 3. Acquire advisory lock on client_id for per-client ordering
    //    Only one worker processes messages for a given client at a time.
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
      // Another worker is processing this client's messages.
      // Don't delete from queue — it will become visible again after VT expires.
      console.log('Advisory lock not acquired, skipping:', payload.client_id)
      return new Response(JSON.stringify({ processed: 0, locked: true }), { status: 200 })
    }

    // -------------------------------------------------------------------------
    // 4. Write audit event (fire-and-log pattern, non-blocking)
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // 4b. Cancel stale_conversation timer — client just messaged back
    //     Fire-and-forget: never blocks processing
    // -------------------------------------------------------------------------
    await bestEffortCancelTimer(
      payload.conversation_id,
      'stale_conversation',
      'client_messaged'
    )

    // -------------------------------------------------------------------------
    // 5. Idempotency check: skip if this specific message was already processed.
    //    Check by message_id (not conversation) — a client may send multiple
    //    messages before staff reviews the first draft. Each message deserves
    //    its own draft.
    // -------------------------------------------------------------------------
    const { data: existingDraft, error: idempotencyError } = await supabase
      .from('messages')
      .select('id')
      .eq('id', payload.message_id)
      .single()

    // Check if a draft was already generated for this specific inbound message
    // by looking for a draft whose metadata references this message_id
    const alreadyProcessed = existingDraft
      ? await supabase
          .from('drafts')
          .select('id')
          .eq('conversation_id', payload.conversation_id)
          .eq('source_message_id', payload.message_id)
          .limit(1)
          .maybeSingle()
      : null

    if (idempotencyError) {
      console.error('Idempotency check failed (non-blocking, continuing):', idempotencyError?.message)
    } else if (alreadyProcessed?.data) {
      console.log('Draft already exists for this message, skipping:', {
        messageId: payload.message_id,
        draftId: alreadyProcessed.data.id,
      })

      await supabase.rpc('pgmq_delete', {
        queue_name: 'inbound_messages',
        msg_id: queueMsg.msg_id,
      })

      return new Response(
        JSON.stringify({ processed: 0, idempotent: true, messageId: payload.message_id }),
        { status: 200 }
      )
    }

    // -------------------------------------------------------------------------
    // 5b. Media pre-processing — transcribe audio, extract metadata
    //     Runs BEFORE the AI pipeline so transcription is available for context.
    //
    //  ┌───────────────┐    ┌────────────────┐    ┌───────────────┐
    //  │ has media_type?│───>│ fetch media_url │───>│ processMedia  │
    //  │               │ no │ from messages   │    │ (whisper/meta)│
    //  │  skip         │    └────────────────┘    └──────┬────────┘
    //  └───────────────┘                                 │
    //                                                    v
    //                                           ┌────────────────┐
    //                                           │ update message │
    //                                           │ row with result│
    //                                           └────────────────┘
    // -------------------------------------------------------------------------
    let mediaTranscription: string | null = null

    if (payload.media_type) {
      try {
        // Fetch media_url from the messages table (not in queue payload)
        const { data: msgRow } = await supabase
          .from('messages')
          .select('media_url')
          .eq('id', payload.message_id)
          .single()

        const mediaResult = await processMedia(
          supabase,
          payload.message_id,
          payload.media_type,
          msgRow?.media_url ?? null
        )

        mediaTranscription = mediaResult.transcription

        // Persist transcription + metadata back to the message row
        const updateFields: Record<string, unknown> = {
          transcription_status: mediaResult.transcription_status,
        }
        if (mediaResult.transcription) {
          updateFields.media_transcription = mediaResult.transcription
        }
        if (mediaResult.media_metadata) {
          updateFields.media_metadata = mediaResult.media_metadata
        }

        await supabase
          .from('messages')
          .update(updateFields)
          .eq('id', payload.message_id)

        console.log('[media] Message updated:', {
          messageId: payload.message_id,
          transcriptionStatus: mediaResult.transcription_status,
          hasTranscription: !!mediaResult.transcription,
        })
      } catch (mediaErr) {
        // Media processing failure is non-fatal — continue with text-only context
        console.error('[media] Processing failed (non-blocking):', mediaErr)
      }
    }

    // -------------------------------------------------------------------------
    // 6–12. AI Pipeline — wrapped in try/catch so VT expiry handles retries
    // -------------------------------------------------------------------------
    try {
      const pipelineStart = Date.now()

      // 6. Context assembly — all DB reads run in parallel
      const inboundMessage: InboundMessage = {
        content: payload.content,
        mediaType: payload.media_type,
        mediaTranscription,
        timestamp: new Date().toISOString(),
      }

      console.log('[pipeline] Assembling context', {
        workspaceId: payload.workspace_id,
        clientId: payload.client_id,
      })

      const context = await assembleContext(
        supabase,
        payload.workspace_id,
        payload.client_id,
        inboundMessage
      )

      // 7. Agent runtime — LLM tool-calling loop
      const toolRegistry = createToolRegistry(supabase)

      console.log('[pipeline] Invoking client worker', {
        model: PRO_MODEL,
        conversationId: payload.conversation_id,
      })

      const workerResult = await invokeClientWorker(context, toolRegistry, {
        model: PRO_MODEL,
        maxTokens: 1024,
        conversationId: payload.conversation_id,
      })

      const latencyMs = Date.now() - pipelineStart

      console.log('[pipeline] Worker completed', {
        intent: workerResult.intent,
        confidence: workerResult.confidence,
        scenarioType: workerResult.scenarioType,
        proposedActionsCount: workerResult.proposedActions.length,
        tokensIn: workerResult.usage.tokensIn,
        tokensOut: workerResult.usage.tokensOut,
        latencyMs,
      })

      // 8. Approval policy — classify proposed actions by tier
      const { auto: autoActions, review: reviewActions, humanOnly: humanOnlyActions } =
        evaluateApprovalPolicy(workerResult.proposedActions)

      // 9. Save draft + proposed actions
      //    Draft save triggers Supabase Realtime ("draft ready" notification).
      //    Proposed actions must be saved TOGETHER with the draft — if actions
      //    fail but draft succeeds, the idempotency check would skip retries.
      const { draftId } = await saveDraft(supabase, {
        conversationId: payload.conversation_id,
        workspaceId: payload.workspace_id,
        sourceMessageId: payload.message_id,
        content: workerResult.draft,
        intentClassified: workerResult.intent,
        confidenceScore: workerResult.confidence,
        knowledgeSources: workerResult.knowledgeSources,
        scenarioType: workerResult.scenarioType,
      })

      console.log('[pipeline] Draft saved', { draftId })

      // 10. Save review + human_only actions to proposed_actions table.
      const pendingActions = [...reviewActions, ...humanOnlyActions]
      if (pendingActions.length > 0) {
        const rows = pendingActions.map(action => ({
          workspace_id: action.workspaceId,
          client_id: action.clientId,
          conversation_id: action.conversationId,
          draft_id: draftId,
          action_type: action.actionType,
          summary: action.summary,
          tier: action.tier,
          payload: action.payload,
          status: 'pending',
        }))

        const { error: actionsError } = await supabase
          .from('proposed_actions')
          .insert(rows)

        if (actionsError) {
          // Actions failed but draft exists — delete the draft so retry
          // recreates both. Without this, idempotency would skip the message.
          console.error('[pipeline] proposed_actions insert failed, rolling back draft:', actionsError.message)
          await supabase.from('drafts').delete().eq('id', draftId)
          throw new Error(`Failed to insert proposed_actions: ${actionsError.message}`)
        }

        console.log('[pipeline] Proposed actions saved', {
          review: reviewActions.length,
          humanOnly: humanOnlyActions.length,
          auto: autoActions.length,
        })
      }

      // 11. Log LLM usage (best-effort, failures are logged inside logLLMUsage)
      const costUsd = estimateCost(
        PRO_MODEL,
        workerResult.usage.tokensIn,
        workerResult.usage.tokensOut
      )

      await logLLMUsage(supabase, {
        workspaceId: payload.workspace_id,
        clientId: payload.client_id,
        edgeFunctionName: 'process-message',
        model: PRO_MODEL,
        tokensIn: workerResult.usage.tokensIn,
        tokensOut: workerResult.usage.tokensOut,
        latencyMs,
        costUsd,
      })

    } catch (pipelineErr) {
      // AI pipeline failure: do NOT delete from queue so VT expiry causes retry.
      // The DLQ check above ensures we don't retry indefinitely.
      console.error('[pipeline] AI pipeline failed — message will retry after VT:', pipelineErr)
      return new Response(
        JSON.stringify({ error: String(pipelineErr), retrying: true }),
        { status: 500 }
      )
    }

    // -------------------------------------------------------------------------
    // 13. Delete message from queue (successfully processed)
    // -------------------------------------------------------------------------
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
