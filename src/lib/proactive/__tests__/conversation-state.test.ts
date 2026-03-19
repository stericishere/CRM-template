import { describe, it, expect } from 'vitest'
import { TRANSITION_MAP, getNextState } from '../conversation-state'

describe('ConversationStateMachine', () => {
  describe('getNextState', () => {
    it('should transition idle -> awaiting_staff_review on inbound_message', () => {
      expect(getNextState('idle', 'inbound_message')).toBe('awaiting_staff_review')
    })

    it('should transition awaiting_staff_review -> awaiting_client_reply on staff_sends', () => {
      expect(getNextState('awaiting_staff_review', 'staff_sends')).toBe('awaiting_client_reply')
    })

    it('should transition awaiting_staff_review -> idle on staff_resolves', () => {
      expect(getNextState('awaiting_staff_review', 'staff_resolves')).toBe('idle')
    })

    it('should transition awaiting_client_reply -> idle on client_messages', () => {
      expect(getNextState('awaiting_client_reply', 'client_messages')).toBe('idle')
    })

    it('should transition awaiting_client_reply -> follow_up_pending on timeout_24h', () => {
      expect(getNextState('awaiting_client_reply', 'timeout_24h')).toBe('follow_up_pending')
    })

    it('should transition awaiting_client_reply -> idle on staff_resolves', () => {
      expect(getNextState('awaiting_client_reply', 'staff_resolves')).toBe('idle')
    })

    it('should transition follow_up_pending -> idle on client_messages', () => {
      expect(getNextState('follow_up_pending', 'client_messages')).toBe('idle')
    })

    it('should transition follow_up_pending -> awaiting_client_reply on follow_up_sent', () => {
      expect(getNextState('follow_up_pending', 'follow_up_sent')).toBe('awaiting_client_reply')
    })

    it('should transition follow_up_pending -> idle on staff_resolves', () => {
      expect(getNextState('follow_up_pending', 'staff_resolves')).toBe('idle')
    })

    it('should throw on invalid transition idle + timeout_24h', () => {
      expect(() => getNextState('idle', 'timeout_24h')).toThrow('Invalid transition')
    })

    it('should throw on unknown state', () => {
      expect(() => getNextState('bogus' as any, 'staff_sends')).toThrow('Invalid transition')
    })

    it('should throw on unknown event', () => {
      expect(() => getNextState('idle', 'bogus' as any)).toThrow('Invalid transition')
    })
  })

  describe('TRANSITION_MAP', () => {
    it('should have entries for all 4 states', () => {
      expect(Object.keys(TRANSITION_MAP)).toHaveLength(4)
      expect(TRANSITION_MAP).toHaveProperty('idle')
      expect(TRANSITION_MAP).toHaveProperty('awaiting_staff_review')
      expect(TRANSITION_MAP).toHaveProperty('awaiting_client_reply')
      expect(TRANSITION_MAP).toHaveProperty('follow_up_pending')
    })
  })
})
