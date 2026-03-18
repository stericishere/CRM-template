// Shared types for Edge Functions
// These mirror the database schema but are defined manually
// (not imported from the generated types since Edge Functions use Deno)

export interface InboundMessagePayload {
  message_id: string
  workspace_id: string
  client_id: string
  conversation_id: string
  phone: string
  content: string | null
  media_type: string | null
  wamid: string
}

export interface Client {
  id: string
  workspace_id: string
  full_name: string | null
  phone: string
  email: string | null
  lifecycle_status: LifecycleStatus
  tags: string[]
  preferences: Record<string, unknown>
  summary: string | null
  last_contacted_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type LifecycleStatus =
  | 'open'
  | 'chosen_service'
  | 'upcoming_appointment'
  | 'follow_up'
  | 'review_complete'
  | 'inactive'

export interface Conversation {
  id: string
  workspace_id: string
  client_id: string
  state: string
  last_message_at: string | null
  last_client_message_at: string | null
  created_at: string
}

export interface Message {
  id: string
  conversation_id: string
  workspace_id: string
  direction: 'inbound' | 'outbound'
  content: string | null
  media_type: string | null
  media_url: string | null
  media_transcription: string | null
  sender_type: 'client' | 'staff' | 'system'
  delivery_status: 'sent' | 'delivered' | 'read' | 'failed'
  wamid: string | null
  draft_id: string | null
  is_read: boolean
  created_at: string
}

export interface AuditEvent {
  workspace_id: string
  actor_type: 'ai' | 'staff' | 'system'
  actor_id: string | null
  action_type: AuditActionType
  target_type: string
  target_id: string | null
  metadata: Record<string, unknown> | null
}

export type AuditActionType =
  | 'message_received'
  | 'draft_generated'
  | 'message_sent'
  | 'client_updated'
  | 'booking_created'
  | 'booking_cancelled'
  | 'note_added'
  | 'followup_created'
  | 'followup_completed'
  | 'draft_regenerated'
  | 'client_merged'
  | 'knowledge_updated'
  | 'sop_updated'
  | 'lifecycle_status_updated'

// Re-export Sprint 2 types (F-05, F-06, F-10)
export type {
  GlobalContext,
  MessageContext,
  ReadOnlyContext,
  ClientWorkerResult,
  ProposedAction,
  ApprovalTier,
  StaffAction,
  DraftEditSignalInput,
} from './sprint2-types.ts'
