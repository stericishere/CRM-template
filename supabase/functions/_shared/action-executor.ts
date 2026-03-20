// supabase/functions/_shared/action-executor.ts
// Dispatches approved actions to domain writes
// Called after staff approval via approve-action Edge Function
//
// Flow:
//
//   approve-action Edge Function
//         │
//         ▼
//   executeApprovedAction(supabase, action)
//         │
//         ├─ booking_create      → bookings INSERT
//         ├─ client_update       → clients UPDATE (scoped fields)
//         ├─ followup_create     → follow_ups INSERT
//         ├─ message_send        → messages INSERT + Baileys /send dispatch
//         ├─ note_create         → notes INSERT
//         ├─ tag_attach          → clients UPDATE tags[] (read-modify-write)
//         └─ last_contacted_update → clients UPDATE last_contacted_at

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { ProposedAction } from './sprint2-types.ts'
import { bestEffortCancelTimer } from './timer-helpers.ts'

interface ExecutionResult {
  success: boolean
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * Execute an approved action by dispatching to the appropriate domain write.
 * Each action type has its own handler.
 *
 * All writes are scoped by workspace_id to prevent cross-tenant leakage.
 */
export async function executeApprovedAction(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  try {
    switch (action.actionType) {
      case 'booking_create':
        return await executeBookingCreate(supabase, action)
      case 'client_update':
        return await executeClientUpdate(supabase, action)
      case 'followup_create':
        return await executeFollowUpCreate(supabase, action)
      case 'message_send':
        return await executeMessageSend(supabase, action)
      case 'note_create':
        return await executeNoteCreate(supabase, action)
      case 'tag_attach':
        return await executeTagAttach(supabase, action)
      case 'last_contacted_update':
        return await executeLastContactedUpdate(supabase, action)
      default:
        return { success: false, error: `Unknown action type: ${action.actionType}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[action_executor] ${action.actionType} failed:`, message)
    return { success: false, error: message }
  }
}

async function executeBookingCreate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const appointmentType = action.payload.appointmentType as string
  const startTime = action.payload.startTime as string
  const notes = (action.payload.notes as string) ?? null

  if (!appointmentType || !startTime) {
    return { success: false, error: 'Missing appointmentType or startTime in payload' }
  }

  // Look up service duration from workspace vertical_config
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('vertical_config')
    .eq('id', action.workspaceId)
    .single()

  const verticalConfig = workspace?.vertical_config as Record<string, unknown> | null
  // JSONB stores snake_case keys (from onboarding SOP generation)
  const appointmentTypes = Array.isArray(verticalConfig?.appointment_types)
    ? (verticalConfig.appointment_types as Array<{ name: string; duration_minutes?: number }>)
    : []

  const serviceConfig = appointmentTypes.find(
    t => t.name.toLowerCase() === appointmentType.toLowerCase()
  )
  const durationMinutes = serviceConfig?.duration_minutes ?? 60 // default 60 min

  // Compute end_time from start_time + duration
  const startDate = new Date(startTime)
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000)

  const { error } = await supabase.from('bookings').insert({
    workspace_id: action.workspaceId,
    client_id: action.clientId,
    appointment_type: appointmentType,
    start_time: startDate.toISOString(),
    end_time: endDate.toISOString(),
    status: 'confirmed',
    confirmation_status: 'confirmed',
    notes,
  })

  if (error) return { success: false, error: error.message }

  // Cancel stale_conversation timer — booking confirms active engagement
  if (action.conversationId) {
    await bestEffortCancelTimer(
      action.conversationId,
      'stale_conversation',
      'booking_confirmed'
    )
  }

  return {
    success: true,
    metadata: { appointmentType, startTime, durationMinutes, endTime: endDate.toISOString() },
  }
}

async function executeClientUpdate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const changes = action.payload.changes as Record<string, unknown> ?? {}
  const { error } = await supabase
    .from('clients')
    .update(changes)
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)

  if (error) return { success: false, error: error.message }
  return { success: true, metadata: { updatedFields: Object.keys(changes) } }
}

