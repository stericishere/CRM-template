// supabase/functions/_shared/conversation-state.ts
// Conversation state machine with DB transition + audit trail (Edge Function version)
//
// State diagram (4 states, 9 transitions):
//
//   idle ──inbound_message──> awaiting_staff_review
//   awaiting_staff_review ──staff_sends──> awaiting_client_reply
//   awaiting_staff_review ──staff_resolves──> idle
//   awaiting_client_reply ──client_messages──> idle
//   awaiting_client_reply ──timeout_24h──> follow_up_pending
//   awaiting_client_reply ──staff_resolves──> idle
//   follow_up_pending ──client_messages──> idle
//   follow_up_pending ──follow_up_sent──> awaiting_client_reply
//   follow_up_pending ──staff_resolves──> idle

import type {
  ConversationState,
  ConversationEvent,
  TransitionTriggerSource,
} from './proactive-types.ts'
import { getSupabaseClient } from './db.ts'

export type { ConversationState, ConversationEvent, TransitionTriggerSource }

/**
 * Complete transition map: state -> event -> next_state
 */
export const TRANSITION_MAP: Record<ConversationState, Partial<Record<ConversationEvent, ConversationState>>> = {
  idle: {
    inbound_message: 'awaiting_staff_review',
  },
  awaiting_staff_review: {
    staff_sends: 'awaiting_client_reply',
    staff_resolves: 'idle',
  },
  awaiting_client_reply: {
    client_messages: 'idle',
    timeout_24h: 'follow_up_pending',
    staff_resolves: 'idle',
  },
  follow_up_pending: {
    client_messages: 'idle',
    follow_up_sent: 'awaiting_client_reply',
    staff_resolves: 'idle',
  },
}

/**
 * Returns the next state for a given (currentState, event) pair.
 * Throws if the transition is not in TRANSITION_MAP.
 */
export function getNextState(currentState: ConversationState, event: ConversationEvent): ConversationState {
  const nextState = TRANSITION_MAP[currentState]?.[event]
  if (!nextState) {
    throw new Error(
      `Invalid transition: state="${currentState}" event="${event}"`
    )
  }
  return nextState
}

/**
 * Atomically transitions a conversation's state and writes an audit event.
 *
 * 1. Fetches current conversation state + workspace_id
 * 2. Validates the transition via getNextState() (throws on invalid)
 * 3. UPDATEs conversations.state
 * 4. INSERTs audit_events with transition metadata
 *
 * @throws Error if conversation not found or transition is invalid
 */
export async function transitionConversation(
  conversationId: string,
  event: ConversationEvent,
  triggerSource: TransitionTriggerSource
): Promise<void> {
  const supabase = getSupabaseClient()

  // 1. Fetch current state
  const { data: conv, error: fetchError } = await supabase
    .from('conversations')
    .select('state, workspace_id')
    .eq('id', conversationId)
    .single()

  if (fetchError || !conv) {
    throw new Error(`Conversation ${conversationId} not found`)
  }

  // 2. Validate + compute next state (throws on invalid)
  const nextState = getNextState(conv.state, event)

  // 3. Update conversation state (optimistic lock: only if state hasn't changed)
  const { error: updateError, count: updatedRows } = await supabase
    .from('conversations')
    .update({ state: nextState })
    .eq('id', conversationId)
    .eq('state', conv.state)

  if (updateError) {
    throw new Error(
      `Failed to update conversation state: ${updateError.message}`
    )
  }

  if (updatedRows === 0) {
    throw new Error(
      `Optimistic lock failed: conversation ${conversationId} state changed concurrently`
    )
  }

  // 4. Write audit event (fire-and-log, non-blocking on audit failure)
  await supabase
    .from('audit_events')
    .insert({
      workspace_id: conv.workspace_id,
      actor_type: 'system',
      action_type: 'conversation_state_transition',
      target_type: 'conversation',
      target_id: conversationId,
      metadata: {
        from_state: conv.state,
        to_state: nextState,
        event,
        trigger_source: triggerSource,
      },
    })
    .then(({ error }) => {
      if (error) console.error('[state] Audit event failed:', error)
    })
}
