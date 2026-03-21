import { describe, it, expect } from 'vitest'
import {
  staffRoleSchema,
  staffStatusSchema,
  inviteStaffSchema,
  updateStaffSchema,
} from '../schemas'

describe('inviteStaffSchema', () => {
  it('accepts valid input', () => {
    const result = inviteStaffSchema.safeParse({
      email: 'jane@example.com',
      full_name: 'Jane Doe',
      role: 'admin',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing email', () => {
    const result = inviteStaffSchema.safeParse({
      full_name: 'Jane Doe',
      role: 'admin',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid email format', () => {
    const result = inviteStaffSchema.safeParse({
      email: 'not-an-email',
      full_name: 'Jane Doe',
      role: 'admin',
    })
    expect(result.success).toBe(false)
  })

  it('rejects role="owner"', () => {
    const result = inviteStaffSchema.safeParse({
      email: 'jane@example.com',
      full_name: 'Jane Doe',
      role: 'owner',
    })
    expect(result.success).toBe(false)
  })

  it('accepts role="admin"', () => {
    const result = inviteStaffSchema.safeParse({
      email: 'jane@example.com',
      full_name: 'Jane Doe',
      role: 'admin',
    })
    expect(result.success).toBe(true)
  })

  it('accepts role="member"', () => {
    const result = inviteStaffSchema.safeParse({
      email: 'jane@example.com',
      full_name: 'Jane Doe',
      role: 'member',
    })
    expect(result.success).toBe(true)
  })
})

describe('updateStaffSchema', () => {
  it('accepts partial updates (role only)', () => {
    const result = updateStaffSchema.safeParse({ role: 'admin' })
    expect(result.success).toBe(true)
  })

  it('accepts partial updates (status only)', () => {
    const result = updateStaffSchema.safeParse({ status: 'removed' })
    expect(result.success).toBe(true)
  })

  it('rejects empty update (no fields)', () => {
    const result = updateStaffSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('staffRoleSchema', () => {
  it.each(['owner', 'admin', 'member'] as const)('validates "%s"', (role) => {
    const result = staffRoleSchema.safeParse(role)
    expect(result.success).toBe(true)
  })

  it('rejects unknown roles', () => {
    const result = staffRoleSchema.safeParse('superadmin')
    expect(result.success).toBe(false)
  })
})

describe('staffStatusSchema', () => {
  it.each(['active', 'invited', 'removed'] as const)('validates "%s"', (status) => {
    const result = staffStatusSchema.safeParse(status)
    expect(result.success).toBe(true)
  })
})