async function executeFollowUpCreate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const { error } = await supabase.from('follow_ups').insert({
    workspace_id: action.workspaceId,
    client_id: action.clientId,
    content: action.payload.description,
    due_date: action.payload.dueDate ?? null,
    status: 'open',
    source: 'ai_proposed',
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}

async function executeMessageSend(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  // 1. Resolve message content — check sources in priority order:
  //    a) payload.messageContent (explicit content)
  //    b) linked draft via draft_id (only the specific draft tied to this action)
  //    c) generate from scan metadata (appointment reminders, follow-ups)
  //
  // NOTE: We intentionally do NOT fall back to "latest conversation draft" —
  // that risks sending an unrelated older draft when the intended one hasn't
  // been generated yet.
  let messageContent = action.payload.messageContent as string | undefined

  if (!messageContent && action.draftId) {
    const { data: draft } = await supabase
      .from('drafts')
      .select('content, edited_content')
      .eq('id', action.draftId)
      .single()
    messageContent = (draft?.edited_content ?? draft?.content) as string | undefined
  }

  // Fallback: generate from scan metadata for known scan types
  if (!messageContent && action.payload.source === 'morning_scan') {
    messageContent = buildScanMessage(action.payload)
  }

  if (!messageContent) {
    return { success: false, error: 'No message content found in draft or payload' }
  }

  // 2. Look up client phone
  const { data: client } = await supabase
    .from('clients')
    .select('phone')
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)
    .single()

  if (!client?.phone) {
    return { success: false, error: 'Client has no phone number' }
  }

  // 3. Insert outbound message row with pending delivery status
  const { data: outboundMsg, error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id: action.conversationId,
      workspace_id: action.workspaceId,
      direction: 'outbound',
      content: messageContent,
      sender_type: 'system',
      delivery_status: 'pending',
    })
    .select('id')
    .single()

  if (msgError) return { success: false, error: msgError.message }
  const msgId = outboundMsg.id as string

  // 4. Dispatch to Baileys server
  const baileysUrl = Deno.env.get('BAILEYS_SERVER_URL')
  const baileysSecret = Deno.env.get('BAILEYS_API_SECRET')

  if (!baileysUrl) {
    await supabase.from('messages').update({ delivery_status: 'failed' }).eq('id', msgId)
    return { success: false, error: 'BAILEYS_SERVER_URL not configured' }
  }

  try {
    const resp = await fetch(`${baileysUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(baileysSecret ? { 'x-api-secret': baileysSecret } : {}),
      },
      body: JSON.stringify({
        workspaceId: action.workspaceId,
        to: client.phone,
        content: messageContent,
      }),
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      console.error('[action_executor] Baileys dispatch failed:', resp.status, body)
      await supabase.from('messages').update({ delivery_status: 'failed' }).eq('id', msgId)
      return { success: false, error: `Baileys dispatch failed (${resp.status})` }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('[action_executor] Baileys network error:', errMsg)
    await supabase.from('messages').update({ delivery_status: 'failed' }).eq('id', msgId)
    return { success: false, error: `Baileys dispatch failed: ${errMsg}` }
  }

  // 5. Mark as sent and update conversation
  await supabase.from('messages').update({ delivery_status: 'sent' }).eq('id', msgId)

  // Cancel stale_conversation timer — proactive message counts as engagement
  if (action.conversationId) {
    await bestEffortCancelTimer(
      action.conversationId,
      'stale_conversation',
      'proactive_message_sent'
    )
  }

  return {
    success: true,
    metadata: { to: client.phone, messageId: msgId },
  }
}

async function executeNoteCreate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const { error } = await supabase.from('notes').insert({
    workspace_id: action.workspaceId,
    client_id: action.clientId,
    content: action.payload.content,
    source: 'ai_extracted',
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}

async function executeTagAttach(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  // Tags are stored as a text[] on the clients table.
  // Read-modify-write pattern: fetch current tags, append if not present.
  const { data: client, error: fetchError } = await supabase
    .from('clients')
    .select('tags')
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)
    .single()

  if (fetchError) return { success: false, error: fetchError.message }

  const currentTags: string[] = client?.tags ?? []
  const newTag = action.payload.tag as string
  if (currentTags.includes(newTag)) {
    return { success: true, metadata: { note: 'Tag already exists' } }
  }

  const { error } = await supabase
    .from('clients')
    .update({ tags: [...currentTags, newTag] })
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

async function executeLastContactedUpdate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const { error } = await supabase
    .from('clients')
    .update({ last_contacted_at: new Date().toISOString() })
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Build a message from morning-scan metadata when no draft or explicit
 * messageContent exists. Covers appointment reminders and follow-up nudges.
 */
function buildScanMessage(payload: Record<string, unknown>): string | undefined {
  const scanType = payload.scan_type as string | undefined
  const clientName = (payload.client_name as string) || 'there'

  if (scanType === 'appointment_reminder') {
    const appointmentType = payload.appointment_type as string
    const startTime = payload.start_time as string
    if (!appointmentType || !startTime) return undefined
    const time = new Date(startTime).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
    return `Hi ${clientName}, this is a friendly reminder about your ${appointmentType} appointment tomorrow at ${time}. Please let us know if you need to make any changes.`
  }

  if (scanType === 'follow_up_candidate' || scanType === 'booking_confirmation_check') {
    return `Hi ${clientName}, just checking in — is there anything we can help you with?`
  }

  return undefined
}
