import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'

type RouteParams = { params: Promise<{ workspaceId: string; ruleId: string }> }

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/rules/:ruleId/details
//
// Fetches rule + source pattern recurrence + up to 5 recent
// edit examples. Three parallel queries:
//   1. communication_rules row
//   2. pattern_recurrences row matching source_pattern_key
//   3. draft_edit_signals matching pattern_key
//      (edited_and_sent, limit 5, newest first)
//
// Returns { rule, pattern, recent_edits }
// ──────────────────────────────────────────────────────────
export async function GET(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, ruleId } = await params

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    // 1. Fetch the rule first to get source_pattern_key
    const { data: rule, error: ruleError } = await supabase
      .from('communication_rules')
      .select('*')
      .eq('id', ruleId)
      .eq('workspace_id', workspaceId)
      .single()

    if (ruleError) {
      if (ruleError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
      }
      console.error('[GET /rules/:id/details] Rule query failed:', ruleError.message)
      return NextResponse.json(
        { error: 'Failed to fetch rule' },
        { status: 500 }
      )
    }

    // 2 & 3. Parallel queries using source_pattern_key
    const [patternResult, editsResult] = await Promise.all([
      supabase
        .from('pattern_recurrences')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('pattern_key', rule.source_pattern_key)
        .maybeSingle(),

      supabase
        .from('draft_edit_signals')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('pattern_key', rule.source_pattern_key)
        .eq('staff_action', 'edited_and_sent')
        .order('created_at', { ascending: false })
        .limit(5),
    ])

    if (patternResult.error) {
      console.error('[GET /rules/:id/details] Pattern query failed:', patternResult.error.message)
    }

    if (editsResult.error) {
      console.error('[GET /rules/:id/details] Edits query failed:', editsResult.error.message)
    }

    return NextResponse.json({
      rule,
      pattern: patternResult.data ?? null,
      recent_edits: editsResult.data ?? [],
    })
  } catch (err) {
    console.error('[GET /rules/:id/details]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
