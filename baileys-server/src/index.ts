import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import { logger } from './logger.js'

const app = express()

app.use(cors())
app.use(express.json())

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Placeholder routes (to be implemented)
app.get('/qr/:workspaceId', (_req, res) => {
  res.status(501).json({ error: 'Not implemented' })
})

app.post('/send', (_req, res) => {
  res.status(501).json({ error: 'Not implemented' })
})

app.get('/status/:workspaceId', (_req, res) => {
  res.status(501).json({ error: 'Not implemented' })
})

app.post('/reconnect/:workspaceId', (_req, res) => {
  res.status(501).json({ error: 'Not implemented' })
})

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'Baileys server started')
})

export { app }
