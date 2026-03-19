// Google Calendar API gateway with OAuth token management
// Used by booking system (F-07) to query busy intervals and manage events.
//
// ┌─────────────┐   refresh_token   ┌──────────────────┐
// │  Edge Func   │ ───────────────> │ Google OAuth2     │
// │  (Deno)      │ <─────────────── │ token endpoint    │
// └──────┬───────┘   new access_token└──────────────────┘
//        │
//        │  Bearer access_token
//        ▼
// ┌──────────────────┐
// │ Google Calendar   │
// │ API v3            │
// └──────────────────┘

const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CalendarConfig {
  accessToken: string
  refreshToken: string
  tokenExpiresAt: number       // Unix epoch ms
  calendarId: string
  clientId?: string            // Falls back to Deno.env GOOGLE_CLIENT_ID
  clientSecret?: string        // Falls back to Deno.env GOOGLE_CLIENT_SECRET
}

export interface CalendarEvent {
  summary: string
  description?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: Array<{ email: string; displayName?: string }>
}

export interface BusyInterval {
  start: string   // ISO 8601
  end: string     // ISO 8601
}

interface TokenRefreshResult {
  accessToken: string
  expiresAt: number
}

// ─── Token management ────────────────────────────────────────────────────────

/**
 * Refresh an expired Google OAuth2 access token.
 * Returns a new access token and its expiration timestamp.
 */
async function refreshAccessToken(config: CalendarConfig): Promise<TokenRefreshResult> {
  const clientId = config.clientId ?? Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = config.clientSecret ?? Deno.env.get('GOOGLE_CLIENT_SECRET')

  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET for token refresh')
  }

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Google token refresh failed (${response.status}): ${body}`)
  }

  const data = await response.json() as { access_token: string; expires_in: number }
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

/**
 * Ensure we have a valid access token. If the current token is expired
 * (or within a 60-second buffer), refresh it and mutate the config in-place.
 */
async function ensureValidToken(config: CalendarConfig): Promise<string> {
  const bufferMs = 60_000
  if (Date.now() + bufferMs < config.tokenExpiresAt) {
    return config.accessToken
  }

  console.log('[google-calendar] Access token expired, refreshing...')
  const refreshed = await refreshAccessToken(config)
  // Mutate in-place so callers can persist the updated token
  config.accessToken = refreshed.accessToken
  config.tokenExpiresAt = refreshed.expiresAt
  return refreshed.accessToken
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/**
 * Make an authenticated request to the Google Calendar API.
 * Automatically retries once on 401 by refreshing the access token.
 */
async function calendarFetch(
  config: CalendarConfig,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await ensureValidToken(config)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  }

  const url = `${GOOGLE_CALENDAR_API}${path}`
  let response = await fetch(url, { ...options, headers })

  // Retry once on 401 — token may have been revoked server-side
  if (response.status === 401) {
    console.log('[google-calendar] Got 401, forcing token refresh...')
    const refreshed = await refreshAccessToken(config)
    config.accessToken = refreshed.accessToken
    config.tokenExpiresAt = refreshed.expiresAt

    headers.Authorization = `Bearer ${refreshed.accessToken}`
    response = await fetch(url, { ...options, headers })
  }

  return response
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Query busy (free/busy) intervals for a calendar between timeMin and timeMax.
 * Uses the FreeBusy API for efficiency — no need to read full event details.
 */
export async function queryBusyIntervals(
  config: CalendarConfig,
  timeMin: string,
  timeMax: string,
): Promise<BusyInterval[]> {
  const token = await ensureValidToken(config)

  const response = await fetch(`${GOOGLE_CALENDAR_API}/freeBusy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: [{ id: config.calendarId }],
    }),
  })

  // FreeBusy endpoint: retry on 401
  if (response.status === 401) {
    const refreshed = await refreshAccessToken(config)
    config.accessToken = refreshed.accessToken
    config.tokenExpiresAt = refreshed.expiresAt

    const retryResponse = await fetch(`${GOOGLE_CALENDAR_API}/freeBusy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshed.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin,
        timeMax,
        items: [{ id: config.calendarId }],
      }),
    })

    if (!retryResponse.ok) {
      const body = await retryResponse.text()
      throw new Error(`Google FreeBusy query failed after retry (${retryResponse.status}): ${body}`)
    }

    const retryData = await retryResponse.json() as {
      calendars: Record<string, { busy: BusyInterval[] }>
    }
    return retryData.calendars[config.calendarId]?.busy ?? []
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Google FreeBusy query failed (${response.status}): ${body}`)
  }

  const data = await response.json() as {
    calendars: Record<string, { busy: BusyInterval[] }>
  }
  return data.calendars[config.calendarId]?.busy ?? []
}

/**
 * Create a calendar event. Returns the Google event ID.
 */
export async function createEvent(
  config: CalendarConfig,
  event: CalendarEvent,
): Promise<string> {
  const response = await calendarFetch(
    config,
    `/calendars/${encodeURIComponent(config.calendarId)}/events`,
    {
      method: 'POST',
      body: JSON.stringify(event),
    },
  )

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Google createEvent failed (${response.status}): ${body}`)
  }

  const data = await response.json() as { id: string }
  return data.id
}

/**
 * Update an existing calendar event.
 */
export async function updateEvent(
  config: CalendarConfig,
  eventId: string,
  event: Partial<CalendarEvent>,
): Promise<void> {
  const response = await calendarFetch(
    config,
    `/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(event),
    },
  )

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Google updateEvent failed (${response.status}): ${body}`)
  }
}

/**
 * Delete (cancel) a calendar event.
 */
export async function deleteEvent(
  config: CalendarConfig,
  eventId: string,
): Promise<void> {
  const response = await calendarFetch(
    config,
    `/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' },
  )

  // 410 Gone is acceptable — event was already deleted
  if (!response.ok && response.status !== 410) {
    const body = await response.text()
    throw new Error(`Google deleteEvent failed (${response.status}): ${body}`)
  }
}
