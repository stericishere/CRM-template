import { Router, type Request, type Response } from 'express'
import { getSocketStatus, getAllStatuses } from './socket-manager.js'

export const healthRouter = Router()

/**
 * GET /health — Overall server health + all workspace connection statuses.
 */
healthRouter.get('/health', (_req: Request, res: Response): void => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: getAllStatuses(),
  })
})

/**
 * GET /status/:workspaceId — Connection status for a single workspace.
 */
healthRouter.get('/status/:workspaceId', (req: Request, res: Response): void => {
  const rawParam = req.params['workspaceId']
  const workspaceId = Array.isArray(rawParam) ? rawParam[0] : rawParam
  if (!workspaceId) {
    res.status(400).json({ error: 'Missing workspaceId' })
    return
  }

  const { status, qrCode } = getSocketStatus(workspaceId)
  res.json({ workspaceId, status, hasQr: !!qrCode })
})
