import { describe, it, expect } from 'vitest';
import { parseClassificationResponse } from '../classification-parser';

describe('parseClassificationResponse', () => {
  it('should parse a valid single-category response', () => {
    const raw = JSON.stringify({
      edit_categories: ['tone_warmed'],
      severity: 'significant',
      pattern_keys: ['soften_greeting_tone'],
      analysis_notes: 'Staff warmed the greeting from formal to casual',
    });
    const result = parseClassificationResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.edit_categories).toEqual(['tone_warmed']);
    expect(result!.severity).toBe('significant');
    expect(result!.pattern_keys).toEqual(['soften_greeting_tone']);
  });

  it('should parse a multi-category response', () => {
    const raw = JSON.stringify({
      edit_categories: ['shortened', 'cta_softened', 'upsell_removed'],
      severity: 'rewrite',
      pattern_keys: ['shorten_and_soften_reminders'],
      analysis_notes: 'Multiple changes',
    });
    const result = parseClassificationResponse(raw);
    expect(result!.edit_categories).toHaveLength(3);
  });

  it('should filter out unknown categories', () => {
    const raw = JSON.stringify({
      edit_categories: ['tone_warmed', 'invented_category', 'shortened'],
      severity: 'minor',
      pattern_keys: ['test'],
      analysis_notes: 'test',
    });
    const result = parseClassificationResponse(raw);
    expect(result!.edit_categories).toEqual(['tone_warmed', 'shortened']);
  });

  it('should return null when all categories are invalid', () => {
    const raw = JSON.stringify({
      edit_categories: ['fake_one', 'fake_two'],
      severity: 'minor',
      pattern_keys: ['test'],
      analysis_notes: 'test',
    });
    expect(parseClassificationResponse(raw)).toBeNull();
  });

  it('should default severity to significant when invalid', () => {
    const raw = JSON.stringify({
      edit_categories: ['tone_warmed'],
      severity: 'extreme',
      pattern_keys: ['test'],
      analysis_notes: 'test',
    });
    const result = parseClassificationResponse(raw);
    expect(result!.severity).toBe('significant');
  });

  it('should return null for invalid JSON', () => {
    expect(parseClassificationResponse('not json')).toBeNull();
  });

  it('should handle missing pattern_keys gracefully', () => {
    const raw = JSON.stringify({
      edit_categories: ['shortened'],
      severity: 'minor',
      analysis_notes: 'test',
    });
    const result = parseClassificationResponse(raw);
    expect(result!.pattern_keys).toEqual([]);
  });
});
