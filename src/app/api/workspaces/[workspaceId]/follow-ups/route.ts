import { NextRequest, NextResponse } from 'next/server'
import { createFollowUpSchema, FOLLOW_UP_STATUSES } from '@/lib/notes/schemas'
import type { FollowUpStatus } from '@/lib/notes/schemas'
import { getServiceClient } from '@/lib/supabase/service'

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/follow-ups
//
// Query params:
//   client_id — filter by client (optional)
//   status    — filter by status: open | completed | cancelled
//               or virtual filter 'active' which returns:
//               status=open OR (status=completed AND created_at > now()-7d)
// ──────────────────────────────────────────────────────────
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params
    const url = request.nextUrl
    const clientId = url.searchParams.get('client_id')
    const statusFilter = url.searchParams.get('status')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    let query = supabase
      .from('follow_ups')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })

    if (clientId) {
      query = query.eq('client_id', clientId)
    }

    if (statusFilter === 'active') {
      // Virtual filter: open OR (completed in last 7 days)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      query = query.or(`status.eq.open,and(status.eq.completed,created_at.gte.${sevenDaysAgo})`)
    } else if (statusFilter) {
      // Validate status value
      if (!(FOLLOW_UP_STATUSES as readonly string[]).includes(statusFilter)) {
        return NextResponse.json(
          { error: `Invalid status. Must be one of: ${FOLLOW_UP_STATUSES.join(', ')}, active` },
          { status: 400 }
        )
      }
      query = query.eq('status', statusFilter as FollowUpStatus)
    }

    const { data, error } = await query

    if (error) {
      console.error('[GET /follow-ups] Query failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to fetch follow-ups' },
        { status: 500 }
      )
    }

    return NextResponse.json({ data: data ?? [] })
  } catch (err) {
    console.error('[GET /follow-ups]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// POST /api/workspaces/:workspaceId/follow-ups
//
// Body: { client_id, content, due_date? }
// ──────────────────────────────────────────────────────────
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createFollowUpSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const { data, error } = await supabase
      .from('follow_ups')
      .insert({
        workspace_id: workspaceId,
        client_id: parsed.data.client_id,
        content: parsed.data.content,
        due_date: parsed.data.due_date ?? null,
      })
      .select('*')
      .single()

    if (error) {
      console.error('[POST /follow-ups] Insert failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to create follow-up' },
        { status: 500 }
      )
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('[POST /follow-ups]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
