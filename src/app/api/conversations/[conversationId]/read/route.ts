import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ──────────────────────────────────────────────────────────
// PATCH /api/conversations/:conversationId/read
//
// Marks all inbound messages in the conversation as read.
//
// SQL equivalent:
//   UPDATE messages SET is_read = true
//   WHERE conversation_id = $1
//     AND direction = 'inbound'
//     AND is_read = false
// ──────────────────────────────────────────────────────────
export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const { conversationId } = await params

    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversationId is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const { error, count } = await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('conversation_id', conversationId)
      .eq('direction', 'inbound')
      .eq('is_read', false)

    if (error) {
      console.error('[PATCH /conversations/:id/read]', error.message)
      return NextResponse.json(
        { error: 'Failed to mark messages as read' },
        { status: 500 }
      )
    }

    return NextResponse.json({ updated: count ?? 0 })
  } catch (err) {
    console.error('[PATCH /conversations/:id/read]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
