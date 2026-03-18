import type { WAMessage } from '@whiskeysockets/baileys'
import { supabase } from './supabase.js'
import { logger } from './logger.js'

/**
 * Inbound message processing pipeline.
 *
 * ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐
 * │ WhatsApp │──▶│  Dedup    │──▶│ Find/    │──▶│  Save    │──▶│ Enqueue │
 * │ message  │   │ (inbox)   │   │ Create   │   │ message  │   │ to pgmq │
 * └──────────┘   └───────────┘   │ client + │   └──────────┘   └─────────┘
 *                                │ convo    │
 *                                └──────────┘
 *
 * source: 'live'    — from messages.upsert (real-time delivery)
 * source: 'history' — from messaging-history.set (initial sync)
 *
 * Business rules by source:
 *   live inbound    → is_read=false, enqueue to pgmq, reactivate client
 *   live outbound   → is_read=true,  no enqueue
 *   history inbound → is_read=true,  no enqueue, no reactivation
 *   history outbound→ is_read=true,  no enqueue
 */

/** PostgreSQL unique constraint violation code */
const PG_UNIQUE_VIOLATION = '23505'

export type MessageSource = 'live' | 'history'

export interface MessageContext {
  source: MessageSource
}

/**
 * Normalize a Baileys JID (e.g. "85291234567@s.whatsapp.net") to E.164 ("+85291234567").
 */
function normalizePhone(jid: string): string {
  const number = jid.split('@')[0]
  if (!number) throw new Error(`Invalid JID: ${jid}`)
  return `+${number}`
}

/**
 * Extract the original WhatsApp timestamp from a message.
 * Returns an ISO string. Falls back to now() if no timestamp available.
 */
function extractTimestamp(msg: WAMessage): string {
  const ts = msg.messageTimestamp
  if (!ts) return new Date().toISOString()
  const seconds = typeof ts === 'number' ? ts : Number(ts)
  if (seconds <= 0) return new Date().toISOString()
  return new Date(seconds * 1000).toISOString()
}

/**
 * Extract text content and media type from a Baileys WAMessage.
 */
