import { EDIT_CATEGORIES, type ClassificationResponse } from './types/learning';

const VALID_SEVERITIES = ['minor', 'significant', 'rewrite'];

export function parseClassificationResponse(raw: string): ClassificationResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[classify] Failed to parse JSON response');
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.edit_categories)) return null;

  const validCategories = (obj.edit_categories as string[]).filter(
    (c: string) => (EDIT_CATEGORIES as readonly string[]).includes(c),
  );

  if (validCategories.length === 0) {
    console.warn('[classify] No valid categories in response');
    return null;
  }

  const severity = VALID_SEVERITIES.includes(obj.severity as string)
    ? (obj.severity as string)
    : 'significant';

  return {
    edit_categories: validCategories,
    severity,
    pattern_keys: Array.isArray(obj.pattern_keys)
      ? (obj.pattern_keys as string[]).filter(
          (k: string) => typeof k === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(k),
        )
      : [],
    analysis_notes: typeof obj.analysis_notes === 'string' ? obj.analysis_notes : '',
  };
}
