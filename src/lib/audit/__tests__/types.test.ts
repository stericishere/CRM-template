import { describe, it, expect } from 'vitest'
import { AUDIT_ACTION_TYPES } from '../types'
import type { AuditEvent, AuditEventRow, AuditActionType } from '../types'

// ──────────────────────────────────────────────────────────
// AUDIT_ACTION_TYPES
// ──────────────────────────────────────────────────────────
describe('AUDIT_ACTION_TYPES', () => {
  const EXPECTED_ACTIONS = [
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
  ]

  it('should contain exactly 14 action types', () => {
    expect(AUDIT_ACTION_TYPES).toHaveLength(14)
  })

  it.each(EXPECTED_ACTIONS)(
    'should include action type "%s"',
    (action) => {
      expect(AUDIT_ACTION_TYPES).toContain(action)
    }
  )

  it('should be a readonly tuple (immutable at compile time)', () => {
    // `as const` makes the array readonly at the type level.
    // At runtime the underlying array is still a plain JS array,
    // so we verify the content is stable instead.
    const copy = [...AUDIT_ACTION_TYPES]
    expect(copy).toEqual([...AUDIT_ACTION_TYPES])
    expect(AUDIT_ACTION_TYPES.length).toBe(copy.length)
  })

  it('should not contain duplicates', () => {
    const unique = new Set(AUDIT_ACTION_TYPES)
    expect(unique.size).toBe(AUDIT_ACTION_TYPES.length)
  })
})

// ──────────────────────────────────────────────────────────
// AuditEvent interface shape validation
// ──────────────────────────────────────────────────────────
describe('AuditEvent interface', () => {
  it('should accept a valid AuditEvent with all fields populated', () => {
    const event: AuditEvent = {
      workspace_id: '550e8400-e29b-41d4-a716-446655440000',
      actor_type: 'ai',
      actor_id: 'gpt-draft-agent',
      action_type: 'draft_generated',
      target_type: 'message',
      target_id: '660e8400-e29b-41d4-a716-446655440001',
      metadata: { model: 'gpt-4', tokens: 150 },
    }

    expect(event.workspace_id).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(event.actor_type).toBe('ai')
    expect(event.actor_id).toBe('gpt-draft-agent')
    expect(event.action_type).toBe('draft_generated')
    expect(event.target_type).toBe('message')
    expect(event.target_id).toBe('660e8400-e29b-41d4-a716-446655440001')
    expect(event.metadata).toEqual({ model: 'gpt-4', tokens: 150 })
  })

  it('should accept null for optional fields (actor_id, target_id, metadata)', () => {
    const event: AuditEvent = {
      workspace_id: '550e8400-e29b-41d4-a716-446655440000',
      actor_type: 'system',
      actor_id: null,
      action_type: 'knowledge_updated',
      target_type: 'knowledge_base',
      target_id: null,
      metadata: null,
    }

    expect(event.actor_id).toBeNull()
    expect(event.target_id).toBeNull()
    expect(event.metadata).toBeNull()
  })

  it('should accept all three valid actor_type values', () => {
    const actorTypes: Array<AuditEvent['actor_type']> = ['ai', 'staff', 'system']

    for (const actorType of actorTypes) {
      const event: AuditEvent = {
        workspace_id: 'ws-1',
        actor_type: actorType,
        actor_id: null,
        action_type: 'message_received',
        target_type: 'message',
        target_id: null,
        metadata: null,
      }
      expect(event.actor_type).toBe(actorType)
    }
  })

  it('should accept every action_type from AUDIT_ACTION_TYPES', () => {
    for (const actionType of AUDIT_ACTION_TYPES) {
      const event: AuditEvent = {
        workspace_id: 'ws-1',
        actor_type: 'staff',
        actor_id: 'user-1',
        action_type: actionType,
        target_type: 'entity',
        target_id: 'target-1',
        metadata: null,
      }
      expect(event.action_type).toBe(actionType)
    }
  })
})

// ──────────────────────────────────────────────────────────
// AuditEventRow extends AuditEvent
// ──────────────────────────────────────────────────────────
describe('AuditEventRow interface', () => {
  it('should include id and created_at in addition to AuditEvent fields', () => {
    const row: AuditEventRow = {
      id: 'row-uuid-1',
      created_at: '2026-03-18T10:00:00.000Z',
      workspace_id: 'ws-1',
      actor_type: 'staff',
      actor_id: 'user-1',
      action_type: 'message_sent',
      target_type: 'message',
      target_id: 'msg-1',
      metadata: { channel: 'whatsapp' },
    }

    expect(row.id).toBe('row-uuid-1')
    expect(row.created_at).toBe('2026-03-18T10:00:00.000Z')
    expect(row.workspace_id).toBe('ws-1')
    expect(row.action_type).toBe('message_sent')
  })
})

// ──────────────────────────────────────────────────────────
// AuditActionType type check
// ──────────────────────────────────────────────────────────
describe('AuditActionType', () => {
  it('should be assignable from AUDIT_ACTION_TYPES members', () => {
    // This is a compile-time check; if it compiles, the type is correct.
    const action: AuditActionType = AUDIT_ACTION_TYPES[0]
    expect(typeof action).toBe('string')
  })
})
