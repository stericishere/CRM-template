import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { useSupabaseAuthState } from './auth-store.js'
import { supabase } from './supabase.js'
import { logger } from './logger.js'

/**
 * Per-workspace Baileys socket lifecycle manager.
 *
 * ┌───────────┐    ┌────────────────┐    ┌───────────────┐
 * │  HTTP API  │───▶│ socket-manager │───▶│ Baileys Socket│
 * └───────────┘    │ (Map<ws_id,ws>)│    │  (WhatsApp WS)│
 *                  └────────────────┘    └───────────────┘
 *
 * Responsibilities:
 * 1. One Baileys socket per workspace
 * 2. Connection events (open, close, QR code, creds update)
 * 3. Auto-reconnect with exponential backoff on disconnect
 * 4. Route incoming messages to the message handler
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'qr_pending' | 'connected'

interface WorkspaceSocket {
  socket: WASocket | null
  status: ConnectionStatus
  qrCode: string | null
  reconnectAttempts: number
  onMessage: (msg: WAMessage) => void
  onQr?: (qr: string) => void
  /** Timer handle for reconnect — used for cleanup on manual disconnect */
  reconnectTimer?: ReturnType<typeof setTimeout>
}

const sockets = new Map<string, WorkspaceSocket>()

const MAX_RECONNECT_DELAY_MS = 60_000

export function getSocketStatus(workspaceId: string): {
  status: ConnectionStatus
  qrCode: string | null
} {
  const ws = sockets.get(workspaceId)
  return { status: ws?.status ?? 'disconnected', qrCode: ws?.qrCode ?? null }
}

export function getSocket(workspaceId: string): WASocket | null {
  return sockets.get(workspaceId)?.socket ?? null
}

