import { describe, it, expect } from 'vitest'
import {
  lifecycleStatusSchema,
  e164Schema,
  clientPatchSchema,
  createClientSchema,
  LIFECYCLE_STATUSES,
} from '../types'

// ──────────────────────────────────────────────────────────
// lifecycleStatusSchema
// ──────────────────────────────────────────────────────────
describe('lifecycleStatusSchema', () => {
  it.each(LIFECYCLE_STATUSES)('should accept valid status "%s"', (status) => {
    const result = lifecycleStatusSchema.safeParse(status)
    expect(result.success).toBe(true)
  })

  it('should reject an invalid status', () => {
    const result = lifecycleStatusSchema.safeParse('nonexistent')
    expect(result.success).toBe(false)
  })

  it('should reject an empty string', () => {
    const result = lifecycleStatusSchema.safeParse('')
    expect(result.success).toBe(false)
  })

  it('should reject a number', () => {
    const result = lifecycleStatusSchema.safeParse(42)
    expect(result.success).toBe(false)
  })

  it('should reject null', () => {
    const result = lifecycleStatusSchema.safeParse(null)
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// e164Schema
// ──────────────────────────────────────────────────────────
describe('e164Schema', () => {
  it('should accept a valid HK number "+85291234567"', () => {
    const result = e164Schema.safeParse('+85291234567')
    expect(result.success).toBe(true)
  })

  it('should accept a valid US number "+14155551234"', () => {
    const result = e164Schema.safeParse('+14155551234')
    expect(result.success).toBe(true)
  })

  it('should accept the minimum length "+12345678" (8 digits after +)', () => {
    const result = e164Schema.safeParse('+12345678')
    expect(result.success).toBe(true)
  })

  it('should accept the maximum length "+123456789012345" (15 digits after +)', () => {
    const result = e164Schema.safeParse('+123456789012345')
    expect(result.success).toBe(true)
  })

  it('should reject a local number without "+" prefix: "091234567"', () => {
    const result = e164Schema.safeParse('091234567')
    expect(result.success).toBe(false)
  })

  it('should reject an empty string', () => {
    const result = e164Schema.safeParse('')
    expect(result.success).toBe(false)
  })

  it('should reject "+0123" (leading zero after +)', () => {
    const result = e164Schema.safeParse('+0123')
    expect(result.success).toBe(false)
  })

  it('should reject a number that is too short "+1234567" (7 digits)', () => {
    const result = e164Schema.safeParse('+1234567')
    expect(result.success).toBe(false)
  })

  it('should reject a number that is too long "+1234567890123456" (16 digits)', () => {
    const result = e164Schema.safeParse('+1234567890123456')
    expect(result.success).toBe(false)
  })

  it('should reject a number with spaces', () => {
    const result = e164Schema.safeParse('+852 9123 4567')
    expect(result.success).toBe(false)
  })

  it('should reject a number with dashes', () => {
    const result = e164Schema.safeParse('+1-415-555-1234')
    expect(result.success).toBe(false)
  })

  it('should reject a non-string value', () => {
    const result = e164Schema.safeParse(85291234567)
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// clientPatchSchema
// ──────────────────────────────────────────────────────────
describe('clientPatchSchema', () => {
  it('should accept a valid full patch', () => {
    const result = clientPatchSchema.safeParse({
      full_name: 'Jane Doe',
      email: 'jane@example.com',
      tags: ['vip', 'returning'],
      preferences: { language: 'en', notifications: true },
    })
    expect(result.success).toBe(true)
  })

  it('should accept an empty object (all fields optional)', () => {
    const result = clientPatchSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should accept a patch with only full_name', () => {
    const result = clientPatchSchema.safeParse({ full_name: 'John' })
    expect(result.success).toBe(true)
  })

  it('should accept a patch with only tags', () => {
    const result = clientPatchSchema.safeParse({ tags: ['new'] })
    expect(result.success).toBe(true)
  })

  it('should reject full_name that is empty string', () => {
    const result = clientPatchSchema.safeParse({ full_name: '' })
    expect(result.success).toBe(false)
  })

  it('should reject full_name longer than 200 characters', () => {
    const result = clientPatchSchema.safeParse({ full_name: 'a'.repeat(201) })
    expect(result.success).toBe(false)
  })

  it('should reject an invalid email', () => {
    const result = clientPatchSchema.safeParse({ email: 'not-an-email' })
    expect(result.success).toBe(false)
  })

  it('should reject tags that is not an array', () => {
    const result = clientPatchSchema.safeParse({ tags: 'vip' })
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// createClientSchema
// ──────────────────────────────────────────────────────────
describe('createClientSchema', () => {
  it('should accept a valid phone only', () => {
    const result = createClientSchema.safeParse({ phone: '+85291234567' })
    expect(result.success).toBe(true)
  })

  it('should accept phone with optional full_name and email', () => {
    const result = createClientSchema.safeParse({
      phone: '+14155551234',
      full_name: 'Alice',
      email: 'alice@example.com',
    })
    expect(result.success).toBe(true)
  })

  it('should reject when phone is missing', () => {
    const result = createClientSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('should reject when phone is invalid', () => {
    const result = createClientSchema.safeParse({ phone: '091234567' })
    expect(result.success).toBe(false)
  })

  it('should reject when email is invalid', () => {
    const result = createClientSchema.safeParse({
      phone: '+85291234567',
      email: 'bad',
    })
    expect(result.success).toBe(false)
  })

  it('should reject when full_name is empty string', () => {
    const result = createClientSchema.safeParse({
      phone: '+85291234567',
      full_name: '',
    })
    expect(result.success).toBe(false)
  })

  it('should reject when full_name exceeds 200 characters', () => {
    const result = createClientSchema.safeParse({
      phone: '+85291234567',
      full_name: 'x'.repeat(201),
    })
    expect(result.success).toBe(false)
  })
})
