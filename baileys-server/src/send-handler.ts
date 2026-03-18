import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getSocket } from './socket-manager.js'
import { logger } from './logger.js'

export const sendRouter = Router()

const sendSchema = z.object({
  workspaceId: z.string().uuid(),
  to: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Must be E.164 format'),
  content: z.string().min(1).max(4096),
  mediaUrl: z.string().url().optional(),
})

/**
 * POST /send — Send a text message via the workspace's Baileys socket.
 *
 * Request body:
 * {
 *   workspaceId: string (UUID),
 *   to: string (E.164 phone, e.g. "+85291234567"),
 *   content: string,
 *   mediaUrl?: string (optional, for future media support)
 * }
 */
sendRouter.post('/send', async (req: Request, res: Response): Promise<void> => {
  const parsed = sendSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() })
    return
  }

  const { workspaceId, to, content } = parsed.data
  const socket = getSocket(workspaceId)

  if (!socket) {
    res.status(503).json({ error: 'WhatsApp not connected for this workspace' })
    return
  }

  // Convert E.164 to Baileys JID: strip '+' and append @s.whatsapp.net
  const jid = `${to.slice(1)}@s.whatsapp.net`

  try {
    const result = await socket.sendMessage(jid, { text: content })

    logger.info({ workspaceId, to, wamid: result?.key?.id }, 'Message sent')

    res.json({
      success: true,
      wamid: result?.key?.id ?? null,
    })
  } catch (err) {
    logger.error({ workspaceId, to, error: err }, 'Failed to send message')
    res.status(500).json({ error: 'Failed to send message' })
  }
})
