// Instagram public profile scraper for onboarding
// Fetches bio, business category, and recent post captions from public profiles
// Falls back gracefully when profile is private, unavailable, or rate-limited
//
// ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
// │ Clean handle │────>│ Try JSON API │────>│ Return data  │
// └─────────────┘     └──────┬───────┘     └──────────────┘
//                            │ fail
//                     ┌──────▼───────┐     ┌──────────────┐
//                     │ Try HTML page │────>│ Parse meta + │
//                     │   fallback   │     │   ld+json    │
//                     └──────┬───────┘     └──────────────┘
//                            │ fail
//                     ┌──────▼───────┐
//                     │ Return error │
//                     │  gracefully  │
//                     └──────────────┘

export interface InstagramProfile {
  handle: string
  bio: string | null
  business_category: string | null
  post_captions: string[]
  scraped_at: string
  is_private: boolean
}

export interface ScrapeResult {
  success: boolean
  profile: InstagramProfile | null
  error?: string
}

const FETCH_TIMEOUT_MS = 10_000

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
}

// ---------------------------------------------------------------------------
// Handle cleaning
// ---------------------------------------------------------------------------

function cleanHandle(raw: string): string {
  let h = raw.trim()
  // Strip @ prefix
  if (h.startsWith('@')) h = h.slice(1)
  // Strip full URL variations
  // e.g. https://www.instagram.com/handle/ or http://instagram.com/handle
  const urlMatch = h.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/i)
  if (urlMatch) h = urlMatch[1]
  // Remove trailing slashes or query params
  h = h.split('/')[0].split('?')[0]
  return h.toLowerCase()
}

function isValidHandle(handle: string): boolean {
  // Instagram handles: 1-30 chars, letters, numbers, periods, underscores
  return /^[a-z0-9._]{1,30}$/.test(handle)
}

// ---------------------------------------------------------------------------
// Fetch with timeout + abort
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      headers: COMMON_HEADERS,
      signal: controller.signal,
      redirect: 'follow',
    })
    return resp
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: JSON API endpoint  (?__a=1&__d=dis)
// ---------------------------------------------------------------------------

interface JsonApiUser {
  biography?: string
  category_name?: string
  is_private?: boolean
  edge_owner_to_timeline_media?: {
    edges?: Array<{
      node?: {
        edge_media_to_caption?: {
          edges?: Array<{ node?: { text?: string } }>
        }
      }
    }>
  }
}

function extractCaptionsFromJsonUser(user: JsonApiUser, limit: number): string[] {
  const captions: string[] = []
  const edges = user.edge_owner_to_timeline_media?.edges ?? []
  for (const edge of edges) {
    if (captions.length >= limit) break
    const captionEdges = edge.node?.edge_media_to_caption?.edges ?? []
    const text = captionEdges[0]?.node?.text
    if (text && text.trim().length > 0) {
      captions.push(text.trim())
    }
  }
  return captions
}

async function tryJsonEndpoint(handle: string): Promise<InstagramProfile | null> {
  const url = `https://www.instagram.com/${handle}/?__a=1&__d=dis`
  const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS)

  if (!resp.ok) return null

  const contentType = resp.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
    // Instagram returned HTML (login wall) — not JSON
    return null
  }

  // deno-lint-ignore no-explicit-any
  let json: any
  try {
    json = await resp.json()
  } catch {
    return null
  }

  // Navigate to the user object — structure varies but common path is:
  // { graphql: { user: { ... } } }  or  { data: { user: { ... } } }
  const user: JsonApiUser | undefined =
    json?.graphql?.user ??
    json?.data?.user ??
    json?.user ??
    undefined

  if (!user) return null

  return {
    handle,
    bio: user.biography?.trim() ?? null,
    business_category: user.category_name?.trim() ?? null,
    post_captions: extractCaptionsFromJsonUser(user, 12),
    scraped_at: new Date().toISOString(),
    is_private: user.is_private ?? false,
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: HTML page parsing (meta tags + ld+json)
// ---------------------------------------------------------------------------

/**
 * Extract content from an HTML meta tag.
 * Handles both `content="..."` and `content='...'` attribute formats.
 * Uses a name or property attribute to identify the tag.
 */
function extractMetaContent(html: string, attr: string, value: string): string | null {
  // Match: <meta property="og:description" content="..." />
  // The attribute order can vary, so try both orderings.
  const patterns = [
    new RegExp(
      `<meta[^>]+${attr}=["']${escapeRegex(value)}["'][^>]+content=["']([^"']*?)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*?)["'][^>]+${attr}=["']${escapeRegex(value)}["']`,
      'i',
    ),
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return decodeHtmlEntities(match[1])
  }
  return null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'")
}

/**
 * Parse all <script type="application/ld+json"> blocks from HTML.
 * Returns an array of parsed JSON objects (skips any that fail to parse).
 */
// deno-lint-ignore no-explicit-any
function extractLdJson(html: string): any[] {
  const results: unknown[] = []
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    try {
      results.push(JSON.parse(match[1]))
    } catch {
      // Malformed ld+json — skip
    }
  }
  return results
}

