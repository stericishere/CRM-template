import { describe, it, expect } from 'vitest';
import { parseContextUpdate } from '../context-update-parser';

describe('parseContextUpdate', () => {
  it('should detect "update her name to Liz"', () => {
    const result = parseContextUpdate('update her name to Liz');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('full_name');
    expect(result.parsedIntent?.value).toBe('Liz');
    expect(result.parsedIntent?.action).toBe('set');
  });

  it('should detect "change his phone number to +85291234567"', () => {
    const result = parseContextUpdate("change his phone number to +85291234567");
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('phone_number');
    expect(result.parsedIntent?.value).toBe('+85291234567');
  });

  it('should detect "set email to liz@example.com"', () => {
    const result = parseContextUpdate('set email to liz@example.com');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('email');
    expect(result.parsedIntent?.value).toBe('liz@example.com');
  });

  it('should detect "add tag VIP"', () => {
    const result = parseContextUpdate('add tag VIP');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('tags');
    expect(result.parsedIntent?.value).toBe('VIP');
    expect(result.parsedIntent?.action).toBe('add');
  });

  it('should detect "remove tag inactive"', () => {
    const result = parseContextUpdate('remove tag inactive');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.field).toBe('tags');
    expect(result.parsedIntent?.value).toBe('inactive');
    expect(result.parsedIntent?.action).toBe('remove');
  });

  it('should NOT classify regular notes as commands', () => {
    const result = parseContextUpdate('Client prefers morning appointments and likes green tea');
    expect(result.isCommand).toBe(false);
  });

  it('should NOT classify observations mentioning names as commands', () => {
    const result = parseContextUpdate("She told me her name is Liz but I didn't update it yet");
    expect(result.isCommand).toBe(false);
  });

  it('should handle empty input', () => {
    const result = parseContextUpdate('');
    expect(result.isCommand).toBe(false);
  });

  it('should be case-insensitive', () => {
    const result = parseContextUpdate('UPDATE HER NAME TO Elizabeth');
    expect(result.isCommand).toBe(true);
    expect(result.parsedIntent?.value).toBe('Elizabeth');
  });
});
