import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ──────────────────────────────────────────────────────────
// GET /api/notifications/unread-count?workspace_id=...
//
// Returns per-conversation unread counts for inbound messages.
//
// Response:
//   { conversations: [{ conversation_id, unread_count, last_message_at }] }
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

    const supabase = await createClient()

    // Query unread inbound messages grouped by conversation
    //
    // SQL equivalent:
    //   SELECT conversation_id,
    //          COUNT(id) as unread_count,
    //          MAX(created_at) as last_message_at
    //   FROM messages
    //   WHERE workspace_id = $1
    //     AND direction = 'inbound'
    //     AND is_read = false
    //   GROUP BY conversation_id
    //   ORDER BY last_message_at DESC
    const { data, error } = await supabase.rpc('get_unread_counts', {
      p_workspace_id: workspaceId,
    })

    if (error) {
      // Fallback: if the RPC doesn't exist, do a client-side approach
      // fetching raw messages and aggregating
      console.error('[GET /notifications/unread-count] rpc error, using fallback', error.message)

      const { data: messages, error: fallbackError } = await supabase
        .from('messages')
        .select('conversation_id, created_at')
        .eq('workspace_id', workspaceId)
        .eq('direction', 'inbound')
        .eq('is_read', false)
        .order('created_at', { ascending: false })
        .limit(5000) // Safety cap to prevent unbounded memory usage

      if (fallbackError) {
        console.error('[GET /notifications/unread-count] fallback error', fallbackError.message)
        return NextResponse.json(
          { error: 'Failed to fetch unread counts' },
          { status: 500 }
        )
      }

      // Aggregate client-side
      const grouped = new Map<string, { count: number; lastAt: string }>()
      for (const msg of messages ?? []) {
        const convId = msg.conversation_id as string
        const createdAt = msg.created_at as string
        const existing = grouped.get(convId)
        if (existing) {
          existing.count += 1
          if (createdAt > existing.lastAt) {
            existing.lastAt = createdAt
          }
        } else {
          grouped.set(convId, { count: 1, lastAt: createdAt })
        }
      }

      const conversations = Array.from(grouped.entries())
        .map(([conversation_id, { count, lastAt }]) => ({
          conversation_id,
          unread_count: count,
          last_message_at: lastAt,
        }))
        .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))

      return NextResponse.json({ conversations })
    }

    // RPC returns the grouped result directly
    const conversations = (data as Array<{
      conversation_id: string
      unread_count: number
      last_message_at: string
    }>) ?? []

    return NextResponse.json({ conversations })
  } catch (err) {
    console.error('[GET /notifications/unread-count]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
