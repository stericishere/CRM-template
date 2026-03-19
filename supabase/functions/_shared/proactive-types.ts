// supabase/functions/_shared/proactive-types.ts
// Types for proactive operations (Pattern A + B)

// ─── Conversation State Machine ──────────────────────────

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

export type TransitionTriggerSource =
  | 'timer'
  | 'morning_scan'
  | 'staff_action'
  | 'inbound_message'

// ─── Timer Types ─────────────────────────────────────────

export type TimerType = 'stale_conversation' | 'draft_review_nudge'

export type TimerStatus = 'pending' | 'fired' | 'cancelled' | 'error'

export interface PendingTimer {
  timer_id: string
  workspace_id: string
  timer_type: TimerType
  trigger_at: string
  status: TimerStatus
  target_entity: string
  target_id: string
  payload: Record<string, unknown> | null
  created_at: string
  fired_at: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  error_details: Record<string, unknown> | null
}

// ─── Morning Scan Types ──────────────────────────────────

export interface ScanConfig {
  candidates: Array<{
    clientId: string
    conversationId: string
    [key: string]: unknown
  }>
  proposalType: string
  reason: string
  tier: 'auto' | 'review' | 'human_only'
  metadata?: Record<string, unknown>
}

export interface ScanResult {
  found: number
  actioned: number
}

export interface CronRunLog {
  run_id: string
  workspace_id: string | null
  job_type: string
  started_at: string
  completed_at: string | null
  status: 'running' | 'success' | 'partial_failure' | 'failed'
  items_found: number
  items_actioned: number
  error_details: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}

// ─── Daily Journal Types ─────────────────────────────────

export interface DailyJournalStats {
  clients_interacted: number
  new_clients: number
  messages_inbound: number
  messages_outbound: number
  drafts_generated: number
  drafts_sent_as_is: number
  drafts_edited: number
  drafts_discarded: number
  bookings_created: number
  bookings_cancelled: number
  bookings_completed: number
  follow_ups_sent: number
  follow_ups_dismissed: number
  clients_marked_inactive: number
}

export interface LearningSnapshot {
  acceptance_rate_today: number
  common_edit_categories: string[]
  new_patterns_detected: string[]
  rules_promoted_today: string[]
}

export interface DailyJournal {
  journal_id: string
  workspace_id: string
  date: string
  stats: DailyJournalStats
  narrative: string | null
  learning_snapshot: LearningSnapshot | null
  alerts: string[] | null
  created_at: string
}

// ─── Staff Notification Types ────────────────────────────

export interface StaffNotification {
  notification_id: string
  workspace_id: string
  type: string
  title: string
  body: string | null
  metadata: Record<string, unknown> | null
  read_at: string | null
  created_at: string
}
