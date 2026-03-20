import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { verifyOAuthState } from '../route'

// ──────────────────────────────────────────────────────────
// GET /api/auth/google-calendar/callback
//
// OAuth callback — exchanges authorization code for tokens,
// saves encrypted config to workspace.calendar_config.
//
//  Google ──302──> this route ──> exchange code ──> save tokens
// ──────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ??
  `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/google-calendar/callback`
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
}

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl
    const code = url.searchParams.get('code')
    const stateParam = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    // Handle OAuth errors (user denied, etc.)
    if (error) {
      console.error('[GET /auth/google-calendar/callback] OAuth error:', error)
      return NextResponse.redirect(
        `${APP_URL}/settings?calendar_error=${encodeURIComponent(error)}`
      )
    }

    if (!code || !stateParam) {
      return NextResponse.redirect(
        `${APP_URL}/settings?calendar_error=missing_params`
      )
    }

    // Verify HMAC-signed state to prevent CSRF / workspace_id tampering
    const state = verifyOAuthState(stateParam)
    if (!state || !state.workspace_id) {
      console.error('[GET /auth/google-calendar/callback] Invalid or tampered OAuth state')
      return NextResponse.redirect(
        `${APP_URL}/settings?calendar_error=invalid_state`
      )
    }
    const workspaceId = state.workspace_id as string

    // Exchange authorization code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text().catch(() => 'Unknown error')
      console.error('[GET /auth/google-calendar/callback] Token exchange failed:', errText)
      return NextResponse.redirect(
        `${APP_URL}/settings?calendar_error=token_exchange_failed`
      )
    }

    const tokens = (await tokenResponse.json()) as GoogleTokenResponse

    // Save calendar config to workspace
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const calendarConfig = {
      provider: 'google',
      calendarId: 'primary',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      status: 'connected',
    }

    const { error: updateError } = await supabase
      .from('workspaces')
      .update({ calendar_config: calendarConfig })
      .eq('id', workspaceId)

    if (updateError) {
      console.error('[GET /auth/google-calendar/callback] DB update failed:', updateError.message)
      return NextResponse.redirect(
        `${APP_URL}/settings?calendar_error=save_failed`
      )
    }

    return NextResponse.redirect(`${APP_URL}/settings?calendar_connected=true`)
  } catch (err) {
    console.error('[GET /auth/google-calendar/callback]', err)
    return NextResponse.redirect(
      `${APP_URL}/settings?calendar_error=internal_error`
    )
  }
}
