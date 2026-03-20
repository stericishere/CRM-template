import { NextRequest, NextResponse } from 'next/server'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

// ──────────────────────────────────────────────────────────
// GET /api/onboarding/:workspaceId/whatsapp/events
//
// SSE stream proxying QR code events from the Baileys server.
// The client opens this as an EventSource — receives QR codes
// and connection status updates.
//
//  Browser                API (SSE proxy)           Baileys
//  ──────  EventSource ──> GET /events  ──────────> GET /sessions/:id/events
//                          <── SSE: qr_code ──────
//                          <── SSE: connected ─────
// ──────────────────────────────────────────────────────────

const BAILEYS_URL = process.env.BAILEYS_SERVER_URL ?? 'http://localhost:3001'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params
  const auth = await assertWorkspaceMember(workspaceId)
  if (auth instanceof NextResponse) return auth

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      try {
        // Proxy SSE from Baileys server
        const baileysUrl = `${BAILEYS_URL}/sessions/${workspaceId}/events`
        const response = await fetch(baileysUrl, {
          headers: { Accept: 'text/event-stream' },
          signal: AbortSignal.timeout(300_000), // 5 min timeout
        })

        if (!response.ok || !response.body) {
          sendEvent('error', { message: 'Failed to connect to WhatsApp service' })
          controller.close()
          return
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            // Forward raw SSE data from Baileys
            controller.enqueue(value)
          }
        } catch (readErr) {
          // Stream interrupted — normal during disconnect
          console.log('[whatsapp/events] Stream ended:', readErr)
        } finally {
          reader.releaseLock()
        }
      } catch (err) {
        console.error('[whatsapp/events] Proxy error:', err)
        sendEvent('error', { message: 'WhatsApp service unavailable' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