/**
 * Extract bio from og:description meta tag.
 * Instagram og:description format is typically:
 *   "123 Followers, 45 Following, 67 Posts - See Instagram photos and videos from Name (@handle)"
 * or sometimes includes the bio text.
 */
function parseBioFromOgDescription(ogDesc: string | null): string | null {
  if (!ogDesc) return null
  // If it contains the generic "See Instagram photos and videos" pattern,
  // there is no bio in the meta tag — return null
  const genericPattern = /See Instagram photos and videos/i
  // Some profiles have: "Bio text. 123 Followers..."
  // Try to extract the part before the follower count
  const beforeFollowers = ogDesc.match(/^(.*?)\s*\d[\d,.]*\s*Followers/i)
  if (beforeFollowers?.[1]?.trim()) {
    const bio = beforeFollowers[1].trim()
    // Filter out cases where it is just the name
    if (bio.length > 3) return bio
  }
  // If the whole string does NOT look like the generic template, return it as bio
  if (!genericPattern.test(ogDesc)) {
    return ogDesc.trim() || null
  }
  return null
}

/**
 * Extract bio and business category from ld+json structured data.
 * Instagram sometimes embeds Person or Organization schema.
 */
// deno-lint-ignore no-explicit-any
function parseProfileFromLdJson(blocks: any[]): {
  bio: string | null
  business_category: string | null
  is_private: boolean
} {
  for (const block of blocks) {
    const items = Array.isArray(block) ? block : [block]
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const type = item['@type']
      if (type === 'Person' || type === 'Organization' || type === 'ProfilePage') {
        const mainEntity = item.mainEntity ?? item
        return {
          bio: (mainEntity.description ?? item.description ?? '').trim() || null,
          business_category: (mainEntity.genre ?? item.genre ?? '').trim() || null,
          is_private: false,
        }
      }
    }
  }
  return { bio: null, business_category: null, is_private: false }
}

/**
 * Extract post captions from ld+json data (if present).
 * Some ld+json embeds include an "image" array with caption info,
 * or an "interactionStatistic" block. This is less reliable than
 * the JSON endpoint but worth trying.
 */
// deno-lint-ignore no-explicit-any
function extractCaptionsFromLdJson(blocks: any[], limit: number): string[] {
  const captions: string[] = []
  for (const block of blocks) {
    const items = Array.isArray(block) ? block : [block]
    for (const item of items) {
      if (captions.length >= limit) return captions
      if (!item || typeof item !== 'object') continue
      // Some schemas embed posts as "hasPart" or within mainEntity
      const parts = item.hasPart ?? item.mainEntity?.hasPart ?? []
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (captions.length >= limit) return captions
          const caption = part?.caption ?? part?.description ?? part?.name
          if (typeof caption === 'string' && caption.trim().length > 0) {
            captions.push(caption.trim())
          }
        }
      }
    }
  }
  return captions
}

/**
 * Detect whether the page indicates a private profile.
 * Instagram shows "This Account is Private" text on private profiles.
 */
