import { NextRequest, NextResponse } from 'next/server'
import { patchRuleSchema } from '@/lib/rules/schemas'
import { getServiceClient } from '@/lib/supabase/service'
import { assertWorkspaceMember } from '@/lib/supabase/assert-workspace-member'

type RouteParams = { params: Promise<{ workspaceId: string; ruleId: string }> }

// ──────────────────────────────────────────────────────────
// PATCH /api/workspaces/:workspaceId/rules/:ruleId
//
// Body: { instruction?, active? }
// Updates rule instruction text and/or active status.
// Scoped by workspace_id AND rule id.
// Returns { rule: {...} }
// ──────────────────────────────────────────────────────────
export async function PATCH(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { workspaceId, ruleId } = await params

    const auth = await assertWorkspaceMember(workspaceId)
    if (auth instanceof NextResponse) return auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = patchRuleSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    // Build update payload from validated fields
    const updates: Record<string, unknown> = {}
    if (parsed.data.instruction !== undefined) {
      updates.instruction = parsed.data.instruction
    }
    if (parsed.data.active !== undefined) {
      updates.active = parsed.data.active
    }
    updates.updated_at = new Date().toISOString()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('communication_rules')
      .update(updates)
      .eq('id', ruleId)
      .eq('workspace_id', workspaceId)
      .select('*')
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
      }
      console.error('[PATCH /rules/:id]', error.message)
      return NextResponse.json(
        { error: 'Failed to update rule' },
        { status: 500 }
      )
    }

    return NextResponse.json({ rule: data })
  } catch (err) {
    console.error('[PATCH /rules/:id]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
