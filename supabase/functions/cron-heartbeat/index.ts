// supabase/functions/cron-heartbeat/index.ts
// Infrastructure health check Edge Function — runs on a cron schedule.
//
// Checks per active workspace:
//   1. WhatsApp connection — Baileys server /status/:workspaceId + staleness heuristic
//   2. pgmq queue health  — queue_depth and DLQ item count
//   3. LLM availability   — HTTP HEAD to OpenRouter /api/v1/models
//   4. Calendar connection — token expiry check from workspace.calendar_config
//
// Flow:
//
//  ┌─────────────────────────────┐
//  │  Query active workspaces    │  onboarding_status = 'complete'
//  └──────────┬──────────────────┘
//             │
//             v
//  ┌─────────────────────────────┐
//  │  For each workspace:        │
//  │    ├─ WhatsApp check        │  GET Baileys /status/:id
//  │    ├─ pgmq queue check      │  RPC pgmq.metrics('inbound_messages')
//  │    ├─ LLM availability      │  HEAD OpenRouter /api/v1/models
//  │    └─ Calendar token check  │  Inspect calendar_config.token_expiry
//  └──────────┬──────────────────┘
//             │
//             v
//  ┌─────────────────────────────┐
//  │  UPDATE workspace           │  last_heartbeat_at, whatsapp_connection_status
//  │  INSERT staff_notifications │  if any alerts
//  │  INSERT cron_run_log        │  job_type: 'heartbeat'
//  └─────────────────────────────┘
//
// Defensive: each check is try/caught independently. A single failure
// never prevents other checks from running.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'

// ─── Configuration ───────────────────────────────────────────
const BAILEYS_SERVER_URL = Deno.env.get('BAILEYS_SERVER_URL') ?? 'http://localhost:3001'
const BAILEYS_API_SECRET = Deno.env.get('BAILEYS_API_SECRET') ?? ''
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

// WhatsApp staleness thresholds (minutes)
const DEGRADED_THRESHOLD_MINUTES = 30
const DISCONNECTED_THRESHOLD_MINUTES = 120

// pgmq alert thresholds
const QUEUE_DEPTH_ALERT_THRESHOLD = 50

// HTTP timeout for external service checks (ms)
const CHECK_TIMEOUT_MS = 10_000

// ─── Types ───────────────────────────────────────────────────

interface HealthCheckResult {
  check: string
  status: 'ok' | 'degraded' | 'alert' | 'error'
  message: string
  metadata?: Record<string, unknown>
}

interface WorkspaceRow {
  id: string
  business_name: string
  whatsapp_connection_status: string | null
  calendar_config: CalendarConfig | null
  last_heartbeat_at: string | null
}

interface CalendarConfig {
  provider?: string
  token_expiry?: string
  [key: string]: unknown
}

interface PgmqMetrics {
  queue_name: string
  queue_length: number
  newest_msg_age_sec: number | null
  oldest_msg_age_sec: number | null
  total_messages: number
}

// ─── Individual Health Checks ────────────────────────────────

/**
 * Check 1: WhatsApp connection
 *
 * Queries the Baileys server /status/:workspaceId endpoint.
 * Falls back to staleness heuristic based on last inbound message time.
 *
 *   Baileys status 'connected' + recent webhook → 'connected'
 *   Baileys status 'connected' but no recent webhook → 'degraded'
 *   Baileys status not 'connected' or unreachable → 'disconnected'
 */
