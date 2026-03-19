// supabase/functions/cron-morning-scan/index.ts
// Per-workspace morning scan — called by cron-morning-coordinator with { workspace_id }.
//
// Runs 6 sub-scans, each in its own try-catch. Partial failures don't block other scans.
//
//   cron-morning-scan (per workspace)
//       │
//       ├──> Step 0: Day-init — stale conversation sweep
//       ├──> Scan 1: Appointment reminders
//       ├──> Scan 2: Follow-up candidates (via scanAndPropose)
//       ├──> Scan 3: Booking confirmation checks (via scanAndPropose)
//       ├──> Scan 4: Inactivity detection
//       └──> Scan 5: Daily journal
//       │
//       v
//   Write cron_run_log entry (status: success | partial_failure | failed)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { transitionConversation } from '../_shared/conversation-state.ts'
import { bestEffortCancelTimer } from '../_shared/timer-helpers.ts'
import { scanAndPropose } from '../_shared/scan-and-propose.ts'
import { callLLM, FLASH_MODEL, estimateCost } from '../_shared/llm-client.ts'
import { logLLMUsage } from '../_shared/draft-persistence.ts'
import type { ScanResult, DailyJournalStats, LearningSnapshot } from '../_shared/proactive-types.ts'

// ─── Types ──────────────────────────────────────────────────

interface WorkspaceConfig {
  id: string
  business_name: string
  follow_up_check_days: number
  follow_up_max_attempts: number
  confirmation_check_days: number
  inactivity_days: number
  journal_enabled: boolean
  reminder_mode: 'template' | 'ai_draft'
}

interface ScanReport {
  step: string
  status: 'ok' | 'error'
  found: number
  actioned: number
  error?: string
}

// ─── Main handler ───────────────────────────────────────────

