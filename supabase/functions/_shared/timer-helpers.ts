// supabase/functions/_shared/timer-helpers.ts
// Edge Function timer helpers (fire-and-forget pattern)
//
// Both functions wrap try-catch, log errors but never throw.
// Safety net: the timer handler re-checks state before acting.

import type { TimerType } from './proactive-types.ts'
import { getSupabaseClient } from './db.ts'

/**
 * Start (or reset) a timer. Fire-and-forget: logs errors but never throws.
 *
 * Uses the create_or_reset_timer RPC which handles upsert semantics:
 * if a pending timer already exists for the same (target_id, timer_type),
 * it resets the trigger_at rather than creating a duplicate.
 */
export async function bestEffortStartTimer(
  workspaceId: string,
  timerType: TimerType,
  targetEntity: string,
  targetId: string,
  durationMs: number,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = getSupabaseClient()
    await supabase.rpc('create_or_reset_timer', {
      p_workspace_id: workspaceId,
      p_timer_type: timerType,
      p_target_entity: targetEntity,
      p_target_id: targetId,
      p_trigger_at: new Date(Date.now() + durationMs).toISOString(),
      p_payload: payload ?? null,
    })
  } catch (err) {
    console.error(`[timer] Failed to start ${timerType} for ${targetId}:`, err)
  }
}

/**
 * Cancel a pending timer. Fire-and-forget: logs errors but never throws.
 *
 * Uses the cancel_timer RPC which updates status='cancelled' and records
 * the cancel_reason. No-op if no pending timer exists (idempotent).
 */
export async function bestEffortCancelTimer(
  targetId: string,
  timerType: TimerType,
  reason: string
): Promise<void> {
  try {
    const supabase = getSupabaseClient()
    await supabase.rpc('cancel_timer', {
      p_target_id: targetId,
      p_timer_type: timerType,
      p_reason: reason,
    })
  } catch (err) {
    console.error(`[timer] Failed to cancel ${timerType} for ${targetId}:`, err)
  }
}