function detectPrivateProfile(html: string): boolean {
  return /This account is private/i.test(html) ||
    /is_private["']?\s*:\s*true/i.test(html)
}

async function tryHtmlFallback(handle: string): Promise<InstagramProfile | null> {
  const url = `https://www.instagram.com/${handle}/`
  const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS)

  if (resp.status === 404) return null
  if (!resp.ok) return null

  const html = await resp.text()

  // Detect login wall — if the page has no profile-related meta tags,
  // Instagram likely redirected to a login page
  const hasProfileSignal =
    html.includes(`instagram.com/${handle}`) ||
    html.includes('og:description') ||
    html.includes('application/ld+json')

  if (!hasProfileSignal) return null

  const isPrivate = detectPrivateProfile(html)
  const ogDescription = extractMetaContent(html, 'property', 'og:description')
  const ogTitle = extractMetaContent(html, 'property', 'og:title')
  const ldJsonBlocks = extractLdJson(html)
  const ldJsonProfile = parseProfileFromLdJson(ldJsonBlocks)

  // Prefer ld+json bio over og:description parsing
  const bio = ldJsonProfile.bio ?? parseBioFromOgDescription(ogDescription)
  const businessCategory = ldJsonProfile.business_category ??
    extractMetaContent(html, 'property', 'og:type') ??
    null

  // Captions from ld+json (best effort — usually only available for public profiles)
  const postCaptions = extractCaptionsFromLdJson(ldJsonBlocks, 12)

  // If we got literally nothing useful, check if it looks like a real profile page
  // (og:title often has the profile name)
  const hasAnyData = bio || businessCategory || postCaptions.length > 0 || ogTitle || isPrivate
  if (!hasAnyData) return null

  return {
    handle,
    bio,
    business_category: businessCategory !== 'profile' ? businessCategory : null,
    post_captions: isPrivate ? [] : postCaptions,
    scraped_at: new Date().toISOString(),
    is_private: isPrivate || ldJsonProfile.is_private,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape a public Instagram profile for onboarding data.
 *
 * Strategy:
 *  1. Fetch https://www.instagram.com/{handle}/?__a=1&__d=dis (JSON endpoint)
 *  2. If blocked, try fetching the HTML page and parsing meta tags / ld+json
 *  3. If private or unavailable, return partial data with is_private=true
 *
 * This is best-effort — Instagram aggressively blocks scraping.
 * The onboarding flow should work even if scraping fails entirely.
 */
export async function scrapeInstagramProfile(handle: string): Promise<ScrapeResult> {
  // 1. Clean and validate the handle
  const cleaned = cleanHandle(handle)
  if (!cleaned || !isValidHandle(cleaned)) {
    return {
      success: false,
      profile: null,
      error: `Invalid Instagram handle: "${handle}"`,
    }
  }

  // 2. Try JSON API endpoint
  try {
    const jsonProfile = await tryJsonEndpoint(cleaned)
    if (jsonProfile) {
      return { success: true, profile: jsonProfile }
    }
  } catch (err) {
    // JSON endpoint failed (timeout, network error, etc.) — fall through to HTML
    console.warn(`[instagram-scraper] JSON endpoint failed for @${cleaned}:`, err)
  }

  // 3. Fall back to HTML page parsing
  try {
    const htmlProfile = await tryHtmlFallback(cleaned)
    if (htmlProfile) {
      return { success: true, profile: htmlProfile }
    }
  } catch (err) {
    // HTML fallback also failed
    console.warn(`[instagram-scraper] HTML fallback failed for @${cleaned}:`, err)

    // Distinguish abort (timeout) from other errors
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        success: false,
        profile: null,
        error: `Timeout scraping @${cleaned} (exceeded ${FETCH_TIMEOUT_MS}ms)`,
      }
    }

    return {
      success: false,
      profile: null,
      error: `Network error scraping @${cleaned}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // 4. Both strategies returned null — profile not found or fully blocked
  return {
    success: false,
    profile: null,
    error: `Could not retrieve profile data for @${cleaned}. Profile may not exist or Instagram blocked the request.`,
  }
}
