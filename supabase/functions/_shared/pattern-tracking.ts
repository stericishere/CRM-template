import type { PatternRecurrence, PromotionResult } from './types/learning.ts';

export function checkPromotionThreshold(recurrence: PatternRecurrence): PromotionResult {
  if (recurrence.promoted) {
    return { shouldPromote: false, reason: 'already_promoted' };
  }

  const windowDays = Math.ceil(
    (new Date(recurrence.last_seen).getTime() -
      new Date(recurrence.first_seen).getTime()) /
    (1000 * 60 * 60 * 24),
  );

  if (recurrence.recurrence_count < 3) {
    return {
      shouldPromote: false,
      reason: `recurrence_count=${recurrence.recurrence_count}, need >= 3`,
    };
  }

  if (recurrence.distinct_clients < 2) {
    return {
      shouldPromote: false,
      reason: `distinct_clients=${recurrence.distinct_clients}, need >= 2`,
    };
  }

  if (windowDays > 30) {
    return {
      shouldPromote: false,
      reason: `window=${windowDays}d, need <= 30`,
    };
  }

  return { shouldPromote: true, reason: 'threshold_met' };
}

export function calculateConfidence(recurrenceCount: number): number {
  return Math.min(1.0, recurrenceCount / 10);
}
