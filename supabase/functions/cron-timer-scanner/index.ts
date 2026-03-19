// supabase/functions/cron-timer-scanner/index.ts
// Processes expired pending_timer rows in batches
//
// Triggered every 3 minutes by pg_cron via pg_net.
//
// Flow:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ 1. Query pending_timer WHERE status='pending'           │
//   │    AND trigger_at <= NOW()  LIMIT 50                    │
//   └──────────────┬───────────────────────────────────────────┘
//                  │
//                  v
//   ┌──────────────────────────────────────────────────────────┐
//   │ 2. Process in batches of 10 via Promise.allSettled()    │
//   └──────────────┬───────────────────────────────────────────┘
//                  │
//                  v  (per timer)
//   ┌──────────────────────────────────────────────────────────┐
//   │ 3. Optimistic lock: UPDATE status='fired'               │
//   │    (fails if another scanner instance grabbed it)       │
//   └──────────────┬───────────────────────────────────────────┘
//                  │
//                  v
//   ┌──────────────────────────────────────────────────────────┐
//   │ 4. Dispatch to handler by timer_type                    │
//   │    ├─ stale_conversation  → re-check state, transition  │
//   │    └─ draft_review_nudge  → re-check draft, notify      │
//   └──────────────┬───────────────────────────────────────────┘
//                  │
//                  v  (on error)
//   ┌──────────────────────────────────────────────────────────┐
//   │ 5. UPDATE status='error', error_details=...             │
//   └──────────────────────────────────────────────────────────┘

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { transitionConversation } from '../_shared/conversation-state.ts'
import type { PendingTimer } from '../_shared/proactive-types.ts'

const MAX_TIMERS = 50
const BATCH_SIZE = 10

serve(async (_req) => {
  const supabase = getSupabaseClient()
  const runStart = Date.now()

  try {
    // -----------------------------------------------------------------------
    // 1. Query expired timers
    // -----------------------------------------------------------------------
    const { data: expired, error: queryError } = await supabase
      .from('pending_timer')
      .select('*')
      .eq('status', 'pending')
      .lte('trigger_at', new Date().toISOString())
      .order('trigger_at', { ascending: true })
      .limit(MAX_TIMERS)

    if (queryError) {
      console.error('[timer-scanner] Query failed:', queryError.message)
      return new Response(
        JSON.stringify({ error: queryError.message }),
        { status: 500 }
      )
    }

    if (!expired || expired.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0 }),
        { status: 200 }
      )
    }

    console.log(`[timer-scanner] Found ${expired.length} expired timer(s)`)

    // -----------------------------------------------------------------------
    // 2. Process in batches of BATCH_SIZE via Promise.allSettled
    // -----------------------------------------------------------------------
    let fired = 0
    let errors = 0

    for (let i = 0; i < expired.length; i += BATCH_SIZE) {
      const batch = expired.slice(i, i + BATCH_SIZE) as PendingTimer[]
      const results = await Promise.allSettled(
        batch.map(timer => processTimer(supabase, timer))
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          switch (result.value) {
            case 'fired': fired++; break
            case 'error': errors++; break
            case 'skipped': break // lock lost to another scanner — not an error
          }
        } else {
          // Promise itself rejected (unexpected — processTimer catches internally)
          errors++
        }
      }
    }

    const latencyMs = Date.now() - runStart

    // -----------------------------------------------------------------------
    // 3. Log to cron_run_log
    // -----------------------------------------------------------------------
    try {
      await supabase.from('cron_run_log').insert({
        workspace_id: null,
        job_type: 'timer_scanner',
        status: errors > 0 ? 'partial_failure' : 'success',
        items_found: expired.length,
        items_actioned: fired,
        error_details: errors > 0 ? { errors_count: errors } : null,
        metadata: { latency_ms: latencyMs },
      })
    } catch (logErr) {
      console.error('[timer-scanner] Failed to write cron_run_log:', logErr)
    }

    console.log(`[timer-scanner] Done: ${fired} fired, ${errors} errors, ${latencyMs}ms`)

    return new Response(
      JSON.stringify({ processed: expired.length, fired, errors }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[timer-scanner] Fatal error:', err)
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500 }
    )
  }
})

// ─── Per-Timer Processing ──────────────────────────────────────────────────

type TimerResult = 'fired' | 'skipped' | 'error'

