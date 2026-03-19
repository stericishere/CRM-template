import { describe, it, expect } from 'vitest'

import { computeAcceptanceMetrics } from '@/app/api/workspaces/[workspaceId]/metrics/acceptance/route'
import { computeReplyMetrics, computePercentile } from '@/app/api/workspaces/[workspaceId]/metrics/replies/route'

// ─── Acceptance rate ──────────────────────────────────────

describe('computeAcceptanceMetrics', () => {
  it('should return insufficient_data when fewer than 10 signals', () => {
    const signals = [
      { staff_action: 'sent_as_is', scenario_type: 'greeting' },
      { staff_action: 'discarded', scenario_type: 'greeting' },
    ]

    const result = computeAcceptanceMetrics(signals)

    expect(result.insufficient_data).toBe(true)
    expect(result.acceptance_rate).toBeNull()
    expect(result.total_signals).toBe(2)
    // by_action counts should still be populated
    expect(result.by_action.sent_as_is).toBe(1)
    expect(result.by_action.discarded).toBe(1)
  })

  it('should compute correct acceptance rate with sufficient data', () => {
    // 6 accepted (sent_as_is + edited_and_sent) out of 12 total = 0.5
    const signals = [
      ...Array.from({ length: 3 }, () => ({ staff_action: 'sent_as_is', scenario_type: 'inquiry' })),
      ...Array.from({ length: 3 }, () => ({ staff_action: 'edited_and_sent', scenario_type: 'inquiry' })),
      ...Array.from({ length: 4 }, () => ({ staff_action: 'discarded', scenario_type: 'follow_up' })),
      ...Array.from({ length: 2 }, () => ({ staff_action: 'regenerated', scenario_type: 'inquiry' })),
    ]

    const result = computeAcceptanceMetrics(signals)

    expect(result.insufficient_data).toBe(false)
    expect(result.acceptance_rate).toBe(0.5)
    expect(result.total_signals).toBe(12)
    expect(result.by_action).toEqual({
      sent_as_is: 3,
      edited_and_sent: 3,
      regenerated: 2,
      discarded: 4,
    })
  })

  it('should break down rates by scenario', () => {
    const signals = [
      ...Array.from({ length: 8 }, () => ({ staff_action: 'sent_as_is', scenario_type: 'inquiry' })),
      ...Array.from({ length: 2 }, () => ({ staff_action: 'discarded', scenario_type: 'inquiry' })),
      ...Array.from({ length: 1 }, () => ({ staff_action: 'sent_as_is', scenario_type: 'booking' })),
      ...Array.from({ length: 3 }, () => ({ staff_action: 'discarded', scenario_type: 'booking' })),
    ]

    const result = computeAcceptanceMetrics(signals)

    expect(result.by_scenario.inquiry).toEqual({
      total: 10,
      accepted: 8,
      rate: 0.8,
    })
    expect(result.by_scenario.booking).toEqual({
      total: 4,
      accepted: 1,
      rate: 0.25,
    })
  })

  it('should handle all accepted signals', () => {
    const signals = Array.from({ length: 15 }, () => ({
      staff_action: 'sent_as_is',
      scenario_type: 'general',
    }))

    const result = computeAcceptanceMetrics(signals)

    expect(result.acceptance_rate).toBe(1)
    expect(result.insufficient_data).toBe(false)
  })

  it('should handle all discarded signals', () => {
    const signals = Array.from({ length: 10 }, () => ({
      staff_action: 'discarded',
      scenario_type: 'general',
    }))

    const result = computeAcceptanceMetrics(signals)

    expect(result.acceptance_rate).toBe(0)
    expect(result.insufficient_data).toBe(false)
  })

  it('should handle empty signals array', () => {
    const result = computeAcceptanceMetrics([])

    expect(result.insufficient_data).toBe(true)
    expect(result.acceptance_rate).toBeNull()
    expect(result.total_signals).toBe(0)
    expect(result.by_action).toEqual({
      sent_as_is: 0,
      edited_and_sent: 0,
      regenerated: 0,
      discarded: 0,
    })
    expect(result.by_scenario).toEqual({})
  })

  it('should treat missing scenario_type as unclassified', () => {
    const signals = Array.from({ length: 10 }, () => ({
      staff_action: 'sent_as_is',
      scenario_type: undefined as unknown as string,
    }))

    const result = computeAcceptanceMetrics(signals)

    expect(result.by_scenario.unclassified).toBeDefined()
    expect(result.by_scenario.unclassified!.total).toBe(10)
  })
})

