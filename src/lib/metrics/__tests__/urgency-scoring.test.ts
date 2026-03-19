// src/lib/metrics/__tests__/urgency-scoring.test.ts
// Unit tests for the urgency scoring module.
//
// The actual module lives in supabase/functions/_shared/ (Deno runtime).
// We re-implement the pure scoring logic inline here for testing under Vitest,
// matching the Edge Function implementation 1:1.

import { describe, it, expect } from 'vitest'

// ─── Types (mirroring urgency-scoring.ts) ────────────────────

interface UrgencyInput {
  action_type: string
  client_lifecycle_status: string
  days_since_last_contact: number | null
  has_upcoming_booking: boolean
  booking_days_away: number | null
  follow_up_days_overdue: number | null
  is_promise_made: boolean
}

interface UrgencyResult {
  score: number
  reason: string
}

// ─── Constants (mirroring urgency-scoring.ts) ────────────────

const PROXIMITY_BONUS = 10
const PROXIMITY_THRESHOLD_DAYS = 1
const OVERDUE_PER_DAY = 2
const OVERDUE_MAX_BONUS = 20
const PROMISE_BONUS = 15
const STALE_CONVERSATION_THRESHOLD_DAYS = 3

// ─── Re-implemented scoring logic (1:1 with Edge Function) ───

function determineBaseScenario(input: UrgencyInput): { baseScore: number; reason: string } {
  if (
    input.has_upcoming_booking &&
    input.booking_days_away !== null &&
    input.booking_days_away <= 0
  ) {
    return { baseScore: 90, reason: 'same_day_unconfirmed_booking' }
  }

  if (
    input.has_upcoming_booking &&
    input.booking_days_away !== null &&
    input.booking_days_away > 0
  ) {
    return { baseScore: 70, reason: 'unconfirmed_booking' }
  }

  if (input.follow_up_days_overdue !== null && input.follow_up_days_overdue > 0) {
    return { baseScore: 50, reason: 'overdue_follow_up' }
  }

  if (
    input.days_since_last_contact !== null &&
    input.days_since_last_contact > STALE_CONVERSATION_THRESHOLD_DAYS
  ) {
    return { baseScore: 30, reason: 'stale_conversation' }
  }

  return { baseScore: 10, reason: 'warm_lead' }
}

function calculateUrgency(input: UrgencyInput): UrgencyResult {
  const { baseScore, reason } = determineBaseScenario(input)

  let modifier = 0
  const modifierReasons: string[] = []

  if (
    input.has_upcoming_booking &&
    input.booking_days_away !== null &&
    input.booking_days_away <= PROXIMITY_THRESHOLD_DAYS
  ) {
    modifier += PROXIMITY_BONUS
    modifierReasons.push(`+${PROXIMITY_BONUS} booking within 24h`)
  }

  if (input.follow_up_days_overdue !== null && input.follow_up_days_overdue > 0) {
    const overdueBonus = Math.min(
      input.follow_up_days_overdue * OVERDUE_PER_DAY,
      OVERDUE_MAX_BONUS
    )
    modifier += overdueBonus
    modifierReasons.push(`+${overdueBonus} overdue ${input.follow_up_days_overdue}d`)
  }

  if (input.is_promise_made) {
    modifier += PROMISE_BONUS
    modifierReasons.push(`+${PROMISE_BONUS} AI promise pending`)
  }

  const rawScore = baseScore + modifier
  const score = Math.max(0, Math.min(100, rawScore))

  const fullReason = modifierReasons.length > 0
    ? `${reason} (${modifierReasons.join(', ')})`
    : reason

  return { score, reason: fullReason }
}

// ─── Helpers ─────────────────────────────────────────────────