async function processTimer(
  supabase: ReturnType<typeof getSupabaseClient>,
  timer: PendingTimer
): Promise<TimerResult> {
  // Optimistic lock — mark as fired before dispatch
  // If another scanner instance already grabbed it, this UPDATE matches 0 rows
  // NOTE: { count: 'exact' } is required for Supabase to populate the count field
  const { error: lockError, count } = await supabase
    .from('pending_timer')
    .update({ status: 'fired', fired_at: new Date().toISOString() }, { count: 'exact' })
    .eq('timer_id', timer.timer_id)
    .eq('status', 'pending')

  // Lock failed — another instance got it, or status already changed
  if (lockError || count === 0) return 'skipped'

  try {
    switch (timer.timer_type) {
      case 'stale_conversation':
        await handleStaleConversation(supabase, timer)
        break
      case 'draft_review_nudge':
        await handleDraftReviewNudge(supabase, timer)
        break
      default:
        console.warn(`[timer-scanner] Unknown timer type: ${timer.timer_type}`)
    }
    return 'fired'
  } catch (err) {
    // Mark as error — visible in heartbeat alerts
    const errorMessage = err instanceof Error ? err.message : String(err)
    const errorStack = err instanceof Error ? err.stack : undefined

    await supabase
      .from('pending_timer')
      .update({
        status: 'error',
        error_details: { message: errorMessage, stack: errorStack },
      })
      .eq('timer_id', timer.timer_id)

    console.error(`[timer-scanner] Handler failed for ${timer.timer_type}:`, err)
    return 'error'
  }
}

// ─── Timer Handlers ────────────────────────────────────────────────────────

/**
 * Handle stale_conversation timer expiry.
 * Re-checks conversation state before transitioning — safety net against
 * cancelled timers or state changes that happened after firing.
 *
 * Does NOT draft a follow-up. It just transitions state to follow_up_pending.
 * The morning scan picks up follow_up_pending conversations and drafts follow-ups.
 */
async function handleStaleConversation(
  supabase: ReturnType<typeof getSupabaseClient>,
  timer: PendingTimer
): Promise<void> {
  // Re-check: is the conversation still in awaiting_client_reply?
  const { data: conv, error: convError } = await supabase
    .from('conversations')
    .select('id, state')
    .eq('id', timer.target_id)
    .single()

  if (convError || !conv) {
    console.warn(`[timer-scanner] Conversation not found: ${timer.target_id}`)
    return
  }

  if (conv.state !== 'awaiting_client_reply') {
    console.log(
      `[timer-scanner] Conversation ${timer.target_id} is in state "${conv.state}", not awaiting_client_reply — skipping transition`
    )
    return
  }

  await transitionConversation(timer.target_id, 'timeout_24h', 'timer')
}

/**
 * Handle draft_review_nudge timer expiry.
 * Re-checks draft status before notifying — safety net against
 * drafts that were already reviewed.
 *
 * Inserts a staff_notifications row which triggers Supabase Realtime
 * broadcast to the staff app.
 */
async function handleDraftReviewNudge(
  supabase: ReturnType<typeof getSupabaseClient>,
  timer: PendingTimer
): Promise<void> {
  // Re-check: is the draft still pending review?
  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .select('id, staff_action, conversation_id')
    .eq('id', timer.target_id)
    .single()

  if (draftError || !draft) {
    console.warn(`[timer-scanner] Draft not found: ${timer.target_id}`)
    return
  }

  // If staff_action is set, the draft was already reviewed — skip notification
  if (draft.staff_action !== null) {
    console.log(
      `[timer-scanner] Draft ${timer.target_id} already has staff_action="${draft.staff_action}" — skipping nudge`
    )
    return
  }

  // Look up client name for the notification body
  let clientName = 'a client'
  try {
    const { data: conv } = await supabase
      .from('conversations')
      .select('client_id, clients(full_name)')
      .eq('id', draft.conversation_id)
      .single()

    if (conv?.clients) {
      const client = conv.clients as unknown as { full_name: string | null }
      clientName = client.full_name ?? 'a client'
    }
  } catch {
    // Non-fatal: use default client name
  }

  // Insert notification record — Supabase Realtime broadcasts to staff app
  const { error: notifError } = await supabase
    .from('staff_notifications')
    .insert({
      workspace_id: timer.workspace_id,
      type: 'draft_review_reminder',
      title: 'Draft waiting for review',
      body: `Reply to ${clientName} is ready — tap to review`,
      metadata: { draftId: timer.target_id, conversationId: draft.conversation_id },
    })

  if (notifError) {
    throw new Error(`Failed to insert staff notification: ${notifError.message}`)
  }

  console.log(`[timer-scanner] Draft review nudge sent for draft ${timer.target_id}`)
}
