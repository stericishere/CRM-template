import { describe, it, expect } from 'vitest';
import { checkPromotionThreshold, calculateConfidence } from '../pattern-tracking';
import type { PatternRecurrence } from '../../../../supabase/functions/_shared/types/learning';

function makeRecurrence(overrides: Partial<PatternRecurrence> = {}): PatternRecurrence {
  return {
    id: 'rec-1',
    workspace_id: 'ws-1',
    pattern_key: 'soften_greeting_tone',
    category: 'tone_warmed',
    recurrence_count: 3,
    distinct_clients: 2,
    client_ids: ['c1', 'c2'],
    first_seen: '2026-03-01T00:00:00Z',
    last_seen: '2026-03-20T00:00:00Z',
    promoted: false,
    promoted_at: null,
    ...overrides,
  };
}

describe('checkPromotionThreshold', () => {
  it('should promote when all criteria met (3+ occurrences, 2+ clients, <=30d window)', () => {
    const result = checkPromotionThreshold(makeRecurrence());
    expect(result.shouldPromote).toBe(true);
    expect(result.reason).toBe('threshold_met');
  });

  it('should not promote when already promoted', () => {
    const result = checkPromotionThreshold(makeRecurrence({ promoted: true }));
    expect(result.shouldPromote).toBe(false);
    expect(result.reason).toBe('already_promoted');
  });

  it('should not promote with insufficient recurrence count', () => {
    const result = checkPromotionThreshold(makeRecurrence({ recurrence_count: 2 }));
    expect(result.shouldPromote).toBe(false);
    expect(result.reason).toContain('recurrence_count=2');
  });

  it('should not promote with only 1 distinct client', () => {
    const result = checkPromotionThreshold(makeRecurrence({ distinct_clients: 1 }));
    expect(result.shouldPromote).toBe(false);
    expect(result.reason).toContain('distinct_clients=1');
  });

  it('should not promote when window exceeds 30 days', () => {
    const result = checkPromotionThreshold(makeRecurrence({
      first_seen: '2026-01-01T00:00:00Z',
      last_seen: '2026-03-20T00:00:00Z',
    }));
    expect(result.shouldPromote).toBe(false);
    expect(result.reason).toContain('window=');
  });

  it('should promote with exactly 3 occurrences and 2 clients', () => {
    const result = checkPromotionThreshold(makeRecurrence({
      recurrence_count: 3,
      distinct_clients: 2,
    }));
    expect(result.shouldPromote).toBe(true);
  });

  it('should promote with high counts', () => {
    const result = checkPromotionThreshold(makeRecurrence({
      recurrence_count: 15,
      distinct_clients: 8,
    }));
    expect(result.shouldPromote).toBe(true);
  });
});

describe('calculateConfidence', () => {
  it('should return 0.3 for 3 occurrences', () => {
    expect(calculateConfidence(3)).toBeCloseTo(0.3);
  });

  it('should return 0.5 for 5 occurrences', () => {
    expect(calculateConfidence(5)).toBeCloseTo(0.5);
  });

  it('should cap at 1.0 for 10+ occurrences', () => {
    expect(calculateConfidence(10)).toBe(1.0);
    expect(calculateConfidence(15)).toBe(1.0);
  });
});
