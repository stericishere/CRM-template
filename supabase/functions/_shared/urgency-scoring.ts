// supabase/functions/_shared/urgency-scoring.ts
// Deterministic urgency scoring for proposed actions.
//
// Scores range 0-100. Higher = more urgent.
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │  Base score lookup (by scenario)                            │
//   │    same_day_unconfirmed booking .......... 90               │
//   │    unconfirmed_booking (>1 day) .......... 70               │
//   │    overdue_follow_up .................... 50                │
//   │    stale_conversation (>3 days) ......... 30                │
//   │    warm_lead ............................ 10                │
//   │                                                             │
//   │  Modifiers (additive, post-base)                            │
//   │    proximity bonus: +10 if booking within 24h               │
//   │    days_overdue: +2 per day overdue (max +20)               │
//   │    promise_bonus: +15 if AI made a promise to follow up     │
//   └──────────────────────────────────────────────────────────────┘
//
// Final score is clamped to [0, 100].

// ─── Types ──────────────────────────────────────────────────

export interface UrgencyInput {
  action_type: string           // from proposed_actions.action_type
  client_lifecycle_status: string
  days_since_last_contact: number | null
  has_upcoming_booking: boolean
  booking_days_away: number | null  // days until next booking
  follow_up_days_overdue: number | null
  is_promise_made: boolean          // if AI promised to follow up
}

export interface UrgencyResult {
  score: number   // 0-100
  reason: string
}

// ─── Constants ──────────────────────────────────────────────

const PROXIMITY_BONUS = 10
const PROXIMITY_THRESHOLD_DAYS = 1
const OVERDUE_PER_DAY = 2
const OVERDUE_MAX_BONUS = 20
const PROMISE_BONUS = 15
const STALE_CONVERSATION_THRESHOLD_DAYS = 3

// ─── Main scoring function ──────────────────────────────────

export function calculateUrgency(input: UrgencyInput): UrgencyResult {
  // 1. Determine base score and reason from scenario
  const { baseScore, reason } = determineBaseScenario(input)

  // 2. Apply modifiers
  let modifier = 0
  const modifierReasons: string[] = []

  // Proximity bonus: +10 if booking within 24h
  if (
    input.has_upcoming_booking &&
    input.booking_days_away !== null &&
    input.booking_days_away <= PROXIMITY_THRESHOLD_DAYS
  ) {
    modifier += PROXIMITY_BONUS
    modifierReasons.push(`+${PROXIMITY_BONUS} booking within 24h`)
  }

  // Days overdue: +2 per day overdue (max +20)
  if (input.follow_up_days_overdue !== null && input.follow_up_days_overdue > 0) {
    const overdueBonus = Math.min(
      input.follow_up_days_overdue * OVERDUE_PER_DAY,
      OVERDUE_MAX_BONUS
    )
    modifier += overdueBonus
    modifierReasons.push(`+${overdueBonus} overdue ${input.follow_up_days_overdue}d`)
  }

  // Promise bonus: +15 if AI made a promise to follow up
  if (input.is_promise_made) {
    modifier += PROMISE_BONUS
    modifierReasons.push(`+${PROMISE_BONUS} AI promise pending`)
  }

  // 3. Clamp to [0, 100]
  const rawScore = baseScore + modifier
  const score = Math.max(0, Math.min(100, rawScore))

  // 4. Build composite reason
  const fullReason = modifierReasons.length > 0
    ? `${reason} (${modifierReasons.join(', ')})`
    : reason

  return { score, reason: fullReason }
}

// ─── Scenario detection ─────────────────────────────────────

function determineBaseScenario(input: UrgencyInput): { baseScore: number; reason: string } {
  // Priority 1: Same-day unconfirmed booking
  if (
    input.has_upcoming_booking &&
    input.booking_days_away !== null &&
    input.booking_days_away <= 0
  ) {
    return { baseScore: 90, reason: 'same_day_unconfirmed_booking' }
  }

  // Priority 2: Unconfirmed booking (>1 day out)
  if (
    input.has_upcoming_booking &&
    input.booking_days_away !== null &&
    input.booking_days_away > 0
  ) {
    return { baseScore: 70, reason: 'unconfirmed_booking' }
  }

  // Priority 3: Overdue follow-up
  if (input.follow_up_days_overdue !== null && input.follow_up_days_overdue > 0) {
    return { baseScore: 50, reason: 'overdue_follow_up' }
  }

  // Priority 4: Stale conversation (>3 days no reply)
  if (
    input.days_since_last_contact !== null &&
    input.days_since_last_contact > STALE_CONVERSATION_THRESHOLD_DAYS
  ) {
    return { baseScore: 30, reason: 'stale_conversation' }
  }

  // Default: Warm lead (active but no action needed)
  return { baseScore: 10, reason: 'warm_lead' }
}