serve(async (req) => {
  const supabase = getSupabaseClient()
  const startedAt = new Date().toISOString()

  let workspaceId: string

  try {
    const body = await req.json()
    workspaceId = body.workspace_id
  } catch {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid JSON body' }),
      { status: 400 }
    )
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: 'workspace_id is required' }),
      { status: 400 }
    )
  }

  // Create cron_run_log entry
  const { data: runLog, error: runLogError } = await supabase
    .from('cron_run_log')
    .insert({
      workspace_id: workspaceId,
      job_type: 'morning-scan',
      started_at: startedAt,
      status: 'running',
    })
    .select('run_id')
    .single()

  if (runLogError) {
    console.error('[morning-scan] Failed to create cron_run_log:', runLogError.message)
  }
  const runId = runLog?.run_id ?? null

  try {
    // Load workspace config
    const { data: ws, error: wsError } = await supabase
      .from('workspaces')
      .select(
        'id, business_name, follow_up_check_days, follow_up_max_attempts, confirmation_check_days, inactivity_days, journal_enabled, reminder_mode'
      )
      .eq('id', workspaceId)
      .single()

    if (wsError || !ws) {
      const msg = wsError?.message ?? 'Workspace not found'
      console.error('[morning-scan] Failed to load workspace config:', msg)
      await finalizeCronLog(supabase, runId, 'failed', 0, 0, workspaceId, { error: msg })
      return new Response(JSON.stringify({ error: msg }), { status: 500 })
    }

    const config = ws as WorkspaceConfig

    console.log(`[morning-scan] [${config.business_name}] Starting morning scan`)

    // ─── Run all sub-scans ──────────────────────────────────
    const reports: ScanReport[] = []

    // Step 0: Stale conversation sweep
    reports.push(await runStep0_StaleConversationSweep(supabase, workspaceId))

    // Scan 1: Appointment reminders
    reports.push(await runScan1_AppointmentReminders(supabase, workspaceId, config))

    // Scan 2: Follow-up candidates
    reports.push(await runScan2_FollowUpCandidates(supabase, workspaceId, config))

    // Scan 3: Booking confirmation checks
    reports.push(await runScan3_BookingConfirmationChecks(supabase, workspaceId, config))

    // Scan 4: Inactivity detection
    reports.push(await runScan4_InactivityDetection(supabase, workspaceId, config))

    // Scan 5: Daily journal
    reports.push(await runScan5_DailyJournal(supabase, workspaceId, config))

    // ─── Compute final status ───────────────────────────────
    const errorCount = reports.filter((r) => r.status === 'error').length
    const totalFound = reports.reduce((sum, r) => sum + r.found, 0)
    const totalActioned = reports.reduce((sum, r) => sum + r.actioned, 0)

    const finalStatus =
      errorCount === 0
        ? 'success'
        : errorCount < reports.length
          ? 'partial_failure'
          : 'failed'

    // Log scan results
    for (const report of reports) {
      const statusIcon = report.status === 'ok' ? 'OK' : 'ERR'
      console.log(
        `[morning-scan] [${config.business_name}] ${statusIcon} ${report.step}: found=${report.found} actioned=${report.actioned}${report.error ? ` error=${report.error}` : ''}`
      )
    }

    await finalizeCronLog(supabase, runId, finalStatus, totalFound, totalActioned, workspaceId, {
      reports,
    })

    console.log(
      `[morning-scan] [${config.business_name}] Complete: ${finalStatus} (${totalFound} found, ${totalActioned} actioned, ${errorCount} errors)`
    )

    return new Response(
      JSON.stringify({
        success: true,
        status: finalStatus,
        total_found: totalFound,
        total_actioned: totalActioned,
        errors: errorCount,
      }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[morning-scan] Fatal error:', err)
    await finalizeCronLog(supabase, runId, 'failed', 0, 0, workspaceId, {
      error: String(err),
    })
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})

// ═══════════════════════════════════════════════════════════════
// Step 0: Day-init — Stale Conversation Sweep
// ═══════════════════════════════════════════════════════════════
//
// Query conversations where state='awaiting_client_reply' AND last
// outbound message > 24h. For each: transition to follow_up_pending,
// cancel the stale_conversation timer.
//
// Per-conversation try-catch for error isolation (T59).

async function runStep0_StaleConversationSweep(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string
): Promise<ScanReport> {
  try {
    // Find stale conversations: awaiting_client_reply with last outbound > 24h
    const { data: staleConvs, error: queryError } = await supabase
      .from('conversations')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('state', 'awaiting_client_reply')

    if (queryError) {
      return { step: 'step0_stale_sweep', status: 'error', found: 0, actioned: 0, error: queryError.message }
    }

    if (!staleConvs || staleConvs.length === 0) {
      return { step: 'step0_stale_sweep', status: 'ok', found: 0, actioned: 0 }
    }

    // For each candidate, check if the last outbound message is > 24h old
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    let found = 0
    let actioned = 0

    for (const conv of staleConvs) {
      try {
        // Get the most recent outbound message timestamp
        const { data: lastOutbound, error: msgError } = await supabase
          .from('messages')
          .select('created_at')
          .eq('conversation_id', conv.id)
          .eq('direction', 'outbound')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (msgError || !lastOutbound) continue

        // Only transition if last outbound message is older than 24h
        if (lastOutbound.created_at > twentyFourHoursAgo) continue

        found++

        // Transition conversation state
        try {
          await transitionConversation(conv.id, 'timeout_24h', 'morning_scan')
          actioned++
        } catch (transitionErr) {
          console.error(
            `[morning-scan] [step0] Failed to transition conversation ${conv.id}:`,
            transitionErr
          )
          continue
        }

        // Cancel pending stale_conversation timer (fire-and-forget)
        await bestEffortCancelTimer(conv.id, 'stale_conversation', 'morning_scan_handled')
      } catch (convErr) {
        // Per-conversation error isolation (T59)
        console.error(
          `[morning-scan] [step0] Error processing conversation ${conv.id}:`,
          convErr
        )
      }
    }

    return { step: 'step0_stale_sweep', status: 'ok', found, actioned }
  } catch (err) {
    return { step: 'step0_stale_sweep', status: 'error', found: 0, actioned: 0, error: String(err) }
  }
}

// ═══════════════════════════════════════════════════════════════
// Scan 1: Appointment Reminders
// ═══════════════════════════════════════════════════════════════
//
// Query bookings tomorrow, confirmed, reminder_sent_at IS NULL.
// For each: fill template with {client_name}, {appointment_type}, {time}.
// If workspace.reminder_mode = 'ai_draft': queue Client Worker instead.
// Create ProposedAction (tier: review, action_type: 'message_send').

async function runScan1_AppointmentReminders(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  config: WorkspaceConfig
): Promise<ScanReport> {
  try {
    // Calculate tomorrow's date range
    const now = new Date()
    const tomorrowStart = new Date(now)
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1)
    tomorrowStart.setUTCHours(0, 0, 0, 0)

    const tomorrowEnd = new Date(tomorrowStart)
    tomorrowEnd.setUTCDate(tomorrowEnd.getUTCDate() + 1)

    // Query bookings tomorrow with status=confirmed and no reminder sent
    const { data: bookings, error: queryError } = await supabase
      .from('bookings')
      .select('id, client_id, appointment_type, start_time')
      .eq('workspace_id', workspaceId)
      .eq('status', 'confirmed')
      .is('reminder_sent_at', null)
      .gte('start_time', tomorrowStart.toISOString())
      .lt('start_time', tomorrowEnd.toISOString())

    if (queryError) {
      return { step: 'scan1_reminders', status: 'error', found: 0, actioned: 0, error: queryError.message }
    }

    if (!bookings || bookings.length === 0) {
      return { step: 'scan1_reminders', status: 'ok', found: 0, actioned: 0 }
    }

    let actioned = 0

    for (const booking of bookings) {
      try {
        // Get client name for template
        const { data: client } = await supabase
          .from('clients')
          .select('full_name')
          .eq('id', booking.client_id)
          .single()

        const clientName = client?.full_name ?? 'there'
        const appointmentTime = new Date(booking.start_time).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        })

        // Get conversation for this client
        const { data: conv } = await supabase
          .from('conversations')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('client_id', booking.client_id)
          .limit(1)
          .maybeSingle()

        const conversationId = conv?.id ?? null

        if (config.reminder_mode === 'ai_draft' && conversationId) {
          // Queue Client Worker for contextual drafting
          try {
            await supabase.rpc('pgmq_send', {
              queue_name: 'client_worker',
              msg: {
                workspace_id: workspaceId,
                client_id: booking.client_id,
                conversation_id: conversationId,
                trigger: 'morning_scan',
                scan_type: 'appointment_reminder',
                booking_id: booking.id,
              },
            })
          } catch {
            console.warn(`[morning-scan] [scan1] Failed to queue client_worker for booking ${booking.id}`)
          }
        }

        // Create ProposedAction for staff review
        const { error: insertError } = await supabase
          .from('proposed_actions')
          .insert({
            workspace_id: workspaceId,
            client_id: booking.client_id,
            conversation_id: conversationId,
            action_type: 'message_send',
            summary: `Appointment reminder: ${booking.appointment_type} tomorrow at ${appointmentTime} for ${clientName}`,
            tier: 'review',
            payload: {
              source: 'morning_scan',
              scan_type: 'appointment_reminder',
              booking_id: booking.id,
              client_name: clientName,
              appointment_type: booking.appointment_type,
              start_time: booking.start_time,
              reminder_mode: config.reminder_mode,
            },
            status: 'pending',
          })

        if (insertError) {
          console.error(
            `[morning-scan] [scan1] Failed to insert proposed_action for booking ${booking.id}:`,
            insertError.message
          )
          continue
        }

        actioned++
      } catch (bookingErr) {
        console.error(`[morning-scan] [scan1] Error processing booking ${booking.id}:`, bookingErr)
      }
    }

    return { step: 'scan1_reminders', status: 'ok', found: bookings.length, actioned }
  } catch (err) {
    return { step: 'scan1_reminders', status: 'error', found: 0, actioned: 0, error: String(err) }
  }
}

