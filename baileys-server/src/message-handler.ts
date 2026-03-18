import type { WAMessage } from '@whiskeysockets/baileys'
import { supabase } from './supabase.js'
import { logger } from './logger.js'
import { jidToE164 } from './phone-utils.js'

/**
 * Inbound message processing pipeline.
 *
 * ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐
 * │ WhatsApp │──▶│  Dedup    │──▶│ Find/    │──▶│  Save    │──▶│ Enqueue │
 * │ message  │   │ (inbox)   │   │ Create   │   │ message  │   │ to pgmq │
 * └──────────┘   └───────────┘   │ client + │   └──────────┘   └─────────┘
 *                                │ convo    │
 *                                └──────────┘
 */

/** PostgreSQL unique constraint violation code */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * Extract text content and media type from a Baileys WAMessage.
 */
function extractMessageContent(msg: WAMessage): {
  text: string | null
  mediaType: string | null
} {
  const m = msg.message
  if (!m) return { text: null, mediaType: null }

  // Plain text
  if (m.conversation) return { text: m.conversation, mediaType: null }

  // Extended text (replies, links, etc.)
  if (m.extendedTextMessage?.text) {
    return { text: m.extendedTextMessage.text, mediaType: null }
  }

  // Media types
  if (m.imageMessage) {
    return { text: m.imageMessage.caption ?? null, mediaType: 'image' }
  }
  if (m.audioMessage) {
    return { text: null, mediaType: m.audioMessage.ptt ? 'voice_note' : 'audio' }
  }
  if (m.videoMessage) {
    return { text: m.videoMessage.caption ?? null, mediaType: 'video' }
  }
  if (m.documentMessage) {
    return { text: m.documentMessage.fileName ?? null, mediaType: 'document' }
  }
  if (m.stickerMessage) return { text: null, mediaType: 'sticker' }
  if (m.contactMessage) {
    return { text: m.contactMessage.displayName ?? null, mediaType: 'contact' }
  }
  if (m.locationMessage) return { text: null, mediaType: 'location' }

  return { text: null, mediaType: null }
}

/**
 * Process an inbound WhatsApp message:
 * 1. Dedup by wamid
 * 2. Find or create client
 * 3. Find or create conversation
 * 4. Save message
 * 5. Enqueue to pgmq for async processing
 */
