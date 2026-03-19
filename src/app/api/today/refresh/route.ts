import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

const RATE_LIMIT_SECONDS = 5 * 60 // 5 minutes

// ──────────────────────────────────────────────────────────
// POST /api/today/refresh
//
// Body: { workspace_id }
//
// Rate-limited: 1 per 5 min per workspace.
// Checks cron_run_log for last morning-scan run, returns
// { error: 'Rate limited', retry_after_seconds } if too soon.
//
// On success, invokes cron-morning-coordinator Edge Function
// and returns { status: 'refreshing' }.
//
// Flow:
//   ┌────────────────────────────┐
//   │  Parse workspace_id       │
//   └──────────┬─────────────────┘
//              │
//              v
//   ┌────────────────────────────┐
//   │  Check cron_run_log for    │
//   │  last run within 5 min    │
//   └──────────┬─────────────────┘
//              │
//    ┌─────────┴──────────┐
//    │ recent?            │
//    ├─ yes ─> 429 rate   │
//    └─ no  ─> invoke EF  │
// ──────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const workspaceId = (body as Record<string, unknown>)?.workspace_id
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return NextResponse.json(
        { error: 'workspace_id is required' },
        { status: 400 }
      )
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error('[POST /today/refresh] Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars')
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    // ── Rate limit check ──────────────────────────────────
    const cutoff = new Date(Date.now() - RATE_LIMIT_SECONDS * 1000).toISOString()

    const { data: recentRun, error: logError } = await supabase
      .from('cron_run_log')
      .select('started_at')
      .eq('workspace_id', workspaceId)
      .eq('job_type', 'morning-scan')
      .gte('started_at', cutoff)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (logError) {
      console.error('[POST /today/refresh] Rate limit check failed:', logError.message)
      // Fail open — allow the refresh if we can't check the log
    }

    if (recentRun) {
      const lastRunAt = new Date(recentRun.started_at as string).getTime()
      const retryAfterSeconds = Math.ceil(
        RATE_LIMIT_SECONDS - (Date.now() - lastRunAt) / 1000
      )
      return NextResponse.json(
        { error: 'Rate limited', retry_after_seconds: Math.max(retryAfterSeconds, 1) },
        { status: 429 }
      )
    }

    // ── Invoke Edge Function ──────────────────────────────
    // Use cron-morning-scan directly (per-workspace), NOT the coordinator
    // which fans out to ALL workspaces
    const efUrl = `${SUPABASE_URL}/functions/v1/cron-morning-scan`

    const efResponse = await fetch(efUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspace_id: workspaceId }),
    })

    if (!efResponse.ok) {
      const text = await efResponse.text().catch(() => 'unknown')
      console.error(
        `[POST /today/refresh] Edge Function returned ${efResponse.status}: ${text}`
      )
      return NextResponse.json(
        { error: 'Failed to trigger refresh' },
        { status: 502 }
      )
    }

    return NextResponse.json({ status: 'refreshing' })
  } catch (err) {
    console.error('[POST /today/refresh]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
