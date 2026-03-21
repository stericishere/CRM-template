import { describe, it, expect } from 'vitest';
import { resolveDeadline } from '../deadline-resolver';

describe('resolveDeadline', () => {
  const BASE_DATE = '2026-03-20'; // Friday
  const TZ = 'Asia/Hong_Kong';

  it('should resolve "tomorrow" to next day', () => {
    expect(resolveDeadline('tomorrow', BASE_DATE, TZ)).toBe('2026-03-21');
  });

  it('should resolve "today" to same day', () => {
    expect(resolveDeadline('today', BASE_DATE, TZ)).toBe('2026-03-20');
  });

  it('should resolve "next week" to next Monday', () => {
    expect(resolveDeadline('next week', BASE_DATE, TZ)).toBe('2026-03-23');
  });

  it('should resolve "by Friday" to next Friday when today is Friday', () => {
    expect(resolveDeadline('by Friday', BASE_DATE, TZ)).toBe('2026-03-27');
  });

  it('should resolve "by Wednesday" to next Wednesday', () => {
    expect(resolveDeadline('by Wednesday', BASE_DATE, TZ)).toBe('2026-03-25');
  });

  it('should resolve "in 3 days" to 3 days later', () => {
    expect(resolveDeadline('in 3 days', BASE_DATE, TZ)).toBe('2026-03-23');
  });

  it('should resolve "next month" to 1st of next month', () => {
    expect(resolveDeadline('next month', BASE_DATE, TZ)).toBe('2026-04-01');
  });

  it('should resolve "end of week" to upcoming Sunday', () => {
    expect(resolveDeadline('end of week', BASE_DATE, TZ)).toBe('2026-03-22');
  });

  it('should return null for vague references like "soon"', () => {
    expect(resolveDeadline('soon', BASE_DATE, TZ)).toBeNull();
  });

  it('should return null for "sometime"', () => {
    expect(resolveDeadline('sometime', BASE_DATE, TZ)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(resolveDeadline('', BASE_DATE, TZ)).toBeNull();
  });

  it('should pass through absolute ISO dates unchanged', () => {
    expect(resolveDeadline('2026-04-15', BASE_DATE, TZ)).toBe('2026-04-15');
  });
});
