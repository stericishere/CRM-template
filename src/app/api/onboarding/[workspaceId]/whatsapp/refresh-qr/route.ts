import { NextRequest, NextResponse } from 'next/server'

// ──────────────────────────────────────────────────────────
// POST /api/onboarding/:workspaceId/whatsapp/refresh-qr
//
// Requests a fresh QR code by telling Baileys to (re)init
// the session. The new QR will appear on the SSE stream.
// ──────────────────────────────────────────────────────────

const BAILEYS_URL = process.env.BAILEYS_SERVER_URL ?? 'http://localhost:3001'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    const response = await fetch(`${BAILEYS_URL}/sessions/${workspaceId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error')
      console.error('[refresh-qr] Baileys init failed:', response.status, text)
      return NextResponse.json(
        { error: 'Failed to refresh QR code' },
        { status: 502 }
      )
    }

    return NextResponse.json({ status: 'qr_requested' })
  } catch (err) {
    console.error('[refresh-qr]', err)
    return NextResponse.json(
      { error: 'WhatsApp service unavailable' },
      { status: 502 }
    )
  }
}
