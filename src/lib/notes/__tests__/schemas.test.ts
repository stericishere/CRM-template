import { describe, it, expect } from 'vitest'
import {
  createNoteSchema,
  createFollowUpSchema,
  patchFollowUpSchema,
  createKnowledgeSchema,
  patchKnowledgeSchema,
  mergeClientsSchema,
} from '../schemas'

describe('createNoteSchema', () => {
  it('should accept valid note', () => {
    const result = createNoteSchema.safeParse({
      client_id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Client prefers morning appointments',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.source).toBe('manual')
    }
  })

  it('should accept ai_extracted source', () => {
    const result = createNoteSchema.safeParse({
      client_id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Detected allergy mention',
      source: 'ai_extracted',
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty content', () => {
    const result = createNoteSchema.safeParse({
      client_id: '550e8400-e29b-41d4-a716-446655440000',
      content: '',
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid uuid', () => {
    const result = createNoteSchema.safeParse({
      client_id: 'not-a-uuid',
      content: 'Test note',
    })
    expect(result.success).toBe(false)
  })
})

describe('createFollowUpSchema', () => {
  it('should accept valid follow-up', () => {
    const result = createFollowUpSchema.safeParse({
      client_id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Check in about treatment',
      due_date: '2026-03-25',
    })
    expect(result.success).toBe(true)
  })

  it('should accept without due_date', () => {
    const result = createFollowUpSchema.safeParse({
      client_id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Follow up on pricing',
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid date format', () => {
    const result = createFollowUpSchema.safeParse({
      client_id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Follow up',
      due_date: 'March 25, 2026',
    })
    expect(result.success).toBe(false)
  })
})

describe('patchFollowUpSchema', () => {
  it('should accept status update', () => {
    const result = patchFollowUpSchema.safeParse({ status: 'completed' })
    expect(result.success).toBe(true)
  })

  it('should accept content update', () => {
    const result = patchFollowUpSchema.safeParse({ content: 'Updated content' })
    expect(result.success).toBe(true)
  })

  it('should accept null due_date', () => {
    const result = patchFollowUpSchema.safeParse({ due_date: null })
    expect(result.success).toBe(true)
  })

  it('should reject invalid status', () => {
    const result = patchFollowUpSchema.safeParse({ status: 'invalid' })
    expect(result.success).toBe(false)
  })
})

describe('createKnowledgeSchema', () => {
  it('should accept valid knowledge chunk', () => {
    const result = createKnowledgeSchema.safeParse({
      content: 'We offer Swedish massage at $80/hour',
      source: 'services_page',
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty source', () => {
    const result = createKnowledgeSchema.safeParse({
      content: 'Some knowledge',
      source: '',
    })
    expect(result.success).toBe(false)
  })
})

describe('patchKnowledgeSchema', () => {
  it('should accept content update', () => {
    const result = patchKnowledgeSchema.safeParse({
      content: 'Updated knowledge content',
    })
    expect(result.success).toBe(true)
  })
})

describe('mergeClientsSchema', () => {
  it('should accept valid merge', () => {
    const result = mergeClientsSchema.safeParse({
      source_client_id: '550e8400-e29b-41d4-a716-446655440000',
      target_client_id: '660e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(true)
  })

  it('should reject same source and target', () => {
    const result = mergeClientsSchema.safeParse({
      source_client_id: '550e8400-e29b-41d4-a716-446655440000',
      target_client_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(false)
  })

  it('should reject non-uuid', () => {
    const result = mergeClientsSchema.safeParse({
      source_client_id: 'abc',
      target_client_id: 'def',
    })
    expect(result.success).toBe(false)
  })
})
