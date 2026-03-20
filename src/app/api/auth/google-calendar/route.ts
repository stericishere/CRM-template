import { NextResponse } from 'next/server'
import { createHmac, randomBytes } from 'crypto'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

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
// null when Google OAuth is not configured — lets the system detect this state
// and prompt the user to set up or reconnect Google Calendar.
// Prefer an explicit secret; fall back to a key derived from GOOGLE_CLIENT_SECRET
// so existing deployments work without a new env var. Derived key is stable across
// serverless cold starts (sign and verify may run in different invocations).
const OAUTH_STATE_SECRET: string | null =
  process.env.OAUTH_STATE_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  (process.env.GOOGLE_CLIENT_SECRET
    ? createHmac('sha256', process.env.GOOGLE_CLIENT_SECRET).update('oauth-state-key').digest('hex')
    : null)

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ')

/** Sign OAuth state payload with HMAC to prevent CSRF / workspace_id tampering */
export function signOAuthState(payload: Record<string, unknown>): string | null {
  if (!OAUTH_STATE_SECRET) return null
  const nonce = randomBytes(16).toString('hex')
  const data = JSON.stringify({ ...payload, nonce })
  const signature = createHmac('sha256', OAUTH_STATE_SECRET).update(data).digest('hex')
  return Buffer.from(JSON.stringify({ data, signature })).toString('base64url')
}

/** Verify and decode a signed OAuth state. Returns null if not configured or tampered. */
export function verifyOAuthState(stateParam: string): Record<string, unknown> | null {
  if (!OAUTH_STATE_SECRET) return null
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
    if (!GOOGLE_CLIENT_ID || !OAUTH_STATE_SECRET) {
      return NextResponse.json(
        {
          error: 'Google Calendar is not configured',
          code: 'google_calendar_not_configured',
          message: 'Please set up your Google Calendar credentials in Settings to connect.',
        },
        { status: 422 }
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

    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

    // OAUTH_STATE_SECRET is guaranteed non-null by the guard above
    const state = signOAuthState({ workspace_id: workspaceId })!

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
