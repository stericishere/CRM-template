// supabase/functions/cron-morning-coordinator/index.ts
// Fan-out coordinator for the morning scan.
// Triggered by pg_cron at 9 AM HK (01:00 UTC).
//
// Same pattern as compaction-coordinator:
//
//   ┌────────────────────────────────┐
//   │  Query active workspaces       │  onboarding_status = 'complete'
//   └──────────┬─────────────────────┘
//              │
//              v
//   ┌────────────────────────────────┐
//   │  For each workspace:           │
//   │    fire-and-forget POST to     │
//   │    /functions/v1/cron-morning-  │
//   │    scan with { workspace_id }  │
//   └──────────┬─────────────────────┘
//              │
//              v
//   ┌────────────────────────────────┐
//   │  INSERT cron_run_log           │  job_type: 'morning-coordinator'
//   └────────────────────────────────┘

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'

serve(async (_req) => {
  const supabase = getSupabaseClient()
  const startedAt = new Date().toISOString()

  // Create cron_run_log entry
  const { data: runLog, error: runLogError } = await supabase
    .from('cron_run_log')
    .insert({
      job_type: 'morning-coordinator',
      started_at: startedAt,
      status: 'running',
    })
    .select('run_id')
    .single()

  if (runLogError) {
    console.error('[morning-coordinator] Failed to create cron_run_log:', runLogError.message)
  }
  const runId = runLog?.run_id ?? null

  try {
    // 1. Query active workspaces
    const { data: workspaces, error: wsError } = await supabase
      .from('workspaces')
      .select('id')
      .eq('onboarding_status', 'complete')

    if (wsError) {
      console.error('[morning-coordinator] Failed to query workspaces:', wsError.message)
      await finalizeCronLog(supabase, runId, 'failed', 0, 0, { error: wsError.message })
      return new Response(
        JSON.stringify({ error: 'Failed to query workspaces' }),
        { status: 500 }
      )
    }

    if (!workspaces || workspaces.length === 0) {
      console.log('[morning-coordinator] No active workspaces found')
      await finalizeCronLog(supabase, runId, 'success', 0, 0, {
        message: 'No active workspaces',
      })
      return new Response(
        JSON.stringify({ success: true, workspaces_dispatched: 0 }),
        { status: 200 }
      )
    }

    console.log(`[morning-coordinator] Dispatching to ${workspaces.length} workspace(s)`)

    // 2. Fire-and-forget: POST to cron-morning-scan for each workspace
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !serviceRoleKey) {
      const msg = 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
      console.error(`[morning-coordinator] ${msg}`)
      await finalizeCronLog(supabase, runId, 'failed', workspaces.length, 0, { error: msg })
      return new Response(JSON.stringify({ error: msg }), { status: 500 })
    }

    let dispatched = 0
    const errors: Array<{ workspaceId: string; error: string }> = []

    for (const ws of workspaces) {
      try {
        // Fire-and-forget: we don't await the scan result.
        // Each per-workspace function manages its own error handling and logging.
        fetch(`${supabaseUrl}/functions/v1/cron-morning-scan`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ workspace_id: ws.id }),
        }).catch((err) => {
          console.error(
            `[morning-coordinator] Fire-and-forget failed for workspace ${ws.id}:`,
            String(err)
          )
        })

        dispatched++
      } catch (dispatchErr) {
        console.error(
          `[morning-coordinator] Failed to dispatch workspace ${ws.id}:`,
          dispatchErr
        )
        errors.push({ workspaceId: ws.id, error: String(dispatchErr) })
      }
    }

    // 3. Finalize coordinator log
    const finalStatus =
      errors.length === 0
        ? 'success'
        : errors.length < workspaces.length
          ? 'partial_failure'
          : 'failed'

    await finalizeCronLog(supabase, runId, finalStatus, workspaces.length, dispatched, {
      workspaces_total: workspaces.length,
      workspaces_dispatched: dispatched,
      errors: errors.length > 0 ? errors : undefined,
    })

    console.log(
      `[morning-coordinator] Complete: ${dispatched}/${workspaces.length} dispatched, ${errors.length} errors`
    )

    return new Response(
      JSON.stringify({
        success: true,
        workspaces_dispatched: dispatched,
        workspaces_total: workspaces.length,
        errors: errors.length,
      }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[morning-coordinator] Fatal error:', err)
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
    console.error('[morning-coordinator] Failed to finalize cron_run_log:', err)
  }
}
