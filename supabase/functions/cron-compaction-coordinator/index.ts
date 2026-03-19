// supabase/functions/cron-compaction-coordinator/index.ts
// Fan-out coordinator for daily memory compaction.
// Triggered by pg_cron at 3 AM HK (19:00 UTC).
//
//   ┌────────────────────────────────┐
//   │  Query active workspaces       │  onboarding_status = 'complete'
//   └──────────┬─────────────────────┘
//              │
//              v
//   ┌────────────────────────────────┐
//   │  For each workspace:           │
//   │    POST to cron-compaction     │
//   │    with { workspace_id }       │
//   └──────────┬─────────────────────┘
//              │
//              v
//   ┌────────────────────────────────┐
//   │  UPDATE cron_run_log           │  job_type: 'compaction-coordinator'
//   └────────────────────────────────┘

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { fanOutToWorkspaces } from '../_shared/cron-helpers.ts'

serve(async () => {
  await fanOutToWorkspaces('cron-compaction', 'compaction-coordinator', '[compaction-coordinator]')
  return new Response(JSON.stringify({ success: true }), { status: 200 })
})
