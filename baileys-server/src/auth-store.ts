import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SignalDataSet,
  type SignalKeyStore,
  BufferJSON,
  initAuthCreds,
} from '@whiskeysockets/baileys'
import { logger } from './logger.js'

/**
 * Supabase-backed auth state for Baileys.
 *
 * Stores all auth credentials and signal keys in the `baileys_auth` table
 * keyed by (workspace_id, key). This allows the server to restart without
 * losing the WhatsApp session.
 *
 * ┌─────────────────┐     ┌──────────────────────┐
 * │  Baileys Socket  │────▶│  baileys_auth table   │
 * │  (per workspace) │◀────│  PK(workspace_id,key) │
 * └─────────────────┘     └──────────────────────┘
 */
export async function useSupabaseAuthState(
  workspaceId: string,
  supabase: SupabaseClient
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  // Load all auth keys for this workspace into an in-memory cache
  const { data: rows, error: loadError } = await supabase
    .from('baileys_auth')
    .select('key, value')
    .eq('workspace_id', workspaceId)

  if (loadError) {
    logger.error({ workspaceId, error: loadError }, 'Failed to load auth state')
    throw loadError
  }

  const cache = new Map<string, unknown>()
  for (const row of rows ?? []) {
    cache.set(
      row.key as string,
      JSON.parse(JSON.stringify(row.value), BufferJSON.reviver) as unknown
    )
  }

  const creds: AuthenticationCreds =
    (cache.get('creds') as AuthenticationCreds | undefined) ?? initAuthCreds()

  const saveCreds = async (): Promise<void> => {
    const serialized: unknown = JSON.parse(
      JSON.stringify(creds, BufferJSON.replacer)
    )
    const { error } = await supabase.from('baileys_auth').upsert({
      workspace_id: workspaceId,
      key: 'creds',
      value: serialized,
    })
    if (error) {
      logger.error({ workspaceId, error }, 'Failed to save creds')
    }
  }

  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[]
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
      const result: Record<string, SignalDataTypeMap[T]> = {}

      // Separate cache hits from misses
      const missingKeys: string[] = []
      const missingIds: string[] = []

      for (const id of ids) {
        const cacheKey = `${type}-${id}`
        const cached = cache.get(cacheKey) as SignalDataTypeMap[T] | undefined
        if (cached !== undefined) {
          result[id] = cached
        } else {
          missingKeys.push(cacheKey)
          missingIds.push(id)
        }
      }

      // Batch fetch all cache misses in a single query
      if (missingKeys.length > 0) {
        const { data } = await supabase
          .from('baileys_auth')
          .select('key, value')
          .eq('workspace_id', workspaceId)
          .in('key', missingKeys)

        if (data) {
          for (const row of data) {
            const value = JSON.parse(
              JSON.stringify(row.value),
              BufferJSON.reviver
            ) as SignalDataTypeMap[T]
            cache.set(row.key as string, value)
            // Extract the id from the key (format: "type-id")
            const id = (row.key as string).slice(type.length + 1)
            result[id] = value
          }
        }
      }

      return result
    },

    set: async (data: SignalDataSet): Promise<void> => {
      const upserts: Array<{ workspace_id: string; key: string; value: unknown }> = []
      const deletes: string[] = []

      for (const [type, entries] of Object.entries(data)) {
        if (!entries) continue

        for (const [id, value] of Object.entries(entries)) {
          const cacheKey = `${type}-${id}`

          if (value) {
            const serialized: unknown = JSON.parse(
              JSON.stringify(value, BufferJSON.replacer)
            )
            cache.set(cacheKey, value)
            upserts.push({ workspace_id: workspaceId, key: cacheKey, value: serialized })
          } else {
            cache.delete(cacheKey)
            deletes.push(cacheKey)
          }
        }
      }

      if (upserts.length > 0) {
        const { error } = await supabase.from('baileys_auth').upsert(upserts)
        if (error) {
          logger.error({ workspaceId, error }, 'Failed to upsert auth keys')
        }
      }

      if (deletes.length > 0) {
        const { error } = await supabase
          .from('baileys_auth')
          .delete()
          .eq('workspace_id', workspaceId)
          .in('key', deletes)
        if (error) {
          logger.error({ workspaceId, error }, 'Failed to delete auth keys')
        }
      }
    },
  }

  return { state: { creds, keys }, saveCreds }
}
