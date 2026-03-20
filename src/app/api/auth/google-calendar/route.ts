import { NextResponse } from 'next/server'
import { createHmac, randomBytes } from 'crypto'

// ──────────────────────────────────────────────────────────
// GET /api/auth/google-calendar
//
// Redirects the user to Google OAuth consent screen.
// Scopes: calendar.readonly, calendar.events
//
//  Browser ──GET──> this route ──302──> accounts.google.com
// ──────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ??
  `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/google-calendar/callback`
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET ?? process.env.NEXTAUTH_SECRET ?? ''

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ')

/** Sign OAuth state payload with HMAC to prevent CSRF / workspace_id tampering */
export function signOAuthState(payload: Record<string, unknown>): string {
  const nonce = randomBytes(16).toString('hex')
  const data = JSON.stringify({ ...payload, nonce })
  const signature = createHmac('sha256', OAUTH_STATE_SECRET).update(data).digest('hex')
  return Buffer.from(JSON.stringify({ data, signature })).toString('base64url')
}

/** Verify and decode a signed OAuth state. Returns null if tampered. */
export function verifyOAuthState(stateParam: string): Record<string, unknown> | null {
  try {
    const { data, signature } = JSON.parse(Buffer.from(stateParam, 'base64url').toString())
    const expected = createHmac('sha256', OAUTH_STATE_SECRET).update(data).digest('hex')
    if (signature !== expected) return null
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  try {
    if (!GOOGLE_CLIENT_ID) {
      return NextResponse.json(
        { error: 'Google OAuth not configured' },
        { status: 500 }
      )
    }

    // Extract workspace_id from query param so we can round-trip it through OAuth state
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get('workspace_id')

    if (!workspaceId) {
      return NextResponse.json(
        { error: 'workspace_id query param is required' },
        { status: 400 }
      )
    }

    const state = signOAuthState({ workspace_id: workspaceId })

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID)
    authUrl.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', SCOPES)
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    authUrl.searchParams.set('state', state)

    return NextResponse.redirect(authUrl.toString())
  } catch (err) {
    console.error('[GET /auth/google-calendar]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
