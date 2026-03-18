import { createClient } from '@/lib/supabase/server'
import type { Client, ClientPatch, ClientProfile, ListClientsOptions, LifecycleStatus } from './types'

// ──────────────────────────────────────────────────────────
// findOrCreate
// Uses upsert with the UNIQUE(workspace_id, phone) constraint.
// Returns the existing row if the phone already belongs to
// the workspace, or inserts a new one.
// ──────────────────────────────────────────────────────────
export async function findOrCreate(
  workspaceId: string,
  phone: string,
  defaults?: { full_name?: string; email?: string }
): Promise<Client> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('clients')
    .upsert(
      {
        workspace_id: workspaceId,
        phone,
        ...(defaults?.full_name != null ? { full_name: defaults.full_name } : {}),
        ...(defaults?.email != null ? { email: defaults.email } : {}),
      },
      { onConflict: 'workspace_id,phone', ignoreDuplicates: true }
    )
    .select('*')
    .single()

  if (error) {
    // ignoreDuplicates returns no rows when a conflict is hit,
    // so fall back to a direct select.
    if (error.code === 'PGRST116') {
      const { data: existing, error: fetchError } = await supabase
        .from('clients')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('phone', phone)
        .is('deleted_at', null)
        .single()

      if (fetchError) throw new Error(`findOrCreate fetch failed: ${fetchError.message}`)
      return existing as Client
    }
    throw new Error(`findOrCreate upsert failed: ${error.message}`)
  }

  return data as Client
}

// ──────────────────────────────────────────────────────────
// getById
// ──────────────────────────────────────────────────────────
export async function getById(
  workspaceId: string,
  clientId: string
): Promise<Client | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', clientId)
    .is('deleted_at', null)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`getById failed: ${error.message}`)
  }

  return data as Client
}

// ──────────────────────────────────────────────────────────
// getProfile — lightweight projection
// ──────────────────────────────────────────────────────────
export async function getProfile(
  workspaceId: string,
  clientId: string
): Promise<ClientProfile | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('clients')
    .select('id, full_name, phone, lifecycle_status, tags, preferences')
    .eq('workspace_id', workspaceId)
    .eq('id', clientId)
    .is('deleted_at', null)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`getProfile failed: ${error.message}`)
  }

  return data as ClientProfile
}

// ──────────────────────────────────────────────────────────
// list — paginated, filterable, searchable
//
//   page  : 1-based (default 1)
//   limit : rows per page (default 20, max 100)
//   search: ilike on full_name OR phone
//   lifecycle_status: exact match
// ──────────────────────────────────────────────────────────
export async function list(
  workspaceId: string,
  options: ListClientsOptions = {}
): Promise<{ data: Client[]; total: number }> {
  const supabase = await createClient()

  const page = Math.max(options.page ?? 1, 1)
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const from = (page - 1) * limit
  const to = from + limit - 1

  let query = supabase
    .from('clients')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)

  if (options.lifecycle_status) {
    query = query.eq('lifecycle_status', options.lifecycle_status)
  }

  if (options.search) {
    const term = `%${options.search}%`
    query = query.or(`full_name.ilike.${term},phone.ilike.${term}`)
  }

  query = query.order('created_at', { ascending: false }).range(from, to)

  const { data, error, count } = await query

  if (error) throw new Error(`list failed: ${error.message}`)

  return { data: (data ?? []) as Client[], total: count ?? 0 }
}

// ──────────────────────────────────────────────────────────
// patch — partial update
// ──────────────────────────────────────────────────────────
export async function patch(
  workspaceId: string,
  clientId: string,
  fields: ClientPatch
): Promise<Client | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('clients')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('id', clientId)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`patch failed: ${error.message}`)
  }

  return data as Client
}

// ──────────────────────────────────────────────────────────
// updateLifecycleStatus
// ──────────────────────────────────────────────────────────
export async function updateLifecycleStatus(
  workspaceId: string,
  clientId: string,
  status: LifecycleStatus
): Promise<Client | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('clients')
    .update({ lifecycle_status: status, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('id', clientId)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`updateLifecycleStatus failed: ${error.message}`)
  }

  return data as Client
}

// ──────────────────────────────────────────────────────────
// mergePreferences
// Read-merge-write in JS — acceptable for single-operator MVP.
// ──────────────────────────────────────────────────────────
export async function mergePreferences(
  workspaceId: string,
  clientId: string,
  incoming: Record<string, unknown>
): Promise<Client | null> {
  const supabase = await createClient()

  // Step 1: read current preferences
  const { data: current, error: readError } = await supabase
    .from('clients')
    .select('preferences')
    .eq('workspace_id', workspaceId)
    .eq('id', clientId)
    .is('deleted_at', null)
    .single()

  if (readError) {
    if (readError.code === 'PGRST116') return null
    throw new Error(`mergePreferences read failed: ${readError.message}`)
  }

  const merged = {
    ...((current?.preferences as Record<string, unknown>) ?? {}),
    ...incoming,
  }

  // Step 2: write merged preferences
  const { data, error: writeError } = await supabase
    .from('clients')
    .update({ preferences: merged, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('id', clientId)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (writeError) throw new Error(`mergePreferences write failed: ${writeError.message}`)

  return data as Client
}

// ──────────────────────────────────────────────────────────
// softDelete
// ──────────────────────────────────────────────────────────
export async function softDelete(
  workspaceId: string,
  clientId: string
): Promise<Client | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('clients')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('id', clientId)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`softDelete failed: ${error.message}`)
  }

  return data as Client
}
