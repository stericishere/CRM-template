import { describe, it, expect } from 'vitest';
import { parseCategorizationResponse } from '../categorization-parser';

describe('parseCategorizationResponse', () => {
  it('should parse a valid response with follow-up', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'FOLLOW_UP',
        description: 'Follow up about wedding quote',
        due_date: '2026-03-27',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result?.extractions).toHaveLength(1);
    expect(result?.extractions?.[0]?.category).toBe('FOLLOW_UP');
  });

  it('should parse a response with promise', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'PROMISE',
        description: 'Send revised quote',
        due_date: '2026-03-25',
        is_duplicate: false,
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result?.extractions?.[0]?.category).toBe('PROMISE');
  });

  it('should filter out duplicate promises', () => {
    const raw = JSON.stringify({
      extractions: [
        { category: 'PROMISE', description: 'Send quote', due_date: null, is_duplicate: true },
        { category: 'FOLLOW_UP', description: 'Check pricing', due_date: null },
      ],
    });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result?.extractions).toHaveLength(1);
    expect(result?.extractions?.[0]?.category).toBe('FOLLOW_UP');
  });

  it('should reject CLIENT_UPDATE with unknown field', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'CLIENT_UPDATE',
        field: 'internal_id',
        before_value: '123',
        after_value: '456',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.extractions).toHaveLength(0);
  });

  it('should allow CLIENT_UPDATE with preferences.* field', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'CLIENT_UPDATE',
        field: 'preferences.preferred_time',
        before_value: 'afternoons',
        after_value: 'mornings',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result!.extractions).toHaveLength(1);
  });

  it('should allow CLIENT_UPDATE with valid top-level field', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'CLIENT_UPDATE',
        field: 'full_name',
        before_value: 'Elizabeth Chen',
        after_value: 'Liz Chen',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result!.extractions).toHaveLength(1);
  });

  it('should return null for invalid JSON', () => {
    expect(parseCategorizationResponse('not json')).toBeNull();
  });

  it('should return null for missing extractions key', () => {
    expect(parseCategorizationResponse('{}')).toBeNull();
  });

  it('should handle empty extractions array', () => {
    const raw = JSON.stringify({ extractions: [] });
    const result = parseCategorizationResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.extractions).toHaveLength(0);
  });

  it('should reject invalid due_date format', () => {
    const raw = JSON.stringify({
      extractions: [{
        category: 'FOLLOW_UP',
        description: 'Test',
        due_date: 'not-a-date',
      }],
    });
    const result = parseCategorizationResponse(raw);
    expect(result!.extractions[0]).toHaveProperty('due_date', null);
  });
});
