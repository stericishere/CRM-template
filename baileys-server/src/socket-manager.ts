import makeWASocket, {
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
