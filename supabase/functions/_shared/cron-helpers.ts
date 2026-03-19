// supabase/functions/_shared/cron-helpers.ts
// DRY helpers for cron Edge Functions: run log management + fan-out coordinator pattern.

import { getSupabaseClient } from './db.ts'

/**
 * Create a cron_run_log entry with status='running'.
 * Returns the run_id (or null if insert fails).
 */
export async function createCronRunLog(
  jobType: string,
  workspaceId?: string
): Promise<string | null> {
  const supabase = getSupabaseClient()
  try {
    const { data } = await supabase
      .from('cron_run_log')
      .insert({
        job_type: jobType,
        workspace_id: workspaceId ?? null,
        status: 'running',
      })
      .select('run_id')
      .single()
    return data?.run_id ?? null
  } catch (err) {
    console.error(`[${jobType}] Failed to create cron_run_log:`, err)
    return null
  }
}

/**
 * Finalize (update) an existing cron_run_log entry with completion details.
 * No-op if runId is null.
 */
export async function finalizeCronRunLog(
  runId: string | null,
  status: 'success' | 'partial_failure' | 'failed',
  itemsFound: number,
  itemsActioned: number,
  metadata: Record<string, unknown>,
  errorDetails?: Record<string, unknown> | null
): Promise<void> {
  if (!runId) return
  const supabase = getSupabaseClient()
  try {
    await supabase
      .from('cron_run_log')
      .update({
        completed_at: new Date().toISOString(),
        status,
        items_found: itemsFound,
        items_actioned: itemsActioned,
        metadata,
        error_details: errorDetails ?? null,
      })
      .eq('run_id', runId)
  } catch (err) {
    console.error(`[cron] Failed to finalize cron_run_log ${runId}:`, err)
  }
}

/**
 * Fan-out coordinator pattern: query active workspaces and dispatch
 * a POST to the target Edge Function for each one.
 *
 * Used by cron-morning-coordinator and cron-compaction-coordinator.
 */
export async function fanOutToWorkspaces(
  targetFunctionName: string,
  jobType: string,
  logPrefix: string
): Promise<void> {
  const supabase = getSupabaseClient()
  const runId = await createCronRunLog(jobType)

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id')
    .eq('onboarding_status', 'complete')

  if (error || !workspaces) {
    await finalizeCronRunLog(runId, 'failed', 0, 0, { error: error?.message })
    return
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const dispatched = await Promise.allSettled(
    workspaces.map(ws =>
      fetch(`${supabaseUrl}/functions/v1/${targetFunctionName}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspace_id: ws.id }),
      })
    )
  )

  const succeeded = dispatched.filter(r => r.status === 'fulfilled').length
  console.log(`${logPrefix} Dispatched ${succeeded}/${workspaces.length} workspace jobs`)

  await finalizeCronRunLog(runId, 'success', workspaces.length, succeeded, {
    total_workspaces: workspaces.length,
    dispatched: succeeded,
  })
}
