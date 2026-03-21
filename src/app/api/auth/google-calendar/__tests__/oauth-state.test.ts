import { describe, it, expect, beforeAll } from 'vitest'

// OAUTH_STATE_SECRET is read at module load time, so set env BEFORE import
process.env.OAUTH_STATE_SECRET = 'test-secret-key-for-hmac-signing'

// eslint-disable-next-line @typescript-eslint/no-require-imports -- must import after env is set
const { signOAuthState, verifyOAuthState } = await import('../route')

describe('OAuth State Signing', () => {
  describe('signOAuthState', () => {
    it('returns a base64url-encoded string', () => {
      const state = signOAuthState({ workspace_id: 'ws-1' })
      expect(state).toBeTypeOf('string')
      // base64url has no +, /, or = padding
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/)
    })

    it('produces unique states for the same payload (nonce)', () => {
      const state1 = signOAuthState({ workspace_id: 'ws-1' })
      const state2 = signOAuthState({ workspace_id: 'ws-1' })
      expect(state1).not.toBe(state2)
    })
  })

  describe('verifyOAuthState', () => {
    it('round-trips: sign then verify returns original payload', () => {
      const state = signOAuthState({ workspace_id: 'ws-1' })!
      const result = verifyOAuthState(state)
      expect(result).not.toBeNull()
      expect(result!.workspace_id).toBe('ws-1')
    })

    it('preserves all original keys in the payload', () => {
      const state = signOAuthState({ workspace_id: 'ws-1', extra: 'data' })!
      const result = verifyOAuthState(state)
      expect(result!.workspace_id).toBe('ws-1')
      expect(result!.extra).toBe('data')
    })

    it('returns null for tampered state', () => {
      const state = signOAuthState({ workspace_id: 'ws-1' })!
      // Flip one character
      const tampered = state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A')
      expect(verifyOAuthState(tampered)).toBeNull()
    })

    it('returns null for completely invalid input', () => {
      expect(verifyOAuthState('not-valid-base64url')).toBeNull()
    })

    it('returns null for valid JSON missing signature field', () => {
      const noSig = Buffer.from(JSON.stringify({ data: '{}' })).toString('base64url')
      expect(verifyOAuthState(noSig)).toBeNull()
    })

    it('includes a nonce in the verified payload', () => {
      const state = signOAuthState({ workspace_id: 'ws-1' })!
      const result = verifyOAuthState(state)
      expect(result!.nonce).toBeDefined()
      expect(typeof result!.nonce).toBe('string')
    })
  })
})
