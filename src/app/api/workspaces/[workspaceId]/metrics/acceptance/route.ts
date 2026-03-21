import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'
import {
  daysParam,
  STAFF_ACTIONS,
  INSUFFICIENT_DATA_THRESHOLD,
  type StaffAction,
  type AcceptanceMetrics,
} from '@/lib/metrics/schemas'

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/metrics/acceptance?days=30
//
// Returns acceptance rate metrics for AI-drafted messages:
//   {
//     acceptance_rate: number (0-1) | null,
//     total_signals: number,
//     by_action: { sent_as_is, edited_and_sent, regenerated, discarded },
//     by_scenario: Record<string, { total, accepted, rate }>,
//     insufficient_data: boolean
//   }
//
// "Accepted" = sent_as_is OR edited_and_sent
// insufficient_data = true when total_signals < 10
// ──────────────────────────────────────────────────────────
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    // Verify the authenticated user is an active member of this workspace
    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('draft_edit_signals')
      .select('staff_action, scenario_type')
      .eq('workspace_id', workspaceId)
      .gte('created_at', cutoff)

    if (error) {
      console.error('[GET /metrics/acceptance] Query failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to fetch acceptance metrics' },
        { status: 500 }
      )
    }

    interface SignalRow {
      staff_action: string
      scenario_type: string
    }

    const signals = (data ?? []) as SignalRow[]
    const metrics = computeAcceptanceMetrics(signals)

    return NextResponse.json(metrics)
  } catch (err) {
    console.error('[GET /metrics/acceptance]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ─── Pure computation (exported for testing) ──────────────

export function computeAcceptanceMetrics(
  signals: Array<{ staff_action: string; scenario_type: string }>
): AcceptanceMetrics {
  const totalSignals = signals.length
  const insufficientData = totalSignals < INSUFFICIENT_DATA_THRESHOLD

  // Count by action
  const byAction: Record<StaffAction, number> = {
    sent_as_is: 0,
    edited_and_sent: 0,
    regenerated: 0,
    discarded: 0,
  }

  // Count by scenario
  const scenarioMap = new Map<string, { total: number; accepted: number }>()

  for (const signal of signals) {
    const action = signal.staff_action as StaffAction
    if (action in byAction) {
      byAction[action]++
    }

    const scenario = signal.scenario_type ?? 'unclassified'
    let entry = scenarioMap.get(scenario)
    if (!entry) {
      entry = { total: 0, accepted: 0 }
      scenarioMap.set(scenario, entry)
    }
    entry.total++
    if (action === 'sent_as_is' || action === 'edited_and_sent') {
      entry.accepted++
    }
  }

  // Build by_scenario with rates
  const byScenario: Record<string, { total: number; accepted: number; rate: number }> = {}
  for (const [scenario, counts] of scenarioMap) {
    byScenario[scenario] = {
      ...counts,
      rate: counts.total > 0 ? counts.accepted / counts.total : 0,
    }
  }

  const accepted = byAction.sent_as_is + byAction.edited_and_sent

  return {
    acceptance_rate: insufficientData ? null : accepted / totalSignals,
    total_signals: totalSignals,
    by_action: byAction,
    by_scenario: byScenario,
    insufficient_data: insufficientData,
  }
}