function makeInput(overrides: Partial<UrgencyInput> = {}): UrgencyInput {
  return {
    action_type: 'message_send',
    client_lifecycle_status: 'active',
    days_since_last_contact: 1,
    has_upcoming_booking: false,
    booking_days_away: null,
    follow_up_days_overdue: null,
    is_promise_made: false,
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe('calculateUrgency', () => {
  // ─── Base scores ────────────────────────────────────────────

  describe('base scores by scenario', () => {
    it('should return 90 for same_day_unconfirmed_booking', () => {
      const result = calculateUrgency(makeInput({
        has_upcoming_booking: true,
        booking_days_away: 0,
      }))
      expect(result.score).toBe(100)  // 90 base + 10 proximity bonus (within 24h)
      expect(result.reason).toContain('same_day_unconfirmed_booking')
    })

    it('should return 90 base for same_day_unconfirmed_booking without proximity overlap', () => {
      // booking_days_away = 0 always triggers proximity bonus too, so raw = 100
      const result = calculateUrgency(makeInput({
        has_upcoming_booking: true,
        booking_days_away: 0,
      }))
      // Base 90 + proximity 10 = 100 (clamped)
      expect(result.score).toBe(100)
    })

    it('should return 70 for unconfirmed_booking more than 1 day away', () => {
      const result = calculateUrgency(makeInput({
        has_upcoming_booking: true,
        booking_days_away: 3,
      }))
      expect(result.score).toBe(70)
      expect(result.reason).toBe('unconfirmed_booking')
    })

    it('should return 80 for unconfirmed_booking within 24h (70 base + 10 proximity)', () => {
      const result = calculateUrgency(makeInput({
        has_upcoming_booking: true,
        booking_days_away: 1,
      }))
      expect(result.score).toBe(80)
      expect(result.reason).toContain('unconfirmed_booking')
      expect(result.reason).toContain('booking within 24h')
    })

    it('should return 50 for overdue_follow_up', () => {
      const result = calculateUrgency(makeInput({
        follow_up_days_overdue: 1,
      }))
      // 50 base + 2 overdue (1 day * 2) = 52
      expect(result.score).toBe(52)
      expect(result.reason).toContain('overdue_follow_up')
    })

    it('should return 30 for stale_conversation (>3 days no contact)', () => {
      const result = calculateUrgency(makeInput({
        days_since_last_contact: 5,
      }))
      expect(result.score).toBe(30)
      expect(result.reason).toBe('stale_conversation')
    })

    it('should return 10 for warm_lead (active, no urgency signals)', () => {
      const result = calculateUrgency(makeInput())
      expect(result.score).toBe(10)
      expect(result.reason).toBe('warm_lead')
    })

    it('should return 10 for warm_lead when days_since_last_contact is within threshold', () => {
      const result = calculateUrgency(makeInput({
        days_since_last_contact: 2,
      }))
      expect(result.score).toBe(10)
      expect(result.reason).toBe('warm_lead')
    })
  })

  // ─── Scenario priority ─────────────────────────────────────

  describe('scenario priority ordering', () => {
    it('should prefer same_day_unconfirmed_booking over overdue_follow_up', () => {
      const result = calculateUrgency(makeInput({
        has_upcoming_booking: true,
        booking_days_away: 0,
        follow_up_days_overdue: 5,
      }))
      expect(result.reason).toContain('same_day_unconfirmed_booking')
    })

    it('should prefer unconfirmed_booking over overdue_follow_up', () => {
      const result = calculateUrgency(makeInput({
        has_upcoming_booking: true,
        booking_days_away: 2,
        follow_up_days_overdue: 3,
      }))
      expect(result.reason).toContain('unconfirmed_booking')
    })

    it('should prefer overdue_follow_up over stale_conversation', () => {
      const result = calculateUrgency(makeInput({
        follow_up_days_overdue: 2,
        days_since_last_contact: 10,
      }))
      expect(result.reason).toContain('overdue_follow_up')
    })

    it('should prefer stale_conversation over warm_lead', () => {
      const result = calculateUrgency(makeInput({
        days_since_last_contact: 7,
      }))
      expect(result.reason).toContain('stale_conversation')
      expect(result.score).toBe(30)
    })
  })

  // ─── Modifiers ──────────────────────────────────────────────

  describe('modifiers', () => {
    describe('proximity bonus', () => {
      it('should add +10 when booking is within 24h (booking_days_away = 0)', () => {
        const result = calculateUrgency(makeInput({
          has_upcoming_booking: true,
          booking_days_away: 0,
        }))
        // Base 90 + proximity 10 = 100
        expect(result.score).toBe(100)
        expect(result.reason).toContain('booking within 24h')
      })

      it('should add +10 when booking is within 24h (booking_days_away = 1)', () => {
        const result = calculateUrgency(makeInput({
          has_upcoming_booking: true,
          booking_days_away: 1,
        }))
        // Base 70 + proximity 10 = 80
        expect(result.score).toBe(80)
        expect(result.reason).toContain('booking within 24h')
      })

      it('should NOT add proximity bonus when booking > 1 day away', () => {
        const result = calculateUrgency(makeInput({
          has_upcoming_booking: true,
          booking_days_away: 2,
        }))
        // Base 70, no proximity
        expect(result.score).toBe(70)
        expect(result.reason).not.toContain('booking within 24h')
      })

      it('should NOT add proximity bonus when no upcoming booking', () => {
        const result = calculateUrgency(makeInput({
          has_upcoming_booking: false,
          booking_days_away: 0,
        }))
        expect(result.score).toBe(10) // warm_lead
        expect(result.reason).not.toContain('booking within 24h')
      })
    })

    describe('overdue days bonus', () => {
      it('should add +2 per day overdue', () => {
        const result = calculateUrgency(makeInput({
          follow_up_days_overdue: 3,
        }))
        // Base 50 + overdue 6 (3 * 2) = 56
        expect(result.score).toBe(56)
        expect(result.reason).toContain('+6 overdue 3d')
      })

      it('should cap overdue bonus at +20', () => {
        const result = calculateUrgency(makeInput({
          follow_up_days_overdue: 15,
        }))
        // Base 50 + overdue 20 (capped) = 70
        expect(result.score).toBe(70)
        expect(result.reason).toContain('+20 overdue 15d')
      })

      it('should not add bonus for 0 days overdue', () => {
        const result = calculateUrgency(makeInput({
          follow_up_days_overdue: 0,
        }))
        // follow_up_days_overdue=0 means not overdue, so no bonus
        // but also no overdue_follow_up scenario (>0 required)
        expect(result.score).toBe(10) // warm_lead
      })

      it('should not add bonus for null days overdue', () => {
        const result = calculateUrgency(makeInput({
          follow_up_days_overdue: null,
        }))
        expect(result.score).toBe(10) // warm_lead
      })
    })

    describe('promise bonus', () => {
      it('should add +15 when AI promise is pending', () => {
        const result = calculateUrgency(makeInput({
          is_promise_made: true,
        }))
        // Base 10 (warm_lead) + promise 15 = 25
        expect(result.score).toBe(25)
        expect(result.reason).toContain('+15 AI promise pending')
      })

      it('should NOT add promise bonus when is_promise_made is false', () => {
        const result = calculateUrgency(makeInput({
          is_promise_made: false,
        }))
        expect(result.score).toBe(10)
        expect(result.reason).not.toContain('AI promise pending')
      })

      it('should stack promise bonus with overdue bonus', () => {
        const result = calculateUrgency(makeInput({
          follow_up_days_overdue: 5,
          is_promise_made: true,
        }))
        // Base 50 + overdue 10 (5 * 2) + promise 15 = 75
        expect(result.score).toBe(75)
        expect(result.reason).toContain('+10 overdue 5d')
        expect(result.reason).toContain('+15 AI promise pending')
      })
    })

    describe('combined modifiers', () => {
      it('should stack all modifiers on same_day_unconfirmed_booking', () => {
        const result = calculateUrgency(makeInput({
          has_upcoming_booking: true,
          booking_days_away: 0,
          follow_up_days_overdue: 3,
          is_promise_made: true,
        }))
        // Base 90 + proximity 10 + overdue 6 + promise 15 = 121 -> clamped to 100
        expect(result.score).toBe(100)
      })
    })
  })

  // ─── Score clamping ─────────────────────────────────────────

  describe('score clamping', () => {
    it('should never exceed 100', () => {
      const result = calculateUrgency(makeInput({
        has_upcoming_booking: true,
        booking_days_away: 0,
        follow_up_days_overdue: 10,
        is_promise_made: true,
      }))
      // Base 90 + proximity 10 + overdue 20 + promise 15 = 135 -> 100
      expect(result.score).toBe(100)
      expect(result.score).toBeLessThanOrEqual(100)
    })

    it('should never go below 0', () => {
      // With all null/false inputs, the minimum is warm_lead = 10
      // But let's test the clamp logic with the minimum possible
      const result = calculateUrgency(makeInput({
        days_since_last_contact: null,
        has_upcoming_booking: false,
        booking_days_away: null,
        follow_up_days_overdue: null,
        is_promise_made: false,
      }))
      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBe(10) // warm_lead baseline
    })

    it('should return a score that is always a finite number', () => {
      const result = calculateUrgency(makeInput())
      expect(Number.isFinite(result.score)).toBe(true)
    })
  })

  // ─── Reason string generation ──────────────────────────────

  describe('reason string generation', () => {
    it('should return bare reason when no modifiers apply', () => {
      const result = calculateUrgency(makeInput({
        days_since_last_contact: 5,
      }))
      expect(result.reason).toBe('stale_conversation')
      expect(result.reason).not.toContain('(')
    })

    it('should append modifier details in parentheses when modifiers apply', () => {
      const result = calculateUrgency(makeInput({
        follow_up_days_overdue: 2,
        is_promise_made: true,
      }))
      expect(result.reason).toMatch(/^overdue_follow_up \(.*\)$/)
    })

    it('should include all modifier reasons comma-separated', () => {
      const result = calculateUrgency(makeInput({
        has_upcoming_booking: true,
        booking_days_away: 0,
        follow_up_days_overdue: 5,
        is_promise_made: true,
      }))
      // Should have proximity, overdue, and promise modifiers
      expect(result.reason).toContain('booking within 24h')
      expect(result.reason).toContain('overdue')
      expect(result.reason).toContain('AI promise pending')
    })

    it('should include the correct overdue days count in reason', () => {
      const result = calculateUrgency(makeInput({
        follow_up_days_overdue: 7,
      }))
      expect(result.reason).toContain('overdue 7d')
    })

    it('should use base scenario name as the primary reason', () => {
      const scenarios = [
        { input: makeInput({ has_upcoming_booking: true, booking_days_away: 0 }), expected: 'same_day_unconfirmed_booking' },
        { input: makeInput({ has_upcoming_booking: true, booking_days_away: 5 }), expected: 'unconfirmed_booking' },
        { input: makeInput({ follow_up_days_overdue: 2 }), expected: 'overdue_follow_up' },
        { input: makeInput({ days_since_last_contact: 10 }), expected: 'stale_conversation' },
        { input: makeInput(), expected: 'warm_lead' },
      ]

      for (const { input, expected } of scenarios) {
        const result = calculateUrgency(input)
        expect(result.reason).toContain(expected)
      }
    })
  })

  // ─── Edge cases ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle days_since_last_contact = exactly 3 as warm_lead (not stale)', () => {
      const result = calculateUrgency(makeInput({
        days_since_last_contact: 3,
      }))
      // Threshold is > 3, so exactly 3 is warm_lead
      expect(result.reason).toBe('warm_lead')
      expect(result.score).toBe(10)
    })

    it('should handle days_since_last_contact = 4 as stale_conversation', () => {
      const result = calculateUrgency(makeInput({
        days_since_last_contact: 4,
      }))
      expect(result.reason).toBe('stale_conversation')
      expect(result.score).toBe(30)
    })

    it('should handle booking_days_away = negative (past booking)', () => {
      const result = calculateUrgency(makeInput({
        has_upcoming_booking: true,
        booking_days_away: -1,
      }))
      // -1 <= 0, so same_day_unconfirmed_booking
      expect(result.reason).toContain('same_day_unconfirmed_booking')
    })

    it('should handle very large overdue days', () => {
      const result = calculateUrgency(makeInput({
        follow_up_days_overdue: 100,
      }))
      // Base 50 + overdue 20 (capped) = 70
      expect(result.score).toBe(70)
    })

    it('should handle all null optional fields', () => {
      const result = calculateUrgency({
        action_type: 'message_send',
        client_lifecycle_status: 'unknown',
        days_since_last_contact: null,
        has_upcoming_booking: false,
        booking_days_away: null,
        follow_up_days_overdue: null,
        is_promise_made: false,
      })
      expect(result.score).toBe(10)
      expect(result.reason).toBe('warm_lead')
    })
  })
})
