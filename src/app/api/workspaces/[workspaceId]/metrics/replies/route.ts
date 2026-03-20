import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import {
  daysParam,
  INSUFFICIENT_DATA_THRESHOLD,
  REPLY_PENDING_WINDOW_HOURS,
  type ReplyMetrics,
} from '@/lib/metrics/schemas'

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/metrics/replies?days=30
//
// Returns reply rate metrics for AI-drafted messages:
//   {
//     reply_rate: number (0-1) | null,
//     total_tracked: number,
//     replied: number,
//     median_latency_minutes: number | null,
//     p90_latency_minutes: number | null,
//     pending: number,
//     insufficient_data: boolean
//   }
//
// A signal is "pending" if client_replied IS NULL AND
// the signal was created within the last 72 hours.
// ──────────────────────────────────────────────────────────
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    // Parse & validate days param
    const rawDays = request.nextUrl.searchParams.get('days')
    const parsed = daysParam.safeParse(rawDays ?? undefined)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid days parameter. Must be integer 1-365.' },
        { status: 400 }
      )
    }
    const days = parsed.data

    // Verify the authenticated user belongs to this workspace
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: staffRow } = await authClient
      .from('staff')
      .select('id')
      .eq('id', user.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!staffRow) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    // Only track replies for messages that were actually sent
    // (not discarded/regenerated drafts)
    const { data, error } = await supabase
      .from('draft_edit_signals')
      .select('client_replied, client_reply_latency_minutes, created_at')
      .eq('workspace_id', workspaceId)
      .gte('created_at', cutoff)
      .in('staff_action', ['sent_as_is', 'edited_and_sent'])

    if (error) {
      console.error('[GET /metrics/replies] Query failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to fetch reply metrics' },
        { status: 500 }
      )
    }

    interface SignalRow {
      client_replied: boolean | null
      client_reply_latency_minutes: number | null
      created_at: string
    }

    const signals = (data ?? []) as SignalRow[]
    const metrics = computeReplyMetrics(signals)

    return NextResponse.json(metrics)
  } catch (err) {
    console.error('[GET /metrics/replies]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ─── Pure computation (exported for testing) ──────────────

export function computeReplyMetrics(
  signals: Array<{
    client_replied: boolean | null
    client_reply_latency_minutes: number | null
    created_at: string
  }>,
  now: Date = new Date()
): ReplyMetrics {
  const totalTracked = signals.length
  const insufficientData = totalTracked < INSUFFICIENT_DATA_THRESHOLD

  const pendingCutoff = new Date(
    now.getTime() - REPLY_PENDING_WINDOW_HOURS * 60 * 60 * 1000
  )

  let replied = 0
  let pending = 0
  const latencies: number[] = []

  for (const signal of signals) {
    if (signal.client_replied === true) {
      replied++
      if (signal.client_reply_latency_minutes != null) {
        latencies.push(signal.client_reply_latency_minutes)
      }
    } else if (signal.client_replied == null) {
      // Still within the pending window?
      const createdAt = new Date(signal.created_at)
      if (createdAt >= pendingCutoff) {
        pending++
      }
    }
    // client_replied === false means timed out, not counted as pending
  }

  // Sort latencies for percentile calculations
  latencies.sort((a, b) => a - b)

  return {
    reply_rate: insufficientData ? null : (totalTracked > 0 ? replied / totalTracked : 0),
    total_tracked: totalTracked,
    replied,
    median_latency_minutes: computePercentile(latencies, 0.5),
    p90_latency_minutes: computePercentile(latencies, 0.9),
    pending,
    insufficient_data: insufficientData,
  }
}

/**
 * Compute a percentile value from a sorted array using linear interpolation.
 * Returns null for empty arrays.
 */
export function computePercentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]!

  const index = p * (sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)

  if (lower === upper) return sorted[lower]!

  const fraction = index - lower
  return sorted[lower]! + fraction * (sorted[upper]! - sorted[lower]!)
}
