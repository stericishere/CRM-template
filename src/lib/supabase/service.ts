import { createClient } from '@supabase/supabase-js'

let _serviceClient: ReturnType<typeof createClient> | null = null

/**
 * Get a Supabase client using the service role key.
 * Bypasses RLS — use only in Server Actions for system-level writes.
 *
 * WARNING: Never expose this client to the browser.
 */
export function getServiceClient() {
  if (_serviceClient) return _serviceClient

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  _serviceClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  return _serviceClient
}
