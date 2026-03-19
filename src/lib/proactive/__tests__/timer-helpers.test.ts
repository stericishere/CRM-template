import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase
const mockRpc = vi.fn()
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    rpc: mockRpc,
  }),
}))

import { bestEffortStartTimer, bestEffortCancelTimer } from '../timer-helpers'

describe('TimerHelpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRpc.mockResolvedValue({ error: null })
  })

  describe('bestEffortStartTimer', () => {
    it('should call create_or_reset_timer RPC with correct params', async () => {
      await bestEffortStartTimer(
        'ws-1', 'stale_conversation', 'conversation', 'conv-1', 86400000
      )

      expect(mockRpc).toHaveBeenCalledWith('create_or_reset_timer', {
        p_workspace_id: 'ws-1',
        p_timer_type: 'stale_conversation',
        p_target_entity: 'conversation',
        p_target_id: 'conv-1',
        p_trigger_at: expect.any(String),
        p_payload: null,
      })
    })

    it('should not throw when RPC fails', async () => {
      mockRpc.mockRejectedValue(new Error('DB down'))
      await expect(
        bestEffortStartTimer('ws-1', 'stale_conversation', 'conversation', 'conv-1', 86400000)
      ).resolves.not.toThrow()
    })

    it('should pass payload when provided', async () => {
      await bestEffortStartTimer(
        'ws-1', 'draft_review_nudge', 'draft', 'd-1', 3600000, { draftId: 'd-1' }
      )
      expect(mockRpc).toHaveBeenCalledWith('create_or_reset_timer', expect.objectContaining({
        p_payload: { draftId: 'd-1' },
      }))
    })

    it('should compute trigger_at as ISO string in the future', async () => {
      const before = Date.now()
      await bestEffortStartTimer(
        'ws-1', 'stale_conversation', 'conversation', 'conv-1', 86400000
      )
      const after = Date.now()

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const triggerAt = mockRpc.mock.calls[0]![1].p_trigger_at as string
      const triggerTime = new Date(triggerAt).getTime()

      // trigger_at should be ~24h from now (within test execution window)
      expect(triggerTime).toBeGreaterThanOrEqual(before + 86400000)
      expect(triggerTime).toBeLessThanOrEqual(after + 86400000)
    })

    it('should not throw when RPC returns error object', async () => {
      mockRpc.mockResolvedValue({ error: { message: 'constraint violation' } })
      await expect(
        bestEffortStartTimer('ws-1', 'stale_conversation', 'conversation', 'conv-1', 86400000)
      ).resolves.not.toThrow()
    })
  })

  describe('bestEffortCancelTimer', () => {
    it('should call cancel_timer RPC with correct params', async () => {
      await bestEffortCancelTimer('conv-1', 'stale_conversation', 'client_messaged')
      expect(mockRpc).toHaveBeenCalledWith('cancel_timer', {
        p_target_id: 'conv-1',
        p_timer_type: 'stale_conversation',
        p_reason: 'client_messaged',
      })
    })

    it('should not throw when RPC fails', async () => {
      mockRpc.mockRejectedValue(new Error('DB down'))
      await expect(
        bestEffortCancelTimer('conv-1', 'stale_conversation', 'client_messaged')
      ).resolves.not.toThrow()
    })

    it('should not throw when RPC returns error object', async () => {
      mockRpc.mockResolvedValue({ error: { message: 'not found' } })
      await expect(
        bestEffortCancelTimer('conv-1', 'stale_conversation', 'client_messaged')
      ).resolves.not.toThrow()
    })
  })
})
