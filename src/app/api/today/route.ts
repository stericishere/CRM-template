import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { createClient } from '@/lib/supabase/server'

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

    // Fetch workspace timezone for day-boundary calculation
    const { data: wsData } = await supabase
      .from('workspaces')
      .select('timezone')
      .eq('id', workspaceId)
      .single()
    const wsTimezone = (wsData as { timezone?: string } | null)?.timezone ?? 'UTC'

    const todayStart = getTodayBounds(wsTimezone)

    // Run all 3 queries in parallel for speed
    const [bookingsResult, actionsResult, statsResult] = await Promise.all([
      fetchTodayBookings(supabase, workspaceId, todayStart),
      fetchPendingActions(supabase, workspaceId),
      fetchStats(supabase, workspaceId, todayStart.dateStr),
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

function getTodayBounds(timezone?: string): TodayBounds {
  const tz = timezone ?? 'UTC'

  // Get today's date string in the workspace's timezone
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const dateStr = dateFmt.format(new Date())

  // To handle DST correctly, we compute the UTC offset AT local midnight
  // (not at the current time). We do this by formatting a known UTC instant
  // (midnight of the local date in UTC) through the timezone formatter,
  // then measuring how the hour/day shifted.
  //
  //  Example: Asia/Hong_Kong is UTC+8, no DST
  //    dateStr = "2026-03-20"
  //    probe = 2026-03-20T00:00:00Z
  //    formatted in HKT = 2026-03-20 08:00 → offset = +8h
  //    local midnight in UTC = 2026-03-19T16:00:00Z
  //
  //  Example: America/New_York on a DST spring-forward day
  //    dateStr = "2026-03-08" (DST starts 2am)
  //    probe = 2026-03-08T00:00:00Z
  //    formatted in ET = 2026-03-07 19:00 → offset = -5h (EST, pre-DST)
  //    local midnight in UTC = 2026-03-08T05:00:00Z (correct: midnight EST)
  //
  const probe = new Date(`${dateStr}T00:00:00Z`)
  const probeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = probeFmt.formatToParts(probe)
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10)

  // Compute offset by reconstructing the local time as a UTC timestamp
  // and comparing to the actual UTC timestamp of the probe.
  // This avoids day-of-month comparison which breaks on month boundaries.
  const localYear = get('year')
  const localMonth = get('month') - 1
  const localDay = get('day')
  const localHour = get('hour')
  const localMinute = get('minute')

  // Interpret the formatted local time as if it were UTC
  const localAsUtcMs = Date.UTC(localYear, localMonth, localDay, localHour, localMinute, 0)
  // The difference is the timezone offset
  const totalOffsetMs = localAsUtcMs - probe.getTime()

  // Local midnight in UTC = probe (dateStr midnight UTC) - offset
  const startMs = probe.getTime() - totalOffsetMs
  const endMs = startMs + 24 * 60 * 60 * 1000 - 1

  return {
    dateStr,
    startISO: new Date(startMs).toISOString(),
    endISO: new Date(endMs).toISOString(),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
async function fetchTodayBookings(supabase: any, workspaceId: string, today: TodayBounds) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, appointment_type, start_time, end_time, status, client_id, clients(full_name)')
    .eq('workspace_id', workspaceId)
    .gte('start_time', today.startISO)
    .lte('start_time', today.endISO)
    .order('start_time', { ascending: true })

  if (error) return { data: null, error }

  // Flatten the join: clients(full_name) -> client_name
  interface BookingRow {
    id: string
    appointment_type: string
    start_time: string
    end_time: string
    status: string
    client_id: string
    clients: { full_name: string | null } | null
  }

  const bookings = (data as BookingRow[]).map((b) => ({
    id: b.id,
    client_name: b.clients?.full_name ?? 'Unknown',
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
    .select('id, action_type, summary, urgency_score, rank, client_id, clients(full_name)')
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
    clients: { full_name: string | null } | null
  }

  const actions = (data as ActionRow[]).map((a) => ({
    id: a.id,
    action_type: a.action_type,
    summary: a.summary,
    urgency_score: a.urgency_score,
    rank: a.rank,
    client_name: a.clients?.full_name ?? 'Unknown',
  }))

  return { data: actions, error: null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
async function fetchStats(supabase: any, workspaceId: string, todayDateStr?: string) {
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
      .lt('due_date', todayDateStr ?? new Date().toISOString().slice(0, 10)),

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
