// supabase/functions/cron-morning-coordinator/index.ts
// Fan-out coordinator for the morning scan.
// Triggered by pg_cron at 9 AM HK (01:00 UTC).
//
//   ┌────────────────────────────────┐
//   │  Query active workspaces       │  onboarding_status = 'complete'
//   └──────────┬─────────────────────┘
//              │
//              v
//   ┌────────────────────────────────┐
//   │  For each workspace:           │
//   │    POST to cron-morning-scan   │
//   │    with { workspace_id }       │
//   └──────────┬─────────────────────┘
//              │
//              v
//   ┌────────────────────────────────┐
//   │  UPDATE cron_run_log           │  job_type: 'morning-coordinator'
//   └────────────────────────────────┘

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { fanOutToWorkspaces } from '../_shared/cron-helpers.ts'

serve(async () => {
  await fanOutToWorkspaces('cron-morning-scan', 'morning-coordinator', '[morning-coordinator]')
  return new Response(JSON.stringify({ success: true }), { status: 200 })
})
