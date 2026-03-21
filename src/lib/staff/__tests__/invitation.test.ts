import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateInvitationToken, buildInvitationUrl } from '../invitation'

describe('generateInvitationToken', () => {
  it('returns a 64-character hex string', () => {
    const token = generateInvitationToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unique tokens on each call', () => {
    const a = generateInvitationToken()
    const b = generateInvitationToken()
    expect(a).not.toBe(b)
  })
})

describe('buildInvitationUrl', () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_URL

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_APP_URL = originalEnv
    } else {
      delete process.env.NEXT_PUBLIC_APP_URL
    }
  })

  it('includes the token in the URL', () => {
    const token = 'abc123'
    const url = buildInvitationUrl(token)
    expect(url).toContain(`token=${token}`)
  })

  it('uses NEXT_PUBLIC_APP_URL from env', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://myapp.example.com'
    const url = buildInvitationUrl('tok')
    expect(url).toBe('https://myapp.example.com/api/auth/accept-invitation?token=tok')
  })
})
