import type { CategorizationResponse, Extraction } from './types/extraction.ts';
import { UPDATABLE_FIELDS, PREFERENCES_PREFIX } from './types/extraction.ts';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseCategorizationResponse(raw: string): CategorizationResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[categorize] Failed to parse JSON response');
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('extractions' in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).extractions)
  ) {
    console.error('[categorize] Response missing extractions array');
    return null;
  }

  const rawExtractions = (parsed as { extractions: unknown[] }).extractions;
  const validExtractions: Extraction[] = [];

  for (const item of rawExtractions) {
    if (!item || typeof item !== 'object' || !('category' in item)) continue;
    const e = item as Record<string, unknown>;

    switch (e.category) {
      case 'FOLLOW_UP': {
        validExtractions.push({
          category: 'FOLLOW_UP',
          description: String(e.description ?? ''),
          due_date: validateDate(e.due_date),
        });
        break;
      }
      case 'PROMISE': {
        if (e.is_duplicate === true) continue;
        validExtractions.push({
          category: 'PROMISE',
          description: String(e.description ?? ''),
          due_date: validateDate(e.due_date),
          is_duplicate: false,
        });
        break;
      }
      case 'CLIENT_UPDATE': {
        const field = String(e.field ?? '');
        if (!isUpdatableField(field)) {
          console.warn('[categorize] Rejected CLIENT_UPDATE for unknown field:', field);
          continue;
        }
        validExtractions.push({
          category: 'CLIENT_UPDATE',
          field,
          before_value: e.before_value,
          after_value: e.after_value,
        });
        break;
      }
    }
  }

  return { extractions: validExtractions };
}

function isUpdatableField(field: string): boolean {
  if ((UPDATABLE_FIELDS as readonly string[]).includes(field)) return true;
  if (field.startsWith(PREFERENCES_PREFIX)) return true;
  return false;
}

function validateDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!ISO_DATE_RE.test(value)) return null;
  return value;
}
