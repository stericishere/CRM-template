import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/rules
//
// Lists all communication rules for a workspace.
// Ordered by active DESC, confidence DESC.
// Returns { rules: [...] }
// ──────────────────────────────────────────────────────────
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('communication_rules')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('active', { ascending: false })
      .order('confidence', { ascending: false })

    if (error) {
      console.error('[GET /rules] Query failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to fetch rules' },
        { status: 500 }
      )
    }

    return NextResponse.json({ rules: data ?? [] })
  } catch (err) {
    console.error('[GET /rules]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
