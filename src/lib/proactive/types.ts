// src/lib/proactive/types.ts
// Next.js-side type definitions for proactive operations

export type ConversationState =
  | 'idle'
  | 'awaiting_staff_review'
  | 'awaiting_client_reply'
  | 'follow_up_pending'

export type ConversationEvent =
  | 'inbound_message'
  | 'staff_sends'
  | 'staff_resolves'
  | 'client_messages'
  | 'timeout_24h'
  | 'follow_up_sent'

export type TimerType = 'stale_conversation' | 'draft_review_nudge'

export type TransitionTriggerSource =
  | 'timer'
  | 'morning_scan'
  | 'staff_action'
  | 'inbound_message'
