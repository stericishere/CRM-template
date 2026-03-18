export const AUDIT_ACTION_TYPES = [
  'message_received',
  'draft_generated',
  'message_sent',
  'client_updated',
  'lifecycle_status_updated',
  'booking_created',
  'booking_cancelled',
  'note_added',
  'followup_created',
  'followup_completed',
  'draft_regenerated',
  'client_merged',
  'knowledge_updated',
  'sop_updated',
] as const

export type AuditActionType = (typeof AUDIT_ACTION_TYPES)[number]

export interface AuditEvent {
  workspace_id: string
  actor_type: 'ai' | 'staff' | 'system'
  actor_id: string | null
  action_type: AuditActionType
  target_type: string
  target_id: string | null
  metadata: Record<string, unknown> | null
}

export interface AuditEventRow extends AuditEvent {
  id: string
  created_at: string
}
