// Shared helper for invoking Supabase Edge Functions from API routes
// Eliminates duplicated SUPABASE_URL/ANON_KEY declarations and fetch boilerplate

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

export interface EdgeFunctionResult<T = unknown> {
  ok: boolean
  status: number
  data: T | null
  error: string | null
}

/**
 * Invoke a Supabase Edge Function by name.
 * Handles auth headers, timeout, and error parsing.
 */
export async function invokeEdgeFunction<T = unknown>(
  functionName: string,
  body: Record<string, unknown>,
  timeoutMs = 60_000
): Promise<EdgeFunctionResult<T>> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error')
    return { ok: false, status: response.status, data: null, error: errText }
  }

  const data = (await response.json()) as T
  return { ok: true, status: response.status, data, error: null }
}