async function checkWhatsApp(
  workspaceId: string,
  lastMessageAt: string | null
): Promise<HealthCheckResult> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)

    const headers: Record<string, string> = {}
    if (BAILEYS_API_SECRET) {
      headers['Authorization'] = `Bearer ${BAILEYS_API_SECRET}`
    }

    const response = await fetch(
      `${BAILEYS_SERVER_URL}/status/${workspaceId}`,
      { signal: controller.signal, headers }
    )
    clearTimeout(timeoutId)

    if (!response.ok) {
      return {
        check: 'whatsapp',
        status: 'error',
        message: `Baileys server returned ${response.status}`,
        metadata: { httpStatus: response.status },
      }
    }

    const data = await response.json() as { status: string }
    const baileysStatus = data.status

    if (baileysStatus !== 'connected') {
      return {
        check: 'whatsapp',
        status: 'alert',
        message: `Baileys reports status: ${baileysStatus}`,
        metadata: { baileysStatus },
      }
    }

    // Baileys says connected — check webhook staleness
    if (lastMessageAt) {
      const ageMinutes =
        (Date.now() - new Date(lastMessageAt).getTime()) / (1000 * 60)

      if (ageMinutes > DISCONNECTED_THRESHOLD_MINUTES) {
        return {
          check: 'whatsapp',
          status: 'alert',
          message: `Connected but no webhook in ${Math.round(ageMinutes)} minutes`,
          metadata: { baileysStatus, ageMinutes: Math.round(ageMinutes) },
        }
      }

      if (ageMinutes > DEGRADED_THRESHOLD_MINUTES) {
        return {
          check: 'whatsapp',
          status: 'degraded',
          message: `Connected but no webhook in ${Math.round(ageMinutes)} minutes`,
          metadata: { baileysStatus, ageMinutes: Math.round(ageMinutes) },
        }
      }
    }

    return {
      check: 'whatsapp',
      status: 'ok',
      message: 'WhatsApp connected',
      metadata: { baileysStatus },
    }
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === 'AbortError'
        ? 'Baileys server request timed out'
        : `Baileys server unreachable: ${String(err)}`

    return {
      check: 'whatsapp',
      status: 'error',
      message,
    }
  }
}

/**
 * Check 2: pgmq queue health
 *
 * Queries pgmq.metrics('inbound_messages') for queue depth.
 * Also checks the DLQ for any items awaiting attention.
 *
 *   queue_depth <= 50 AND DLQ empty → 'ok'
 *   queue_depth > 50 OR DLQ has items → 'alert'
 */
async function checkQueueHealth(
  supabase: ReturnType<typeof getSupabaseClient>
): Promise<HealthCheckResult> {
  try {
    // Check main queue metrics
    const { data: metrics, error: metricsError } = await supabase.rpc(
      'pgmq_metrics',
      { queue_name: 'inbound_messages' }
    )

    if (metricsError) {
      return {
        check: 'pgmq',
        status: 'error',
        message: `Failed to query pgmq metrics: ${metricsError.message}`,
      }
    }

    // pgmq_metrics returns a single row or array depending on wrapper
    const m: PgmqMetrics = Array.isArray(metrics) ? metrics[0] : metrics
    const queueDepth = m?.queue_length ?? 0

    // Check DLQ for items
    let dlqCount = 0
    try {
      const { data: dlqMetrics } = await supabase.rpc('pgmq_metrics', {
        queue_name: 'inbound_dlq',
      })
      const dlq: PgmqMetrics = Array.isArray(dlqMetrics)
        ? dlqMetrics[0]
        : dlqMetrics
      dlqCount = dlq?.queue_length ?? 0
    } catch {
      // DLQ queue may not exist yet — not an error
      console.warn('[heartbeat] Could not read DLQ metrics (queue may not exist)')
    }

    const alerts: string[] = []
    if (queueDepth > QUEUE_DEPTH_ALERT_THRESHOLD) {
      alerts.push(`Queue depth: ${queueDepth} (threshold: ${QUEUE_DEPTH_ALERT_THRESHOLD})`)
    }
    if (dlqCount > 0) {
      alerts.push(`DLQ has ${dlqCount} item(s) awaiting attention`)
    }

    if (alerts.length > 0) {
      return {
        check: 'pgmq',
        status: 'alert',
        message: alerts.join('; '),
        metadata: { queueDepth, dlqCount },
      }
    }

    return {
      check: 'pgmq',
      status: 'ok',
      message: `Queue depth: ${queueDepth}, DLQ: ${dlqCount}`,
      metadata: { queueDepth, dlqCount },
    }
  } catch (err) {
    return {
      check: 'pgmq',
      status: 'error',
      message: `Queue health check failed: ${String(err)}`,
    }
  }
}

/**
 * Check 3: LLM availability
 *
 * Sends HTTP HEAD to OpenRouter /api/v1/models.
 * Any timeout or 5xx response triggers an alert.
 */
async function checkLLMAvailability(): Promise<HealthCheckResult> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
    })
    clearTimeout(timeoutId)

    if (response.status >= 500) {
      return {
        check: 'llm',
        status: 'alert',
        message: `OpenRouter returned ${response.status}`,
        metadata: { httpStatus: response.status },
      }
    }

    return {
      check: 'llm',
      status: 'ok',
      message: `OpenRouter reachable (HTTP ${response.status})`,
      metadata: { httpStatus: response.status },
    }
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === 'AbortError'
        ? 'OpenRouter request timed out'
        : `OpenRouter unreachable: ${String(err)}`

    return {
      check: 'llm',
      status: 'alert',
      message,
    }
  }
}