// ─── Reply rate ───────────────────────────────────────────

describe('computeReplyMetrics', () => {
  const now = new Date('2026-03-20T12:00:00Z')

  it('should return insufficient_data when fewer than 10 signals', () => {
    const signals = [
      { client_replied: true, client_reply_latency_minutes: 30, created_at: '2026-03-19T10:00:00Z' },
    ]

    const result = computeReplyMetrics(signals, now)

    expect(result.insufficient_data).toBe(true)
    expect(result.reply_rate).toBeNull()
    expect(result.total_tracked).toBe(1)
    expect(result.replied).toBe(1)
  })

  it('should compute correct reply rate with sufficient data', () => {
    // 6 replied, 4 not replied (false = timed out)
    const signals = [
      ...Array.from({ length: 6 }, () => ({
        client_replied: true,
        client_reply_latency_minutes: 60,
        created_at: '2026-03-19T10:00:00Z',
      })),
      ...Array.from({ length: 4 }, () => ({
        client_replied: false as boolean | null,
        client_reply_latency_minutes: null,
        created_at: '2026-03-15T10:00:00Z',
      })),
    ]

    const result = computeReplyMetrics(signals, now)

    expect(result.insufficient_data).toBe(false)
    expect(result.reply_rate).toBe(0.6)
    expect(result.total_tracked).toBe(10)
    expect(result.replied).toBe(6)
  })

  it('should count pending signals within 72h window', () => {
    const signals = [
      // Pending (null reply, created within 72h)
      ...Array.from({ length: 3 }, () => ({
        client_replied: null,
        client_reply_latency_minutes: null,
        created_at: '2026-03-19T10:00:00Z', // ~26h ago, within 72h
      })),
      // Timed out (null reply, created >72h ago)
      ...Array.from({ length: 2 }, () => ({
        client_replied: null,
        client_reply_latency_minutes: null,
        created_at: '2026-03-10T10:00:00Z', // >72h ago
      })),
      // Replied
      ...Array.from({ length: 7 }, () => ({
        client_replied: true as boolean | null,
        client_reply_latency_minutes: 45,
        created_at: '2026-03-18T10:00:00Z',
      })),
    ]

    const result = computeReplyMetrics(signals, now)

    expect(result.pending).toBe(3)
    expect(result.replied).toBe(7)
    expect(result.total_tracked).toBe(12)
  })

  it('should compute median latency correctly with odd count', () => {
    const signals = [
      { client_replied: true, client_reply_latency_minutes: 10, created_at: '2026-03-19T10:00:00Z' },
      { client_replied: true, client_reply_latency_minutes: 20, created_at: '2026-03-19T10:00:00Z' },
      { client_replied: true, client_reply_latency_minutes: 30, created_at: '2026-03-19T10:00:00Z' },
      { client_replied: true, client_reply_latency_minutes: 40, created_at: '2026-03-19T10:00:00Z' },
      { client_replied: true, client_reply_latency_minutes: 50, created_at: '2026-03-19T10:00:00Z' },
      ...Array.from({ length: 5 }, () => ({
        client_replied: false as boolean | null,
        client_reply_latency_minutes: null,
        created_at: '2026-03-15T10:00:00Z',
      })),
    ]

    const result = computeReplyMetrics(signals, now)

    // Median of [10, 20, 30, 40, 50] = 30
    expect(result.median_latency_minutes).toBe(30)
  })

  it('should compute median latency correctly with even count', () => {
    const signals = [
      { client_replied: true, client_reply_latency_minutes: 10, created_at: '2026-03-19T10:00:00Z' },
      { client_replied: true, client_reply_latency_minutes: 20, created_at: '2026-03-19T10:00:00Z' },
      { client_replied: true, client_reply_latency_minutes: 30, created_at: '2026-03-19T10:00:00Z' },
      { client_replied: true, client_reply_latency_minutes: 40, created_at: '2026-03-19T10:00:00Z' },
      ...Array.from({ length: 6 }, () => ({
        client_replied: false as boolean | null,
        client_reply_latency_minutes: null,
        created_at: '2026-03-15T10:00:00Z',
      })),
    ]

    const result = computeReplyMetrics(signals, now)

    // Median of [10, 20, 30, 40]: index = 0.5 * 3 = 1.5 -> interpolate 20 + 0.5*(30-20) = 25
    expect(result.median_latency_minutes).toBe(25)
  })

  it('should compute p90 latency correctly', () => {
    // 10 replied signals with known latencies
    const latencies = [5, 10, 15, 20, 25, 30, 35, 40, 45, 100]
    const signals = latencies.map((lat) => ({
      client_replied: true as boolean | null,
      client_reply_latency_minutes: lat,
      created_at: '2026-03-19T10:00:00Z',
    }))

    const result = computeReplyMetrics(signals, now)

    // p90 of [5, 10, 15, 20, 25, 30, 35, 40, 45, 100]
    // index = 0.9 * 9 = 8.1 -> 45 + 0.1 * (100 - 45) = 45 + 5.5 = 50.5
    expect(result.p90_latency_minutes).toBeCloseTo(50.5)
  })

  it('should return null latencies when no replies', () => {
    const signals = Array.from({ length: 10 }, () => ({
      client_replied: false as boolean | null,
      client_reply_latency_minutes: null,
      created_at: '2026-03-15T10:00:00Z',
    }))

    const result = computeReplyMetrics(signals, now)

    expect(result.median_latency_minutes).toBeNull()
    expect(result.p90_latency_minutes).toBeNull()
    expect(result.replied).toBe(0)
  })

  it('should handle empty signals array', () => {
    const result = computeReplyMetrics([], now)

    expect(result.insufficient_data).toBe(true)
    expect(result.reply_rate).toBeNull()
    expect(result.total_tracked).toBe(0)
    expect(result.replied).toBe(0)
    expect(result.pending).toBe(0)
    expect(result.median_latency_minutes).toBeNull()
    expect(result.p90_latency_minutes).toBeNull()
  })
})