export async function connectWorkspace(
  workspaceId: string,
  onMessage: (msg: WAMessage) => void
): Promise<void> {
  const existing = sockets.get(workspaceId)
  if (existing?.status === 'connected') {
    logger.info({ workspaceId }, 'Already connected')
    return
  }

  const { state, saveCreds } = await useSupabaseAuthState(workspaceId, supabase)

  const ws: WorkspaceSocket = {
    socket: null,
    status: 'connecting',
    qrCode: null,
    reconnectAttempts: 0,
    onMessage,
  }
  sockets.set(workspaceId, ws)

  const startSocket = async (): Promise<void> => {
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      auth: state,
      syncFullHistory: true,
      // Desktop browser config = receive MORE message history on first sync
      browser: Browsers.macOS('Desktop'),
      // Baileys logger expects a pino-like interface; cast to satisfy the type
      logger: logger.child({ module: 'baileys', workspaceId }) as unknown as Parameters<typeof makeWASocket>[0]['logger'],
    })

    ws.socket = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        ws.qrCode = qr
        ws.status = 'qr_pending'
        ws.onQr?.(qr)
        logger.info({ workspaceId }, 'QR code generated')
      }

      if (connection === 'open') {
        ws.status = 'connected'
        ws.qrCode = null
        ws.reconnectAttempts = 0
        logger.info({ workspaceId }, 'WhatsApp connected')
      }

      if (connection === 'close') {
        ws.status = 'disconnected'

        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode
            : undefined

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        if (shouldReconnect) {
          ws.reconnectAttempts++
          const delay = Math.min(
            1000 * Math.pow(2, ws.reconnectAttempts),
            MAX_RECONNECT_DELAY_MS
          )
          logger.info(
            { workspaceId, delay, attempt: ws.reconnectAttempts },
            'Reconnecting...'
          )
          ws.reconnectTimer = setTimeout(() => {
            void startSocket()
          }, delay)
        } else {
          logger.warn({ workspaceId }, 'Logged out — clearing auth state')
          void supabase
            .from('baileys_auth')
            .delete()
            .eq('workspace_id', workspaceId)
            .then(({ error }) => {
              if (error) {
                logger.error({ workspaceId, error }, 'Failed to clear auth state')
              }
            })
          sockets.delete(workspaceId)
        }
      }
    })

    sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
      if (type !== 'notify') return
      for (const msg of msgs) {
        if (!msg.key.fromMe && msg.message) {
          ws.onMessage(msg as WAMessage)
        }
      }
    })

    // ─── History Sync (fires on FIRST pairing only) ───────────────
    // Baileys delivers contacts, chats, and messages in batches.
    // We process all of them to build the full client database.

    // Contacts → create client records with names
    sock.ev.on('contacts.upsert', (contacts) => {
      logger.info({ workspaceId, count: contacts.length }, 'History: contacts.upsert received')
      for (const contact of contacts) {
        const jid = contact.id
        if (!jid || jid.includes('@g.us') || jid.includes('@broadcast') || jid.includes('@lid')) continue
        const phone = jid.split('@')[0]
        if (!phone) continue

        // Upsert client with contact name.
        // Format: "Name-+phone" when name known, NULL when unknown.
        const e164 = `+${phone}`
        const rawName = contact.name ?? contact.notify ?? null
        const contactName = rawName ? `${rawName}-${e164}` : null
        void (async () => {
          const { error: insertErr } = await supabase
            .from('clients')
            .upsert(
              { workspace_id: workspaceId, phone: e164, full_name: contactName, lifecycle_status: 'open' },
              { onConflict: 'workspace_id,phone', ignoreDuplicates: true }
            )
          if (insertErr && insertErr.code !== '23505') {
            logger.error({ workspaceId, phone: e164, error: insertErr }, 'Failed to insert contact')
          }
          // Update name on existing client only if we have a name
          if (contactName) {
            await supabase
              .from('clients')
              .update({ full_name: contactName })
              .eq('workspace_id', workspaceId)
              .eq('phone', e164)
          }
        })()
      }
    })

    // Chats → create conversations for each chat
    sock.ev.on('chats.upsert', (chats) => {
      logger.info({ workspaceId, count: chats.length }, 'History: chats.upsert received')
      // Chats are processed indirectly — when messages arrive, they create conversations.
      // Log for observability.
      for (const chat of chats) {
        logger.debug({
          workspaceId,
          chatId: chat.id,
          name: chat.name,
          unreadCount: chat.unreadCount,
          lastMsgTimestamp: chat.conversationTimestamp,
        }, 'History chat')
      }
    })

    // Messages → the main payload. Both inbound and outbound.
    // HISTORY_SYNC_CUTOFF_DAYS controls how far back to sync (default: 90 days, 0 = no limit)
    const cutoffDays = parseInt(process.env['HISTORY_SYNC_CUTOFF_DAYS'] ?? '45', 10)
    const cutoffTs = cutoffDays > 0 ? Math.floor(Date.now() / 1000) - (cutoffDays * 86400) : 0

    sock.ev.on('messaging-history.set', ({ messages: historyMsgs, isLatest }) => {
      logger.info(
        { workspaceId, count: historyMsgs.length, isLatest, cutoffDays },
        'History: messaging-history.set received'
      )
      let processed = 0
      let skippedOld = 0
      for (const msg of historyMsgs) {
        if (!msg.message) continue
        if (!msg.key.remoteJid) continue
        // Skip group, broadcast, and LID messages
        if (msg.key.remoteJid.includes('@g.us')) continue
        if (msg.key.remoteJid.includes('@broadcast')) continue
        if (msg.key.remoteJid.includes('@lid')) continue

        // Skip messages older than cutoff date
        const msgTs = typeof msg.messageTimestamp === 'number'
          ? msg.messageTimestamp
          : Number(msg.messageTimestamp ?? 0)
        if (cutoffTs > 0 && msgTs > 0 && msgTs < cutoffTs) {
          skippedOld++
          continue
        }

        ws.onMessage(msg as WAMessage)
        processed++
      }
      logger.info(
        { workspaceId, processed, skippedOld, total: historyMsgs.length, isLatest },
        'History: batch processing complete'
      )
    })
  }

  await startSocket()
}

export async function disconnectWorkspace(workspaceId: string): Promise<void> {
  const ws = sockets.get(workspaceId)
  if (!ws) return

  // Clear any pending reconnect timer
  if (ws.reconnectTimer) {
    clearTimeout(ws.reconnectTimer)
  }

  if (ws.socket) {
    ws.socket.end(undefined)
  }

  sockets.delete(workspaceId)
  logger.info({ workspaceId }, 'Disconnected')
}

export function setQrCallback(
  workspaceId: string,
  callback: (qr: string) => void
): void {
  const ws = sockets.get(workspaceId)
  if (ws) {
    ws.onQr = callback
    // If QR already available, fire immediately
    if (ws.qrCode) callback(ws.qrCode)
  }
}

export function getAllStatuses(): Record<string, ConnectionStatus> {
  const result: Record<string, ConnectionStatus> = {}
  for (const [id, ws] of sockets) {
    result[id] = ws.status
  }
  return result
}
