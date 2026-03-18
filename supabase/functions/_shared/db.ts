// Supabase client for Edge Functions
// Uses Deno environment variables

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

let _client: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client

  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables')
  }

  _client = createClient(url, key)
  return _client
}

// For use in Edge Functions that need to act as the authenticated user
export function getSupabaseClientWithAuth(authHeader: string): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')

  if (!url || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables')
  }

  return createClient(url, anonKey, {
    global: {
      headers: { Authorization: authHeader },
    },
  })
}
