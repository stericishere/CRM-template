const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IN_N_DAYS_RE = /^in\s+(\d+)\s+days?$/i;
const BY_DAY_RE = /^by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

export function resolveDeadline(
  reference: string,
  baseDateStr: string,
  _timezone: string,
): string | null {
  const trimmed = reference.trim().toLowerCase();
  if (!trimmed) return null;

  if (ISO_DATE_RE.test(trimmed)) return trimmed;

  const base = new Date(baseDateStr + 'T00:00:00');
  const baseDay = base.getDay();

  if (trimmed === 'today') return baseDateStr;
  if (trimmed === 'tomorrow') return addDays(base, 1);

  const inNMatch = trimmed.match(IN_N_DAYS_RE);
  if (inNMatch) return addDays(base, parseInt(inNMatch[1], 10));

  if (trimmed === 'next week') {
    const daysUntilMonday = ((1 - baseDay + 7) % 7) || 7;
    return addDays(base, daysUntilMonday);
  }

  if (trimmed === 'end of week') {
    const daysUntilSunday = ((0 - baseDay + 7) % 7) || 7;
    return addDays(base, daysUntilSunday);
  }

  if (trimmed === 'next month') {
    const next = new Date(base);
    next.setMonth(next.getMonth() + 1);
    next.setDate(1);
    return formatDate(next);
  }

  const byDayMatch = trimmed.match(BY_DAY_RE);
  if (byDayMatch) {
    const targetDay = DAY_NAMES.indexOf(byDayMatch[1].toLowerCase());
    const daysUntil = ((targetDay - baseDay + 7) % 7) || 7;
    return addDays(base, daysUntil);
  }

  return null;
}

function addDays(date: Date, days: number): string {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return formatDate(result);
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