// ═══════════════════════════════════════════════════════════════
// Scan 2: Follow-up Candidates (via scanAndPropose)
// ═══════════════════════════════════════════════════════════════
//
// Query conversations where last_client_message_at <= NOW() - follow_up_check_days
// AND state IN ('awaiting_client_reply', 'follow_up_pending')
// AND follow_up_attempt_count < follow_up_max_attempts
// AND no outbound message in last follow_up_check_days.

async function runScan2_FollowUpCandidates(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  config: WorkspaceConfig
): Promise<ScanReport> {
  try {
    const cutoffDate = new Date(
      Date.now() - config.follow_up_check_days * 24 * 60 * 60 * 1000
    ).toISOString()

    // Query follow-up candidate conversations
    const { data: conversations, error: queryError } = await supabase
      .from('conversations')
      .select('id, client_id, follow_up_attempt_count')
      .eq('workspace_id', workspaceId)
      .in('state', ['awaiting_client_reply', 'follow_up_pending'])
      .lt('follow_up_attempt_count', config.follow_up_max_attempts)
      .lte('last_client_message_at', cutoffDate)

    if (queryError) {
      return { step: 'scan2_follow_ups', status: 'error', found: 0, actioned: 0, error: queryError.message }
    }

    if (!conversations || conversations.length === 0) {
      return { step: 'scan2_follow_ups', status: 'ok', found: 0, actioned: 0 }
    }

    // Filter: no outbound message in the last follow_up_check_days
    const candidates: Array<{ clientId: string; conversationId: string; attemptCount: number }> = []

    for (const conv of conversations) {
      const { data: recentOutbound } = await supabase
        .from('messages')
        .select('id')
        .eq('conversation_id', conv.id)
        .eq('direction', 'outbound')
        .gte('created_at', cutoffDate)
        .limit(1)

      if (!recentOutbound || recentOutbound.length === 0) {
        candidates.push({
          clientId: conv.client_id,
          conversationId: conv.id,
          attemptCount: conv.follow_up_attempt_count,
        })
      }
    }

    if (candidates.length === 0) {
      return { step: 'scan2_follow_ups', status: 'ok', found: 0, actioned: 0 }
    }

    // Use scanAndPropose for batch processing
    const result = await scanAndPropose(supabase, workspaceId, {
      candidates,
      proposalType: 'message_send',
      reason: 'follow_up_candidate',
      tier: 'review',
      metadata: { follow_up_check_days: config.follow_up_check_days },
    })

    return { step: 'scan2_follow_ups', status: 'ok', found: result.found, actioned: result.actioned }
  } catch (err) {
    return { step: 'scan2_follow_ups', status: 'error', found: 0, actioned: 0, error: String(err) }
  }
}

