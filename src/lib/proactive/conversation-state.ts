// src/lib/proactive/conversation-state.ts
// Pure conversation state machine logic (Next.js side)
//
// State diagram (4 states, 9 transitions):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │                                                              │
//   │  ┌──────┐  inbound_message   ┌───────────────────────┐      │
//   │  │ idle │ ─────────────────> │ awaiting_staff_review  │      │
//   │  └──────┘                    └───────────────────────┘      │
//   │    ^ ^ ^                       │ staff_sends  │ staff_      │
//   │    │ │ │                       v              │ resolves    │
//   │    │ │ │                    ┌──────────────────v──┐          │
//   │    │ │ └─ client_messages ─ │ awaiting_client_reply│          │
//   │    │ │    staff_resolves    └─────────────────────┘          │
//   │    │ │                        │ timeout_24h                  │
//   │    │ │                        v                              │
//   │    │ │                    ┌──────────────────┐               │
//   │    │ └─ client_messages ─ │ follow_up_pending │               │
//   │    └─── staff_resolves    └──────────────────┘               │
//   │                              │ follow_up_sent                │
//   │                              └──> awaiting_client_reply      │
//   └──────────────────────────────────────────────────────────────┘
//

import type { ConversationState, ConversationEvent } from './types'

export type { ConversationState, ConversationEvent }

/**
 * Complete transition map: state -> event -> next_state
 * 4 states, 9 transitions total (including 3 staff_resolves shortcuts)
 */
export const TRANSITION_MAP: Record<string, Record<string, string>> = {
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
export function getNextState(
  currentState: string,
  event: string
): string {
  const nextState = TRANSITION_MAP[currentState]?.[event]
  if (!nextState) {
    throw new Error(
      `Invalid transition: state="${currentState}" event="${event}"`
    )
  }
  return nextState
}
