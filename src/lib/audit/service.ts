import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditEvent } from './types'

/**
 * Insert an audit event into the audit_events table.
 *
 * Fire-and-log pattern: failures are caught and logged,
 * NEVER propagated to the caller. On write failure the event
 * is enqueued to the pgmq `audit_retry` queue (best-effort).
 *
 * ┌─────────┐   ok   ┌──────────────┐
 * │ caller  │───────▶│ audit_events │
 * └─────────┘        └──────────────┘
 *      │  fail
 *      ▼
 * ┌─────────────────┐   fail   ┌───────────┐
 * │ pgmq:audit_retry│────────▶│ log + drop│
 * └─────────────────┘         └───────────┘
 */
export async function logAuditEvent(
  supabase: SupabaseClient,
  event: AuditEvent
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_events').insert(event)
    if (error) throw error
  } catch (err) {
    console.error('[audit_write_failed]', {
      error: err instanceof Error ? err.message : String(err),
      workspace_id: event.workspace_id,
      action_type: event.action_type,
      target_type: event.target_type,
      target_id: event.target_id,
    })

    // Enqueue for retry via pgmq (best-effort)
    try {
      await supabase.rpc('pgmq_send', {
        queue_name: 'audit_retry',
        msg: { event, attempt: 1 },
      })
    } catch (retryErr) {
      console.error('[audit_retry_enqueue_failed]', {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      })
    }
  }
}
