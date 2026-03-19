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
    // Use ignoreDuplicates: true so existing clients are NOT overwritten
    // (prevents resurrecting soft-deleted clients during history replay)
    const { error: upsertError } = await supabase
      .from('clients')
      .upsert(
        { workspace_id: workspaceId, phone, lifecycle_status: 'open' },
        { onConflict: 'workspace_id,phone', ignoreDuplicates: true }
      )

    if (upsertError) throw upsertError

    // Now select the client to check current state
    const { data: client, error: selectError } = await supabase
      .from('clients')
      .select('id, lifecycle_status, deleted_at')
      .eq('workspace_id', workspaceId)
      .eq('phone', phone)
      .single()

    if (selectError) throw selectError

    // Reactivate client if needed — this handler only runs for live
    // messages (type='notify' in socket-manager), so a message here is
    // genuine re-engagement, even from a previously archived client.
    const clientUpdate: Record<string, unknown> = {
      last_contacted_at: new Date().toISOString(),
    }

    if (client.deleted_at) {
      // Live message from a previously archived client — reactivate
      clientUpdate.deleted_at = null
      clientUpdate.lifecycle_status = 'open'
      logger.info({ workspaceId, phone }, 'Reactivating soft-deleted client on live message')
    } else if (client.lifecycle_status === 'inactive') {
      clientUpdate.lifecycle_status = 'open'
    }

    await supabase.from('clients').update(clientUpdate).eq('id', client.id as string)

    // Step 3: Find or create conversation by client_id (unique)
    const now = new Date().toISOString()
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .upsert(
        {
          workspace_id: workspaceId,
          client_id: client.id as string,
          state: 'idle',
          last_message_at: now,
          last_client_message_at: now,
        },
        { onConflict: 'client_id', ignoreDuplicates: false }
      )
      .select('id')
      .single()

    if (convError) throw convError

    // Step 4: Save message (triggers Supabase Realtime for staff UI)
    const { data: savedMsg, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id as string,
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
        conversation_id: conversation.id as string,
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
