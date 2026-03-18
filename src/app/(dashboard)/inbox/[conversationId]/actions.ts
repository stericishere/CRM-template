'use server'

import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { recordDraftEditSignal, determineStaffAction } from '@/lib/learning/record-signal'

// ─── Send Draft ─────────────────────────────────────────────────────────────

export async function sendDraftReply(
  draftId: string,
  finalText: string,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const serviceClient = getServiceClient()

  // 1. Fetch draft record
  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .select('id, content, intent_classified, scenario_type, conversation_id, workspace_id')
    .eq('id', draftId)
    .single()

  if (draftError || !draft) {
    return { success: false, error: 'Draft not found' }
  }

  const workspaceId = draft.workspace_id
  const conversationId = draft.conversation_id

  const { data: conv } = await supabase
    .from('conversations')
    .select('client_id')
    .eq('id', conversationId)
    .single()

  if (!conv) return { success: false, error: 'Conversation not found' }
  const clientId = conv.client_id

  // 2. INSERT outbound message
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

  // 3. Record learning signal (non-blocking, fire-and-forget)
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

  // 4. UPDATE draft status
  await supabase
    .from('drafts')
    .update({
      staff_action: staffAction,
      reviewed_at: new Date().toISOString(),
      reviewed_by: staffId,
      edited_content: staffAction === 'edited_and_sent' ? finalText.trim() : null,
    })
    .eq('id', draftId)

  // 5. POST to Baileys server: /send
  try {
    const baileysUrl = process.env.BAILEYS_SERVER_URL
    if (baileysUrl) {
      const { data: client } = await supabase
        .from('clients')
        .select('phone')
        .eq('id', clientId)
        .single()

      if (client) {
        await fetch(`${baileysUrl}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            to: client.phone,
            content: finalText.trim(),
          }),
        })
      }
    }
  } catch (err) {
    console.error('[send] Failed to dispatch via Baileys:', err)
  }

  // 6. Update conversation state
  await supabase
    .from('conversations')
    .update({ state: 'awaiting_client_reply' })
    .eq('id', conversationId)

  return { success: true }
}

// ─── Discard Draft ──────────────────────────────────────────────────────────

export async function discardDraft(
  draftId: string,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const serviceClient = getServiceClient()

  const { data: draft } = await supabase
    .from('drafts')
    .select('id, content, intent_classified, scenario_type, conversation_id, workspace_id')
    .eq('id', draftId)
    .single()

  if (!draft) return { success: false, error: 'Draft not found' }

  const { data: conv } = await supabase
    .from('conversations')
    .select('client_id')
    .eq('id', draft.conversation_id)
    .single()

  if (!conv) return { success: false, error: 'Conversation not found' }

  void recordDraftEditSignal(serviceClient, {
    workspaceId: draft.workspace_id,
    clientId: conv.client_id,
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

  const { data: draft } = await supabase
    .from('drafts')
    .select('id, content, intent_classified, scenario_type, conversation_id, workspace_id')
    .eq('id', draftId)
    .single()

  if (!draft) return { success: false, error: 'Draft not found' }

  const { data: conv } = await supabase
    .from('conversations')
    .select('client_id')
    .eq('id', draft.conversation_id)
    .single()

  if (!conv) return { success: false, error: 'Conversation not found' }

  // 1. Signal for superseded draft
  void recordDraftEditSignal(serviceClient, {
    workspaceId: draft.workspace_id,
    clientId: conv.client_id,
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
    await serviceClient.rpc('pgmq_send', {
      queue_name: 'inbound_messages',
      msg: {
        message_id: latestMsg.id,
        workspace_id: draft.workspace_id,
        client_id: conv.client_id,
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
