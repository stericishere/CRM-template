'use server'

import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { recordDraftEditSignal, determineStaffAction } from '@/lib/learning/record-signal'
import { bestEffortStartTimer } from '@/lib/proactive/timer-helpers'

// ─── Shared Helper ──────────────────────────────────────────────────────────

interface DraftWithClient {
  draft: {
    id: string
    content: string
    intent_classified: string | null
    scenario_type: string | null
    conversation_id: string
    workspace_id: string
  }
  clientId: string
  clientPhone: string | null
}

async function fetchDraftWithClient(
  supabase: SupabaseClient,
  draftId: string
): Promise<{ data: DraftWithClient | null; error?: string }> {
  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .select('id, content, intent_classified, scenario_type, conversation_id, workspace_id')
    .eq('id', draftId)
    .single()

  if (draftError || !draft) return { data: null, error: 'Draft not found' }

  const { data: conv } = await supabase
    .from('conversations')
    .select('client_id, clients(phone)')
    .eq('id', draft.conversation_id)
    .single()

  if (!conv) return { data: null, error: 'Conversation not found' }

  return {
    data: {
      draft,
      clientId: conv.client_id,
      clientPhone: (conv.clients as unknown as { phone: string })?.phone ?? null,
    },
  }
}

// ─── Send Draft ─────────────────────────────────────────────────────────────

export async function sendDraftReply(
  draftId: string,
  finalText: string,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const serviceClient = getServiceClient()

  const { data, error } = await fetchDraftWithClient(supabase, draftId)
  if (!data) return { success: false, error: error ?? 'Draft not found' }

  const { draft, clientId, clientPhone } = data
  const workspaceId = draft.workspace_id
  const conversationId = draft.conversation_id

  // 1. INSERT outbound message
  const { error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      workspace_id: workspaceId,
      direction: 'outbound',
      content: finalText.trim(),
      sender_type: 'staff',
      delivery_status: 'sent',
      draft_id: draftId,
    })

  if (msgError) return { success: false, error: msgError.message }

  // 2. Record learning signal (non-blocking, fire-and-forget)
  const staffAction = determineStaffAction(draft.content, finalText)
  void recordDraftEditSignal(serviceClient, {
    workspaceId,
    clientId,
    draftId,
    staffAction,
    originalDraft: draft.content,
    finalVersion: finalText.trim(),
    intentClassified: draft.intent_classified ?? 'unclassified',
    scenarioType: draft.scenario_type ?? 'unclassified',
  }).catch(() => {})

  // 3. UPDATE draft status
  await supabase
    .from('drafts')
    .update({
      staff_action: staffAction,
      reviewed_at: new Date().toISOString(),
      reviewed_by: staffId,
      edited_content: staffAction === 'edited_and_sent' ? finalText.trim() : null,
    })
    .eq('id', draftId)

  // 4. POST to Baileys server: /send (authenticated)
  // If dispatch fails, return error — staff must know the message wasn't sent.
  // The outbound message row exists locally but delivery_status should reflect failure.
  const baileysUrl = process.env.BAILEYS_SERVER_URL
  const baileysSecret = process.env.BAILEYS_API_SECRET

  if (baileysUrl && clientPhone) {
    try {
      const resp = await fetch(`${baileysUrl}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(baileysSecret ? { 'x-api-secret': baileysSecret } : {}),
        },
        body: JSON.stringify({
          workspaceId,
          to: clientPhone,
          content: finalText.trim(),
        }),
      })

      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        console.error('[send] Baileys dispatch failed:', resp.status, body)

        // Mark message as failed so staff can see it wasn't delivered
        await supabase
          .from('messages')
          .update({ delivery_status: 'failed' })
          .eq('draft_id', draftId)
          .eq('direction', 'outbound')

        return { success: false, error: `WhatsApp dispatch failed (${resp.status})` }
      }
    } catch (err) {
      console.error('[send] Failed to dispatch via Baileys:', err)

      await supabase
        .from('messages')
        .update({ delivery_status: 'failed' })
        .eq('draft_id', draftId)
        .eq('direction', 'outbound')

      return { success: false, error: 'WhatsApp dispatch failed (network error)' }
    }
  }

  // 5. Update conversation state (only on successful send)
  await supabase
    .from('conversations')
    .update({ state: 'awaiting_client_reply' })
    .eq('id', conversationId)

  // 6. Start stale_conversation timer (24h) — fire-and-forget
  //    If the client doesn't reply within 24h, the timer scanner will
  //    transition the conversation to follow_up_pending.
  await bestEffortStartTimer(
    workspaceId,
    'stale_conversation',
    'conversation',
    conversationId,
    24 * 60 * 60 * 1000 // 24 hours
  )

  return { success: true }
}

// ─── Discard Draft ──────────────────────────────────────────────────────────

export async function discardDraft(
  draftId: string,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const serviceClient = getServiceClient()

  const { data, error } = await fetchDraftWithClient(supabase, draftId)
  if (!data) return { success: false, error: error ?? 'Draft not found' }

  const { draft, clientId } = data

  void recordDraftEditSignal(serviceClient, {
    workspaceId: draft.workspace_id,
    clientId,
    draftId,
    staffAction: 'discarded',
    originalDraft: draft.content,
    finalVersion: null,
    intentClassified: draft.intent_classified ?? 'unclassified',
    scenarioType: draft.scenario_type ?? 'unclassified',
  }).catch(() => {})

  await supabase
    .from('drafts')
    .update({
      staff_action: 'discarded',
      reviewed_at: new Date().toISOString(),
      reviewed_by: staffId,
    })
    .eq('id', draftId)

  return { success: true }
}

// ─── Regenerate Draft ───────────────────────────────────────────────────────

export async function regenerateDraft(
  draftId: string,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const serviceClient = getServiceClient()

  const { data, error } = await fetchDraftWithClient(supabase, draftId)
  if (!data) return { success: false, error: error ?? 'Draft not found' }

  const { draft, clientId } = data

  // 1. Signal for superseded draft
  void recordDraftEditSignal(serviceClient, {
    workspaceId: draft.workspace_id,
    clientId,
    draftId,
    staffAction: 'regenerated',
    originalDraft: draft.content,
    finalVersion: null,
    intentClassified: draft.intent_classified ?? 'unclassified',
    scenarioType: draft.scenario_type ?? 'unclassified',
  }).catch(() => {})

  // 2. Update superseded draft
  await supabase
    .from('drafts')
    .update({
      staff_action: 'regenerated',
      reviewed_at: new Date().toISOString(),
      reviewed_by: staffId,
    })
    .eq('id', draftId)

  // 3. Re-enqueue to pgmq for new LLM call
  const { data: latestMsg } = await supabase
    .from('messages')
    .select('id, content, media_type, wamid')
    .eq('conversation_id', draft.conversation_id)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (latestMsg) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient.rpc as any)('pgmq_send', {
      queue_name: 'inbound_messages',
      msg: {
        message_id: latestMsg.id,
        workspace_id: draft.workspace_id,
        client_id: clientId,
        conversation_id: draft.conversation_id,
        phone: '',
        content: latestMsg.content,
        media_type: latestMsg.media_type,
        wamid: latestMsg.wamid,
      },
    })
  }

  return { success: true }
}