// ═══════════════════════════════════════════════════════════════
// Scan 3: Booking Confirmation Checks (via scanAndPropose)
// ═══════════════════════════════════════════════════════════════
//
// Query bookings within confirmation_check_days, confirmation_status='pending'.

async function runScan3_BookingConfirmationChecks(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  config: WorkspaceConfig
): Promise<ScanReport> {
  try {
    const checkWindow = new Date(
      Date.now() + config.confirmation_check_days * 24 * 60 * 60 * 1000
    ).toISOString()

    // Query bookings that are coming up and still unconfirmed
    const { data: bookings, error: queryError } = await supabase
      .from('bookings')
      .select('id, client_id, appointment_type, start_time')
      .eq('workspace_id', workspaceId)
      .eq('confirmation_status', 'pending')
      .gte('start_time', new Date().toISOString())
      .lte('start_time', checkWindow)

    if (queryError) {
      return { step: 'scan3_confirmations', status: 'error', found: 0, actioned: 0, error: queryError.message }
    }

    if (!bookings || bookings.length === 0) {
      return { step: 'scan3_confirmations', status: 'ok', found: 0, actioned: 0 }
    }

    // Build candidates with conversation IDs
    const candidates: Array<{ clientId: string; conversationId: string; bookingId: string; appointmentType: string }> = []

    for (const booking of bookings) {
      const { data: conv } = await supabase
        .from('conversations')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('client_id', booking.client_id)
        .limit(1)
        .maybeSingle()

      if (conv) {
        candidates.push({
          clientId: booking.client_id,
          conversationId: conv.id,
          bookingId: booking.id,
          appointmentType: booking.appointment_type,
        })
      }
    }

    if (candidates.length === 0) {
      return { step: 'scan3_confirmations', status: 'ok', found: 0, actioned: 0 }
    }

    const result = await scanAndPropose(supabase, workspaceId, {
      candidates,
      proposalType: 'message_send',
      reason: 'booking_confirmation_check',
      tier: 'review',
      metadata: { confirmation_check_days: config.confirmation_check_days },
    })

    return { step: 'scan3_confirmations', status: 'ok', found: result.found, actioned: result.actioned }
  } catch (err) {
    return { step: 'scan3_confirmations', status: 'error', found: 0, actioned: 0, error: String(err) }
  }
}

