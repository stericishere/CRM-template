import type { ContextUpdateResult } from './types/extraction.ts';

const FIELD_MAP: Record<string, string> = {
  name: 'full_name',
  'full name': 'full_name',
  fullname: 'full_name',
  phone: 'phone_number',
  number: 'phone_number',
  'phone number': 'phone_number',
  phonenumber: 'phone_number',
  email: 'email',
};

const SET_PATTERNS = [
  /^(?:update|change|set|modify)\s+(?:her|his|their|client'?s?)?\s*(name|full\s?name|phone|number|phone\s?number|email)\s+(?:to|as)\s+(.+)$/i,
];

const TAG_ADD_RE = /^add\s+tag\s+(.+)$/i;
const TAG_REMOVE_RE = /^(?:remove|delete)\s+tag\s+(.+)$/i;

export function parseContextUpdate(input: string): ContextUpdateResult {
  const trimmed = input.trim();
  if (!trimmed) return { isCommand: false };

  for (const pattern of SET_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[1] && match[2]) {
      const rawField = match[1].toLowerCase().replace(/\s+/g, ' ');
      const field = FIELD_MAP[rawField];
      if (field) {
        return {
          isCommand: true,
          source: 'conversation_update',
          parsedIntent: {
            field,
            value: match[2].trim(),
            action: 'set',
          },
        };
      }
    }
  }

  const addMatch = trimmed.match(TAG_ADD_RE);
  if (addMatch && addMatch[1]) {
    return {
      isCommand: true,
      source: 'conversation_update',
      parsedIntent: {
        field: 'tags',
        value: addMatch[1].trim(),
        action: 'add',
      },
    };
  }

  const removeMatch = trimmed.match(TAG_REMOVE_RE);
  if (removeMatch && removeMatch[1]) {
    return {
      isCommand: true,
      source: 'conversation_update',
      parsedIntent: {
        field: 'tags',
        value: removeMatch[1].trim(),
        action: 'remove',
      },
    };
  }

  return { isCommand: false };
}
