import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import { config } from './config.js'
import { logger } from './logger.js'
import { healthRouter } from './health.js'
import { qrRouter } from './qr-handler.js'
import { sendRouter } from './send-handler.js'
import { connectWorkspace, disconnectWorkspace, getAllStatuses } from './socket-manager.js'
import { handleInboundMessage } from './message-handler.js'

const app = express()

app.use(cors())
app.use(express.json())

// API secret middleware — skip auth for /health (used by Railway health checks)
app.use((req: Request, res: Response, next: NextFunction): void => {
  if (req.path === '/health') {
    next()
    return
  }

  const secret = req.headers['x-api-secret']
  if (secret !== config.API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
})

// Routes
app.use(healthRouter)
app.use(qrRouter)
app.use(sendRouter)

// POST /reconnect/:workspaceId — Force reconnection for a workspace
app.post('/reconnect/:workspaceId', async (req: Request, res: Response): Promise<void> => {
  const rawParam = req.params['workspaceId']
  const workspaceId = Array.isArray(rawParam) ? rawParam[0] : rawParam
  if (!workspaceId) {
    res.status(400).json({ error: 'Missing workspaceId' })
    return
  }

  try {
    await connectWorkspace(workspaceId, (msg) => {
      void handleInboundMessage(workspaceId, msg)
    })
    res.json({ success: true })
  } catch (err) {
    logger.error({ workspaceId, err }, 'Reconnect failed')
    res.status(500).json({ error: 'Reconnect failed' })
  }
})

// Graceful shutdown — close all WebSocket connections before exiting
const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'Baileys server started')
})

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...')
  const statuses = getAllStatuses()
  const disconnects = Object.keys(statuses).map((wsId) => disconnectWorkspace(wsId))
  void Promise.allSettled(disconnects).then(() => {
    server.close(() => {
      logger.info('Server closed')
      process.exit(0)
    })
  })
})

export { app }