// ═══════════════════════════════════════════════════════════════
// Scan 4: Inactivity Detection
// ═══════════════════════════════════════════════════════════════
//
// Atomic CTE: UPDATE clients SET lifecycle_status='inactive'
// WHERE last_contacted_at <= NOW() - inactivity_days.
// Clear open follow-up state on inactive clients' conversations.
// Create ProposedAction (tier: auto, type: lifecycle_transition).

async function runScan4_InactivityDetection(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  config: WorkspaceConfig
): Promise<ScanReport> {
  try {
    const inactivityCutoff = new Date(
      Date.now() - config.inactivity_days * 24 * 60 * 60 * 1000
    ).toISOString()

    // Find clients to mark inactive:
    // - last_contacted_at is past the threshold
    // - currently not already inactive
    // - not deleted
    const { data: inactiveClients, error: queryError } = await supabase
      .from('clients')
      .select('id')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .neq('lifecycle_status', 'inactive')
      .lte('last_contacted_at', inactivityCutoff)

    if (queryError) {
      return { step: 'scan4_inactivity', status: 'error', found: 0, actioned: 0, error: queryError.message }
    }

    if (!inactiveClients || inactiveClients.length === 0) {
      return { step: 'scan4_inactivity', status: 'ok', found: 0, actioned: 0 }
    }

    let actioned = 0

    for (const client of inactiveClients) {
      try {
        // Update client lifecycle to inactive
        const { error: updateError } = await supabase
          .from('clients')
          .update({ lifecycle_status: 'inactive' })
          .eq('id', client.id)

        if (updateError) {
          console.error(
            `[morning-scan] [scan4] Failed to mark client ${client.id} as inactive:`,
            updateError.message
          )
          continue
        }

        // Clear follow_up_pending state on this client's conversations
        const { error: convUpdateError } = await supabase
          .from('conversations')
          .update({ state: 'idle', follow_up_attempt_count: 0 })
          .eq('workspace_id', workspaceId)
          .eq('client_id', client.id)
          .eq('state', 'follow_up_pending')

        if (convUpdateError) {
          console.warn(
            `[morning-scan] [scan4] Failed to clear follow-up state for client ${client.id}:`,
            convUpdateError.message
          )
        }

        // Get conversation for audit trail
        const { data: conv } = await supabase
          .from('conversations')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('client_id', client.id)
          .limit(1)
          .maybeSingle()

        // Create ProposedAction as record of the auto transition
        await supabase
          .from('proposed_actions')
          .insert({
            workspace_id: workspaceId,
            client_id: client.id,
            conversation_id: conv?.id ?? null,
            action_type: 'client_update',
            summary: `Client marked inactive (no contact in ${config.inactivity_days} days)`,
            tier: 'auto',
            payload: {
              source: 'morning_scan',
              scan_type: 'inactivity_detection',
              lifecycle_transition: { from: 'active', to: 'inactive' },
              inactivity_days: config.inactivity_days,
            },
            status: 'approved', // auto tier — already executed
          })

        // Write audit event
        try {
          await supabase.from('audit_events').insert({
            workspace_id: workspaceId,
            actor_type: 'system',
            actor_id: null,
            action_type: 'client_marked_inactive',
            target_type: 'client',
            target_id: client.id,
            metadata: {
              trigger: 'morning_scan',
              inactivity_days: config.inactivity_days,
            },
          })
        } catch {
          // Audit failure never blocks
        }

        actioned++
      } catch (clientErr) {
        console.error(`[morning-scan] [scan4] Error processing client ${client.id}:`, clientErr)
      }
    }

    return { step: 'scan4_inactivity', status: 'ok', found: inactiveClients.length, actioned }
  } catch (err) {
    return { step: 'scan4_inactivity', status: 'error', found: 0, actioned: 0, error: String(err) }
  }
}

