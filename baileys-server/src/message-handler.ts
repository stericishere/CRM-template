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
 */

/** PostgreSQL unique constraint violation code */
const PG_UNIQUE_VIOLATION = '23505'

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
 * Determine if a message is historical (imported during sync) vs live.
 * Historical messages have timestamps significantly in the past.
 */
function isHistorical(msg: WAMessage): boolean {
  const ts = msg.messageTimestamp
  if (!ts) return false
  const seconds = typeof ts === 'number' ? ts : Number(ts)
  // If message is older than 60 seconds, it's historical
  const ageSeconds = Math.floor(Date.now() / 1000) - seconds
  return ageSeconds > 60
}

/**
 * Process a WhatsApp message (live or historical):
 * 1. Dedup by wamid
 * 2. Find or create client (reopen if soft-deleted)
 * 3. Find or create conversation
 * 4. Save message (with original WhatsApp timestamp)
 * 5. Enqueue to pgmq for async processing (live inbound only)
 */
export async function handleInboundMessage(
  workspaceId: string,
  msg: WAMessage
): Promise<void> {
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
  const historical = isHistorical(msg)
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
    // Use ignoreDuplicates: true to avoid overwriting existing fields.
    // Then fetch separately to handle soft-deleted clients.
    const { error: upsertError } = await supabase
      .from('clients')
      .upsert(
        { workspace_id: workspaceId, phone, lifecycle_status: 'open' },
        { onConflict: 'workspace_id,phone', ignoreDuplicates: true }
      )

    if (upsertError && upsertError.code !== PG_UNIQUE_VIOLATION) throw upsertError

    // Fetch the client (may be soft-deleted)
    const { data: client, error: fetchErr } = await supabase
      .from('clients')
      .select('id, lifecycle_status, deleted_at')
      .eq('workspace_id', workspaceId)
      .eq('phone', phone)
      .single()

    if (fetchErr) throw fetchErr

    // Reopen soft-deleted client
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
    } else if (client.lifecycle_status === 'inactive' && !historical) {
      // Reactivate inactive client on live messages only
      await supabase
        .from('clients')
        .update({ lifecycle_status: 'open', last_contacted_at: msgTimestamp })
        .eq('id', client.id as string)
    } else if (!historical) {
      // Update last_contacted_at for live messages only
      await supabase
        .from('clients')
        .update({ last_contacted_at: msgTimestamp })
        .eq('id', client.id as string)
    }

    // Step 3: Find or create conversation by client_id (unique)
    // Use ignoreDuplicates to avoid overwriting existing conversation state
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

    // Fetch conversation
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
    // Historical inbound messages are marked as read to avoid flooding the unread badge
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
        is_read: isFromMe || historical, // outbound + historical = already read
        created_at: msgTimestamp,
      })
      .select('id')
      .single()

    if (msgError) throw msgError

    // Step 5: Enqueue to pgmq for async processing (live inbound only)
    // Historical messages and outbound messages don't need LLM processing
    if (direction === 'inbound' && !historical) {
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
      { workspaceId, wamid, direction, historical, clientId: client.id, msgId: savedMsg.id },
      'Message processed'
    )
  } catch (err) {
    logger.error({ workspaceId, wamid, error: err }, 'Failed to process inbound message')
  }
}