function extractMessageContent(msg: WAMessage): {
  text: string | null
  mediaType: string | null
} {
  const m = msg.message
  if (!m) return { text: null, mediaType: null }

  if (m.conversation) return { text: m.conversation, mediaType: null }
  if (m.extendedTextMessage?.text) {
    return { text: m.extendedTextMessage.text, mediaType: null }
  }
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
 * Process a WhatsApp message (live or historical):
 * 1. Dedup by wamid
 * 2. Find or create client (reopen if soft-deleted)
 * 3. Find or create conversation
 * 4. Save message (with original WhatsApp timestamp)
 * 5. Enqueue to pgmq (live inbound only)
 */
export async function handleInboundMessage(
  workspaceId: string,
  msg: WAMessage,
  context: MessageContext
): Promise<void> {
  const { source } = context
  const wamid = msg.key.id
  const remoteJid = msg.key.remoteJid
  const isFromMe = msg.key.fromMe ?? false

  if (!wamid || !remoteJid) {
    logger.warn({ workspaceId }, 'Message missing id or remoteJid, skipping')
    return
  }

  // Skip group messages — only process 1:1 chats
  if (remoteJid.includes('@g.us')) return

  let phone: string
  try {
    phone = normalizePhone(remoteJid)
  } catch {
    logger.debug({ workspaceId, wamid, remoteJid }, 'Could not normalize phone, skipping')
    return
  }

  const direction = isFromMe ? 'outbound' : 'inbound'
  const senderType = isFromMe ? 'staff' : 'client'
  const msgTimestamp = extractTimestamp(msg)
  const { text, mediaType } = extractMessageContent(msg)

  // Skip if no content at all (e.g. protocol messages, reactions)
  if (!text && !mediaType) {
    logger.debug({ workspaceId, wamid }, 'Message has no extractable content, skipping')
    return
  }

  // Business rules based on source + direction
  const isLiveInbound = source === 'live' && direction === 'inbound'
  const shouldMarkUnread = isLiveInbound
  const shouldEnqueue = isLiveInbound
  const shouldReactivateClient = source === 'live'

  try {
    // Step 1: Dedup by wamid
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
    const { error: upsertError } = await supabase
      .from('clients')
      .upsert(
        { workspace_id: workspaceId, phone, lifecycle_status: 'open' },
        { onConflict: 'workspace_id,phone', ignoreDuplicates: true }
      )

    if (upsertError && upsertError.code !== PG_UNIQUE_VIOLATION) throw upsertError

    // Fetch client (may be soft-deleted)
    const { data: client, error: fetchErr } = await supabase
      .from('clients')
      .select('id, lifecycle_status, deleted_at')
      .eq('workspace_id', workspaceId)
      .eq('phone', phone)
      .single()

    if (fetchErr) throw fetchErr

    // Reopen soft-deleted client (always, regardless of source)
    if (client.deleted_at) {
      await supabase
        .from('clients')
        .update({
          deleted_at: null,
          lifecycle_status: 'open',
          last_contacted_at: msgTimestamp,
        })
        .eq('id', client.id as string)
      logger.info({ workspaceId, clientId: client.id, phone }, 'Reopened soft-deleted client')
    } else if (shouldReactivateClient) {
      // Live messages: reactivate inactive clients + update last_contacted_at
      const update = client.lifecycle_status === 'inactive'
        ? { lifecycle_status: 'open', last_contacted_at: msgTimestamp }
        : { last_contacted_at: msgTimestamp }
      await supabase.from('clients').update(update).eq('id', client.id as string)
    }
    // History messages: don't touch lifecycle or last_contacted_at

    // Step 3: Find or create conversation
    const { error: convUpsertErr } = await supabase
      .from('conversations')
      .upsert(
        {
          workspace_id: workspaceId,
          client_id: client.id as string,
          state: 'idle',
          last_message_at: msgTimestamp,
          last_client_message_at: direction === 'inbound' ? msgTimestamp : null,
        },
        { onConflict: 'client_id', ignoreDuplicates: true }
      )

    if (convUpsertErr && convUpsertErr.code !== PG_UNIQUE_VIOLATION) throw convUpsertErr

    const { data: conversation, error: convFetchErr } = await supabase
      .from('conversations')
      .select('id, last_message_at')
      .eq('client_id', client.id as string)
      .single()

    if (convFetchErr) throw convFetchErr

    // Update conversation timestamps only if this message is newer
    const existingLastMsg = conversation.last_message_at as string | null
    if (!existingLastMsg || msgTimestamp > existingLastMsg) {
      const convUpdate: Record<string, string> = { last_message_at: msgTimestamp }
      if (direction === 'inbound') {
        convUpdate['last_client_message_at'] = msgTimestamp
      }
      await supabase
        .from('conversations')
        .update(convUpdate)
        .eq('id', conversation.id as string)
    }

    // Step 4: Save message with original WhatsApp timestamp
    const { data: savedMsg, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id as string,
        workspace_id: workspaceId,
        direction,
        content: text,
        media_type: mediaType,
        sender_type: senderType,
        delivery_status: 'delivered',
        wamid,
        is_read: !shouldMarkUnread,
        created_at: msgTimestamp,
      })
      .select('id')
      .single()

    if (msgError) throw msgError

    // Step 5: Enqueue to pgmq (live inbound only)
    if (shouldEnqueue) {
      const { error: queueError } = await supabase.rpc('pgmq_send', {
        queue_name: 'inbound_messages',
        msg: {
          message_id: savedMsg.id as string,
          workspace_id: workspaceId,
          client_id: client.id,
          conversation_id: conversation.id as string,
          phone,
          content: text,
          media_type: mediaType,
          wamid,
        },
      })

      if (queueError) {
        logger.error(
          { workspaceId, wamid, error: queueError },
          'Failed to enqueue message to pgmq'
        )
      }
    }

    logger.info(
      { workspaceId, wamid, direction, source, clientId: client.id, msgId: savedMsg.id },
      'Message processed'
    )
  } catch (err) {
    logger.error({ workspaceId, wamid, error: err }, 'Failed to process inbound message')
  }
}