export async function handleInboundMessage(
  workspaceId: string,
  msg: WAMessage
): Promise<void> {
  const wamid = msg.key.id
  const fromJid = msg.key.remoteJid

  if (!wamid || !fromJid) {
    logger.warn({ workspaceId }, 'Message missing id or remoteJid, skipping')
    return
  }

  // Skip group messages — only process 1:1 chats
  if (fromJid.includes('@g.us')) return

  const phone = jidToE164(fromJid)
  const { text, mediaType } = extractMessageContent(msg)

  // Skip if no content at all (e.g. protocol messages, reactions)
  if (!text && !mediaType) {
    logger.debug({ workspaceId, wamid }, 'Message has no extractable content, skipping')
    return
  }

  try {
    // Step 1: Dedup by wamid — INSERT into message_inbox ON CONFLICT DO NOTHING
    const { error: dedupError } = await supabase
      .from('message_inbox')
      .insert({ wamid, workspace_id: workspaceId })

    if (dedupError) {
      if (dedupError.code === PG_UNIQUE_VIOLATION) {
        logger.debug({ workspaceId, wamid }, 'Duplicate message, skipping')
        return
      }
      throw dedupError
    }

    // Step 2: Find or create client by (workspace_id, phone)
    // Use ignoreDuplicates: true to avoid overwriting existing lifecycle_status
    const { data: upsertedClient, error: upsertError } = await supabase
      .from('clients')
      .upsert(
        { workspace_id: workspaceId, phone, lifecycle_status: 'open' },
        { onConflict: 'workspace_id,phone', ignoreDuplicates: true }
      )
      .select('id, lifecycle_status')
      .maybeSingle()

    let client: { id: string; lifecycle_status: string }
    if (upsertError) throw upsertError

    if (upsertedClient) {
      client = { id: upsertedClient.id as string, lifecycle_status: upsertedClient.lifecycle_status as string }
    } else {
      // Client already exists (upsert was skipped due to UNIQUE constraint).
      // Fetch WITHOUT deleted_at filter — the row may be soft-deleted.
      const { data: existing, error: fetchErr } = await supabase
        .from('clients')
        .select('id, lifecycle_status, deleted_at')
        .eq('workspace_id', workspaceId)
        .eq('phone', phone)
        .single()
      if (fetchErr) throw fetchErr

      // Reopen soft-deleted client: a re-engaging archived client should be restored
      if (existing.deleted_at) {
        await supabase
          .from('clients')
          .update({ deleted_at: null, lifecycle_status: 'open', updated_at: new Date().toISOString() })
          .eq('id', existing.id as string)
        client = { id: existing.id as string, lifecycle_status: 'open' }
        logger.info({ workspaceId, clientId: existing.id, phone }, 'Reopened soft-deleted client')
      } else {
        client = { id: existing.id as string, lifecycle_status: existing.lifecycle_status as string }
      }
    }

    // Step 3: Update client + find/create conversation in parallel
    // (client update is fire-and-forget, conversation upsert is needed for Step 4)
    const now = new Date().toISOString()
    const clientUpdate =
      client.lifecycle_status === 'inactive'
        ? { lifecycle_status: 'open', last_contacted_at: now }
        : { last_contacted_at: now }

    const [, convResult] = await Promise.all([
      // Fire-and-forget: update client timestamps (don't block on result)
      supabase.from('clients').update(clientUpdate).eq('id', client.id),
      // Find or create conversation — don't overwrite existing state
      supabase
        .from('conversations')
        .upsert(
          {
            workspace_id: workspaceId,
            client_id: client.id,
            state: 'idle',
            last_message_at: now,
            last_client_message_at: now,
          },
          { onConflict: 'client_id', ignoreDuplicates: true }
        )
        .select('id')
        .maybeSingle(),
    ])

    let conversationId: string
    if (convResult.error) throw convResult.error
    if (convResult.data) {
      conversationId = convResult.data.id as string
      // Update timestamps on existing conversation
      await supabase
        .from('conversations')
        .update({ last_message_at: now, last_client_message_at: now })
        .eq('id', conversationId)
    } else {
      // Conversation already exists — fetch it and update timestamps
      const { data: existingConv, error: convFetchErr } = await supabase
        .from('conversations')
        .select('id')
        .eq('client_id', client.id)
        .single()
      if (convFetchErr) throw convFetchErr
      conversationId = existingConv.id as string
      await supabase
        .from('conversations')
        .update({ last_message_at: now, last_client_message_at: now })
        .eq('id', conversationId)
    }

    // Step 4: Save message (triggers Supabase Realtime for staff UI)
    const { data: savedMsg, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        workspace_id: workspaceId,
        direction: 'inbound',
        content: text,
        media_type: mediaType,
        sender_type: 'client',
        delivery_status: 'delivered',
        wamid,
        is_read: false,
      })
      .select('id')
      .single()

    if (msgError) throw msgError

    // Step 5: Enqueue to pgmq for async processing (context assembly + LLM)
    const { error: queueError } = await supabase.rpc('pgmq_send', {
      queue_name: 'inbound_messages',
      msg: {
        message_id: savedMsg.id as string,
        workspace_id: workspaceId,
        client_id: client.id as string,
        conversation_id: conversationId,
        phone,
        content: text,
        media_type: mediaType,
        wamid,
      },
    })

    if (queueError) {
      // Message is saved — just not queued. pg_cron safety net will pick it up.
      logger.error(
        { workspaceId, wamid, error: queueError },
        'Failed to enqueue message to pgmq'
      )
    }

    logger.info(
      { workspaceId, wamid, clientId: client.id, msgId: savedMsg.id },
      'Inbound message processed'
    )
  } catch (err) {
    logger.error({ workspaceId, wamid, error: err }, 'Failed to process inbound message')
  }
}