/**
 * Check 4: Calendar connection
 *
 * Inspects workspace.calendar_config for token_expiry.
 * If the token is expired, flags for re-auth.
 */
function checkCalendarConnection(
  calendarConfig: CalendarConfig | null
): HealthCheckResult {
  if (!calendarConfig || !calendarConfig.provider) {
    return {
      check: 'calendar',
      status: 'ok',
      message: 'No calendar configured (skipped)',
    }
  }

  if (!calendarConfig.token_expiry) {
    return {
      check: 'calendar',
      status: 'ok',
      message: `Calendar configured (${calendarConfig.provider}) but no token_expiry set`,
      metadata: { provider: calendarConfig.provider },
    }
  }

  const expiryDate = new Date(calendarConfig.token_expiry)
  const now = new Date()

  if (expiryDate <= now) {
    return {
      check: 'calendar',
      status: 'alert',
      message: `Calendar token expired at ${calendarConfig.token_expiry}`,
      metadata: {
        provider: calendarConfig.provider,
        expiredAt: calendarConfig.token_expiry,
      },
    }
  }

  // Warn if expiring within 24 hours
  const hoursUntilExpiry =
    (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60)

  if (hoursUntilExpiry < 24) {
    return {
      check: 'calendar',
      status: 'degraded',
      message: `Calendar token expires in ${Math.round(hoursUntilExpiry)} hours`,
      metadata: {
        provider: calendarConfig.provider,
        expiresAt: calendarConfig.token_expiry,
        hoursUntilExpiry: Math.round(hoursUntilExpiry),
      },
    }
  }

  return {
    check: 'calendar',
    status: 'ok',
    message: `Calendar connected (${calendarConfig.provider})`,
    metadata: {
      provider: calendarConfig.provider,
      expiresAt: calendarConfig.token_expiry,
    },
  }
}

// ─── Derive WhatsApp status from check result ────────────────

function deriveWhatsAppStatus(
  result: HealthCheckResult
): 'connected' | 'degraded' | 'disconnected' {
  switch (result.status) {
    case 'ok':
      return 'connected'
    case 'degraded':
      return 'degraded'
    case 'alert':
    case 'error':
    default:
      return 'disconnected'
  }
}

// ─── Main handler ────────────────────────────────────────────