// ═══════════════════════════════════════════════════════════════
// Scan 5: Daily Journal
// ═══════════════════════════════════════════════════════════════
//
// Aggregate stats from today's records (pure SQL).
// Compile learning snapshot from draft_edit_signals.
// One LLM call (FLASH_MODEL) for narrative summary.
// Write daily_journal record (unique constraint on workspace_id + date).

async function runScan5_DailyJournal(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  config: WorkspaceConfig
): Promise<ScanReport> {
  if (!config.journal_enabled) {
    return { step: 'scan5_journal', status: 'ok', found: 0, actioned: 0 }
  }

  try {
    const today = new Date().toISOString().slice(0, 10)
    const todayStart = `${today}T00:00:00.000Z`
    const tomorrow = new Date()
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    const tomorrowStart = `${tomorrow.toISOString().slice(0, 10)}T00:00:00.000Z`

    // ─── Aggregate stats ──────────────────────────────────────

    // Messages counts
    const { data: inboundMsgs } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('direction', 'inbound')
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    const { data: outboundMsgs } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('direction', 'outbound')
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    // Unique clients interacted
    const { data: clientsInteracted } = await supabase
      .from('messages')
      .select('conversation_id')
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    const uniqueConvs = new Set((clientsInteracted ?? []).map((m: { conversation_id: string }) => m.conversation_id))

    // New clients today
    const { data: newClients } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    // Drafts generated
    const { data: draftsGenerated } = await supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    // Draft edit signals breakdown
    const { data: editSignals } = await supabase
      .from('draft_edit_signals')
      .select('staff_action')
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    const signalCounts = {
      sent_as_is: 0,
      edited_and_sent: 0,
      regenerated: 0,
      discarded: 0,
    }
    for (const signal of editSignals ?? []) {
      const action = signal.staff_action as keyof typeof signalCounts
      if (action in signalCounts) {
        signalCounts[action]++
      }
    }

    // Bookings
    const { data: bookingsCreated } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    const { data: bookingsCancelled } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'cancelled')
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    const { data: bookingsCompleted } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'completed')
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    // Follow-ups (from proposed_actions with follow_up scan_type)
    const { data: followUpActions } = await supabase
      .from('proposed_actions')
      .select('id, status')
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    const followUpsSent = (followUpActions ?? []).filter((a: { status: string }) => a.status === 'approved').length
    const followUpsDismissed = (followUpActions ?? []).filter((a: { status: string }) => a.status === 'rejected').length

    // Inactive clients today (from proposed_actions)
    const { data: inactiveActions } = await supabase
      .from('proposed_actions')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('action_type', 'client_update')
      .gte('created_at', todayStart)
      .lt('created_at', tomorrowStart)

    // Build stats object
    const stats: DailyJournalStats = {
      clients_interacted: uniqueConvs.size,
      new_clients: (newClients as unknown as { count: number })?.count ?? 0,
      messages_inbound: (inboundMsgs as unknown as { count: number })?.count ?? 0,
      messages_outbound: (outboundMsgs as unknown as { count: number })?.count ?? 0,
      drafts_generated: (draftsGenerated as unknown as { count: number })?.count ?? 0,
      drafts_sent_as_is: signalCounts.sent_as_is,
      drafts_edited: signalCounts.edited_and_sent,
      drafts_discarded: signalCounts.discarded,
      bookings_created: (bookingsCreated as unknown as { count: number })?.count ?? 0,
      bookings_cancelled: (bookingsCancelled as unknown as { count: number })?.count ?? 0,
      bookings_completed: (bookingsCompleted as unknown as { count: number })?.count ?? 0,
      follow_ups_sent: followUpsSent,
      follow_ups_dismissed: followUpsDismissed,
      clients_marked_inactive: (inactiveActions as unknown as { count: number })?.count ?? 0,
    }

    // ─── Learning snapshot ────────────────────────────────────

    const totalSignals = Object.values(signalCounts).reduce((s, v) => s + v, 0)
    const acceptanceRate = totalSignals > 0
      ? (signalCounts.sent_as_is / totalSignals) * 100
      : 0

    const learningSnapshot: LearningSnapshot = {
      acceptance_rate_today: Math.round(acceptanceRate * 10) / 10,
      common_edit_categories: [], // Would be populated by edit analysis (future)
      new_patterns_detected: [],
      rules_promoted_today: [],
    }

    // ─── LLM narrative ────────────────────────────────────────

    let narrative: string | null = null

    try {
      const pipelineStart = Date.now()

      const llmResult = await callLLM({
        model: FLASH_MODEL,
        systemPrompt: `You are a business operations analyst. Write a brief 2-3 sentence daily summary for a ${config.business_name} CRM. Focus on highlights, concerns, and opportunities. Be concrete and actionable. No greetings or sign-offs.`,
        messages: [
          {
            role: 'user',
            content: `Today's stats for ${config.business_name}:\n${JSON.stringify(stats, null, 2)}\n\nDraft acceptance rate: ${learningSnapshot.acceptance_rate_today}%`,
          },
        ],
        maxTokens: 256,
      })

      narrative = llmResult.message.content ?? null

      const latencyMs = Date.now() - pipelineStart
      const costUsd = estimateCost(FLASH_MODEL, llmResult.usage.tokensIn, llmResult.usage.tokensOut)

      await logLLMUsage(supabase, {
        workspaceId,
        clientId: null,
        edgeFunctionName: 'cron-morning-scan',
        model: FLASH_MODEL,
        tokensIn: llmResult.usage.tokensIn,
        tokensOut: llmResult.usage.tokensOut,
        latencyMs,
        costUsd,
      })
    } catch (llmErr) {
      console.error('[morning-scan] [scan5] LLM narrative failed (non-blocking):', llmErr)
      // Non-fatal: journal is still useful without narrative
    }

    // ─── Write daily_journal ──────────────────────────────────

    const { error: journalError } = await supabase
      .from('daily_journal')
      .upsert(
        {
          workspace_id: workspaceId,
          date: today,
          stats,
          narrative,
          learning_snapshot: learningSnapshot,
          alerts: null,
        },
        { onConflict: 'workspace_id,date' }
      )

    if (journalError) {
      return { step: 'scan5_journal', status: 'error', found: 1, actioned: 0, error: journalError.message }
    }

    return { step: 'scan5_journal', status: 'ok', found: 1, actioned: 1 }
  } catch (err) {
    return { step: 'scan5_journal', status: 'error', found: 0, actioned: 0, error: String(err) }
  }
}

// ─── Helper: finalize cron_run_log ──────────────────────────

async function finalizeCronLog(
  supabase: ReturnType<typeof getSupabaseClient>,
  runId: string | null,
  status: 'success' | 'partial_failure' | 'failed',
  itemsFound: number,
  itemsActioned: number,
  workspaceId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  if (!runId) return

  try {
    await supabase
      .from('cron_run_log')
      .update({
        completed_at: new Date().toISOString(),
        status,
        items_found: itemsFound,
        items_actioned: itemsActioned,
        metadata,
        error_details: status === 'failed' ? metadata : null,
      })
      .eq('run_id', runId)
  } catch (err) {
    console.error('[morning-scan] Failed to finalize cron_run_log:', err)
  }
}
