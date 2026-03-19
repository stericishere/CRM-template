import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'

// ──────────────────────────────────────────────────────────
// GET /api/today?workspace_id=xxx
//
// Returns today's dashboard view:
//   {
//     date: string,
//     bookings: Array<{ id, client_name, appointment_type, start_time, end_time, status }>,
//     action_items: Array<{ id, action_type, summary, urgency_score, rank, client_name }>,
//     stats: { pending_actions, overdue_follow_ups, unread_messages }
//   }
//
// Data flow:
//   ┌─────────────────────┐
//   │  Parse workspace_id │
//   └────────┬────────────┘
//            │
//            v
//   ┌─────────────────────────────────┐
//   │  3 parallel queries:            │
//   │  1. bookings (today, joined)    │
//   │  2. proposed_actions (pending)  │
//   │  3. stats (counts)             │
//   └────────┬────────────────────────┘
//            │
//            v
//   ┌─────────────────────┐
//   │  Return composite   │
//   └─────────────────────┘
// ──────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const workspaceId = request.nextUrl.searchParams.get('workspace_id')
    if (!workspaceId) {
      return NextResponse.json(
        { error: 'workspace_id query parameter is required' },
        { status: 400 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    const todayStart = getTodayBounds()

    // Run all 3 queries in parallel for speed
    const [bookingsResult, actionsResult, statsResult] = await Promise.all([
      fetchTodayBookings(supabase, workspaceId, todayStart),
      fetchPendingActions(supabase, workspaceId),
      fetchStats(supabase, workspaceId),
    ])

    if (bookingsResult.error) {
      console.error('[GET /today] Bookings query failed:', bookingsResult.error)
      return NextResponse.json(
        { error: 'Failed to fetch today bookings' },
        { status: 500 }
      )
    }

    if (actionsResult.error) {
      console.error('[GET /today] Actions query failed:', actionsResult.error)
      return NextResponse.json(
        { error: 'Failed to fetch action items' },
        { status: 500 }
      )
    }

    if (statsResult.error) {
      console.error('[GET /today] Stats query failed:', statsResult.error)
      return NextResponse.json(
        { error: 'Failed to fetch stats' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      date: todayStart.dateStr,
      bookings: bookingsResult.data,
      action_items: actionsResult.data,
      stats: statsResult.data,
    })
  } catch (err) {
    console.error('[GET /today]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ─── Helpers ──────────────────────────────────────────────

interface TodayBounds {
  dateStr: string
  startISO: string
  endISO: string
}

function getTodayBounds(): TodayBounds {
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  return {
    dateStr,
    startISO: `${dateStr}T00:00:00.000Z`,
    endISO: `${dateStr}T23:59:59.999Z`,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
async function fetchTodayBookings(supabase: any, workspaceId: string, today: TodayBounds) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, appointment_type, start_time, end_time, status, client_id, clients(name)')
    .eq('workspace_id', workspaceId)
    .gte('start_time', today.startISO)
    .lte('start_time', today.endISO)
    .order('start_time', { ascending: true })

  if (error) return { data: null, error }

  // Flatten the join: clients(name) -> client_name
  interface BookingRow {
    id: string
    appointment_type: string
    start_time: string
    end_time: string
    status: string
    client_id: string
    clients: { name: string } | null
  }

  const bookings = (data as BookingRow[]).map((b) => ({
    id: b.id,
    client_name: b.clients?.name ?? 'Unknown',
    appointment_type: b.appointment_type,
    start_time: b.start_time,
    end_time: b.end_time,
    status: b.status,
  }))

  return { data: bookings, error: null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
async function fetchPendingActions(supabase: any, workspaceId: string) {
  const { data, error } = await supabase
    .from('proposed_actions')
    .select('id, action_type, summary, urgency_score, rank, client_id, clients(name)')
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .order('urgency_score', { ascending: false, nullsFirst: false })
    .order('rank', { ascending: true, nullsFirst: false })

  if (error) return { data: null, error }

  interface ActionRow {
    id: string
    action_type: string
    summary: string
    urgency_score: number | null
    rank: number | null
    client_id: string
    clients: { name: string } | null
  }

  const actions = (data as ActionRow[]).map((a) => ({
    id: a.id,
    action_type: a.action_type,
    summary: a.summary,
    urgency_score: a.urgency_score,
    rank: a.rank,
    client_name: a.clients?.name ?? 'Unknown',
  }))

  return { data: actions, error: null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
async function fetchStats(supabase: any, workspaceId: string) {
  // 3 count queries in parallel
  const [pendingActions, overdueFollowUps, unreadMessages] = await Promise.all([
    supabase
      .from('proposed_actions')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending'),

    supabase
      .from('follow_ups')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'open')
      .lt('due_date', new Date().toISOString().slice(0, 10)),

    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('direction', 'inbound')
      .eq('is_read', false),
  ])

  // Check for errors on any count query
  const firstError = pendingActions.error ?? overdueFollowUps.error ?? unreadMessages.error
  if (firstError) return { data: null, error: firstError }

  return {
    data: {
      pending_actions: pendingActions.count ?? 0,
      overdue_follow_ups: overdueFollowUps.count ?? 0,
      unread_messages: unreadMessages.count ?? 0,
    },
    error: null,
  }
}