serve(async (_req) => {
  const supabase = getSupabaseClient()
  const startedAt = new Date().toISOString()

  // Create cron_run_log entry
  const { data: runLog, error: runLogError } = await supabase
    .from('cron_run_log')
    .insert({
      job_type: 'heartbeat',
      started_at: startedAt,
      status: 'running',
    })
    .select('run_id')
    .single()

  if (runLogError) {
    console.error('[heartbeat] Failed to create cron_run_log entry:', runLogError.message)
  }
  const runId = runLog?.run_id ?? null

  try {
    // 1. Query active workspaces
    const { data: workspaces, error: wsError } = await supabase
      .from('workspaces')
      .select('id, business_name, whatsapp_connection_status, calendar_config, last_heartbeat_at')
      .eq('onboarding_status', 'complete')

    if (wsError) {
      console.error('[heartbeat] Failed to query workspaces:', wsError.message)
      await finalizeCronLog(supabase, runId, 'failed', 0, 0, { error: wsError.message })
      return new Response(
        JSON.stringify({ error: 'Failed to query workspaces' }),
        { status: 500 }
      )
    }

    if (!workspaces || workspaces.length === 0) {
      console.log('[heartbeat] No active workspaces found')
      await finalizeCronLog(supabase, runId, 'success', 0, 0, { message: 'No active workspaces' })
      return new Response(
        JSON.stringify({ success: true, workspaces: 0 }),
        { status: 200 }
      )
    }

    console.log(`[heartbeat] Checking ${workspaces.length} workspace(s)`)

    // LLM check runs once (shared across all workspaces)
    const llmResult = await checkLLMAvailability()
    console.log(`[heartbeat] LLM check: ${llmResult.status} — ${llmResult.message}`)

    // pgmq check runs once (shared queue)
    const queueResult = await checkQueueHealth(supabase)
    console.log(`[heartbeat] Queue check: ${queueResult.status} — ${queueResult.message}`)

    let totalChecked = 0
    let totalAlerts = 0
    const errors: Array<{ workspaceId: string; error: string }> = []

    // 2. For each workspace, run per-workspace checks
    for (const ws of workspaces as WorkspaceRow[]) {
      try {
        const alerts: HealthCheckResult[] = []

        // 2a. WhatsApp check
        // Get most recent inbound message time for staleness heuristic
        let lastMessageAt: string | null = null
        try {
          const { data: recentMsg } = await supabase
            .from('messages')
            .select('created_at')
            .eq('workspace_id', ws.id)
            .eq('direction', 'inbound')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          lastMessageAt = recentMsg?.created_at ?? null
        } catch {
          console.warn(`[heartbeat] Could not query recent messages for workspace ${ws.id}`)
        }

        const waResult = await checkWhatsApp(ws.id, lastMessageAt)
        console.log(`[heartbeat] [${ws.business_name}] WhatsApp: ${waResult.status} — ${waResult.message}`)

        // 2b. Calendar check
        const calResult = checkCalendarConnection(ws.calendar_config)
        console.log(`[heartbeat] [${ws.business_name}] Calendar: ${calResult.status} — ${calResult.message}`)

        // Collect all results for this workspace
        const allResults = [waResult, queueResult, llmResult, calResult]

        // Gather alerts (anything not 'ok')
        for (const result of allResults) {
          if (result.status !== 'ok') {
            alerts.push(result)
          }
        }

        // 3. Update workspace: last_heartbeat_at + whatsapp_connection_status
        const newWaStatus = deriveWhatsAppStatus(waResult)
        const { error: updateError } = await supabase
          .from('workspaces')
          .update({
            last_heartbeat_at: new Date().toISOString(),
            whatsapp_connection_status: newWaStatus,
          })
          .eq('id', ws.id)

        if (updateError) {
          console.error(
            `[heartbeat] Failed to update workspace ${ws.id}:`,
            updateError.message
          )
          errors.push({ workspaceId: ws.id, error: updateError.message })
        }

        // 4. If any alerts, insert staff_notifications
        if (alerts.length > 0) {
          totalAlerts += alerts.length

          const alertSummary = alerts
            .map((a) => `[${a.check}] ${a.message}`)
            .join('\n')

          try {
            await supabase.from('staff_notifications').insert({
              workspace_id: ws.id,
              type: 'heartbeat_alert',
              title: `Health check: ${alerts.length} alert(s) detected`,
              body: alertSummary,
              metadata: {
                checks: alerts.map((a) => ({
                  check: a.check,
                  status: a.status,
                  message: a.message,
                  ...a.metadata,
                })),
              },
            })
          } catch (notifErr) {
            console.error(
              `[heartbeat] Failed to insert staff_notification for ${ws.id}:`,
              notifErr
            )
          }
        }

        totalChecked++
      } catch (wsErr) {
        console.error(`[heartbeat] Error processing workspace ${ws.id}:`, wsErr)
        errors.push({ workspaceId: ws.id, error: String(wsErr) })
      }
    }

    // 5. Finalize cron_run_log
    const finalStatus =
      errors.length === 0
        ? 'success'
        : errors.length < (workspaces as WorkspaceRow[]).length
          ? 'partial_failure'
          : 'failed'

    await finalizeCronLog(supabase, runId, finalStatus, totalChecked, totalAlerts, {
      workspacesChecked: totalChecked,
      alertsRaised: totalAlerts,
      errors: errors.length > 0 ? errors : undefined,
      llm: { status: llmResult.status, message: llmResult.message },
      queue: { status: queueResult.status, message: queueResult.message },
    })

    console.log(
      `[heartbeat] Complete: ${totalChecked} workspaces checked, ${totalAlerts} alerts, ${errors.length} errors`
    )

    return new Response(
      JSON.stringify({
        success: true,
        workspacesChecked: totalChecked,
        alertsRaised: totalAlerts,
        errors: errors.length,
        status: finalStatus,
      }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[heartbeat] Fatal error:', err)
    await finalizeCronLog(supabase, runId, 'failed', 0, 0, { error: String(err) })
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})

// ─── Helper: finalize cron_run_log ───────────────────────────

async function finalizeCronLog(
  supabase: ReturnType<typeof getSupabaseClient>,
  runId: string | null,
  status: 'success' | 'partial_failure' | 'failed',
  itemsFound: number,
  itemsActioned: number,
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
    console.error('[heartbeat] Failed to finalize cron_run_log:', err)
  }
}
