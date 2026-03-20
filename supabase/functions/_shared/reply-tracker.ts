import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * On inbound message: find the most recent draft_edit_signal with client_replied=null
 * for this conversation. If found within 72h window: set client_replied=true + latency.
 *
 * Flow:
 *   inbound message received
 *        |
 *        v
 *   SELECT latest signal WHERE client_replied IS NULL
 *   AND conversation_id = current AND created_at > now() - 72h
 *        |
 *        +-- found -> UPDATE client_replied=true, latency=(now - signal.created_at)
 *        |
 *        +-- not found -> no-op
 */
export async function trackReplySignal(
  supabase: SupabaseClient,
  conversationId: string,
  workspaceId: string
): Promise<void> {
  try {
    // Find the most recent pending signal for this conversation.
    // Uses the partial index idx_draft_edit_signals_reply_pending
    // (workspace_id, created_at WHERE client_replied IS NULL).
    //
    // We filter by conversation_id first (direct match), falling back to
    // workspace_id isolation if conversation_id is null on the signal row.
    // Query by conversation_id directly to avoid missing signals when
    // the workspace has many newer pending signals in other conversations
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()
    const { data: signal, error: selectError } = await supabase
      .from('draft_edit_signals')
      .select('id, created_at, conversation_id')
      .eq('workspace_id', workspaceId)
      .eq('conversation_id', conversationId)
      .is('client_replied', null)
      .in('staff_action', ['sent_as_is', 'edited_and_sent'])
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)

    if (selectError) {
      console.error('[reply-tracker] Signal lookup failed:', selectError.message)
      return
    }

    let match = signal?.[0] ?? null

    // Fallback: if no signal matched this conversation, check for signals
    // with null conversation_id (pre-Sprint 4 signals that weren't backfilled)
    if (!match) {
      const { data: fallback } = await supabase
        .from('draft_edit_signals')
        .select('id, created_at, conversation_id')
        .eq('workspace_id', workspaceId)
        .is('conversation_id', null)
        .is('client_replied', null)
        .in('staff_action', ['sent_as_is', 'edited_and_sent'])
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(1)

      match = fallback?.[0] ?? null
    }

    if (!match) {
      return
    }

    // Calculate latency in minutes (signal.created_at -> now)
    const signalCreatedAt = new Date(match.created_at).getTime()
    const latencyMinutes = Math.round((Date.now() - signalCreatedAt) / (1000 * 60))

    const { error: updateError } = await supabase
      .from('draft_edit_signals')
      .update({
        client_replied: true,
        client_reply_latency_minutes: latencyMinutes,
        // Backfill conversation_id if it was null on the signal row
        ...(match.conversation_id === null ? { conversation_id: conversationId } : {}),
      })
      .eq('id', match.id)
      .is('client_replied', null)

    if (updateError) {
      console.error('[reply-tracker] Signal update failed:', updateError.message)
      return
    }

    console.log('[reply-tracker] Signal updated:', {
      signalId: match.id,
      conversationId,
      latencyMinutes,
    })
  } catch (err) {
    // Non-blocking: never throw
    console.error('[reply-tracker] Unexpected error:', err)
  }
}
