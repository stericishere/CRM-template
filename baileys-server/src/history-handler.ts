import { Router, type Request, type Response } from 'express'
import { getSocket, getSocketStatus } from './socket-manager.js'
import { handleInboundMessage } from './message-handler.js'
import { supabase } from './supabase.js'
import { logger } from './logger.js'

export const historyRouter = Router()

/**
 * POST /history/:workspaceId — Request message history sync from WhatsApp.
 * Baileys will emit 'messaging-history.set' events with past messages.
 * Query params: ?count=50 (number of recent messages to request)
 */
historyRouter.post('/history/:workspaceId', async (req: Request, res: Response): Promise<void> => {
  const rawParam = req.params['workspaceId']
  const workspaceId = Array.isArray(rawParam) ? rawParam[0] : rawParam
  if (!workspaceId) {
    res.status(400).json({ error: 'Missing workspaceId' })
    return
  }

  const socket = getSocket(workspaceId)
  if (!socket) {
    res.status(503).json({ error: 'WhatsApp not connected' })
    return
  }

  const count = parseInt(req.query['count'] as string) || 50

  try {
    // fetchMessageHistory triggers WhatsApp to send historical messages
    // They arrive via 'messaging-history.set' event (already wired in socket-manager)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sock = socket as any
    if (typeof sock.fetchMessageHistory === 'function') {
      await sock.fetchMessageHistory(count)
      logger.info({ workspaceId, count }, 'History sync requested')
      res.json({ success: true, requested: count })
    } else {
      res.status(501).json({ error: 'fetchMessageHistory not available on this Baileys version' })
    }
  } catch (err) {
    logger.error({ workspaceId, error: err }, 'Failed to request history')
    res.status(500).json({ error: 'History request failed' })
  }
})

/**
 * GET /chats/:workspaceId — List all conversations from the database
 */
historyRouter.get('/chats/:workspaceId', async (req: Request, res: Response): Promise<void> => {
  const rawParam = req.params['workspaceId']
  const workspaceId = Array.isArray(rawParam) ? rawParam[0] : rawParam
  if (!workspaceId) {
    res.status(400).json({ error: 'Missing workspaceId' })
    return
  }

  const { data: conversations, error } = await supabase
    .from('conversations')
    .select(`
      id,
      state,
      last_message_at,
      clients (id, phone, full_name, lifecycle_status)
    `)
    .eq('workspace_id', workspaceId)
    .order('last_message_at', { ascending: false })
    .limit(50)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ conversations: conversations ?? [] })
})

/**
 * GET /messages/:workspaceId/:conversationId — Get messages for a conversation
 */
historyRouter.get('/messages/:workspaceId/:conversationId', async (req: Request, res: Response): Promise<void> => {
  const rawWs = req.params['workspaceId']
  const rawConv = req.params['conversationId']
  const workspaceId = Array.isArray(rawWs) ? rawWs[0] : rawWs
  const conversationId = Array.isArray(rawConv) ? rawConv[0] : rawConv

  if (!workspaceId || !conversationId) {
    res.status(400).json({ error: 'Missing params' })
    return
  }

  const { data: messages, error } = await supabase
    .from('messages')
    .select('id, direction, content, media_type, sender_type, delivery_status, wamid, is_read, created_at')
    .eq('workspace_id', workspaceId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(200)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ messages: messages ?? [], count: messages?.length ?? 0 })
})

/**
 * GET /db-stats/:workspaceId — Quick overview of all tables
 */
historyRouter.get('/db-stats/:workspaceId', async (req: Request, res: Response): Promise<void> => {
  const rawParam = req.params['workspaceId']
  const workspaceId = Array.isArray(rawParam) ? rawParam[0] : rawParam
  if (!workspaceId) {
    res.status(400).json({ error: 'Missing workspaceId' })
    return
  }

  const [clients, conversations, messages, inbox, audit] = await Promise.all([
    supabase.from('clients').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    supabase.from('messages').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    supabase.from('message_inbox').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    supabase.from('audit_events').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
  ])

  res.json({
    workspace_id: workspaceId,
    clients: clients.count ?? 0,
    conversations: conversations.count ?? 0,
    messages: messages.count ?? 0,
    dedup_inbox: inbox.count ?? 0,
    audit_events: audit.count ?? 0,
  })
})