// ─── computePercentile ───────────────────────────────────

describe('computePercentile', () => {
  it('should return null for empty array', () => {
    expect(computePercentile([], 0.5)).toBeNull()
  })

  it('should return the single element for single-element array', () => {
    expect(computePercentile([42], 0.5)).toBe(42)
    expect(computePercentile([42], 0.9)).toBe(42)
  })

  it('should return exact value when percentile lands on index', () => {
    // [10, 20, 30]: p50 -> index = 0.5 * 2 = 1.0 -> 20
    expect(computePercentile([10, 20, 30], 0.5)).toBe(20)
  })

  it('should interpolate between values', () => {
    // [10, 20]: p50 -> index = 0.5 * 1 = 0.5 -> 10 + 0.5*(20-10) = 15
    expect(computePercentile([10, 20], 0.5)).toBe(15)
  })

  it('should return first element for p0', () => {
    expect(computePercentile([10, 20, 30], 0)).toBe(10)
  })

  it('should return last element for p100', () => {
    expect(computePercentile([10, 20, 30], 1)).toBe(30)
  })

  it('should handle p90 with 10 elements', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    // p90: index = 0.9 * 9 = 8.1 -> 9 + 0.1*(10-9) = 9.1
    expect(computePercentile(sorted, 0.9)).toBeCloseTo(9.1)
  })
})
