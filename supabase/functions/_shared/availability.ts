// Pure function for booking slot generation (F-07)
// No side effects, no DB access — takes inputs and returns available time slots.
//
// Algorithm:
// 1. Generate candidate slots at `slotDurationMinutes` granularity within business hours
// 2. Expand each busy interval and existing booking by `bufferMinutes` on both sides
// 3. Filter out any candidate slot that overlaps an expanded blocked interval
//
// ┌──────────────────────────────────────────────────────┐
// │  Business Hours: 09:00 ─────────────────────── 18:00 │
// │  ███ = busy    ░░░ = buffer    ─── = available       │
// │                                                      │
// │  09:00 ─── 10:00 ███ 11:00 ░░░ 11:15 ─── 18:00     │
// └──────────────────────────────────────────────────────┘

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TimeSlot {
  start: string   // ISO 8601
  end: string     // ISO 8601
}

export interface AvailabilityParams {
  date: string                                    // YYYY-MM-DD
  businessHours: { open: string; close: string }  // HH:MM in 24h
  busyIntervals: TimeSlot[]                       // from Google Calendar
  existingBookings: TimeSlot[]                    // from bookings table
  slotDurationMinutes: number                     // e.g. 30
  bufferMinutes?: number                          // gap between slots, default 0
  timezone: string                                // e.g. 'Asia/Hong_Kong'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a "HH:MM" time string on a given date into epoch ms,
 * interpreted in the specified timezone.
 *
 * Uses Intl.DateTimeFormat with timeZoneName:'longOffset' to read the UTC
 * offset string (e.g. "GMT-05:00") directly from the runtime's tz database.
 *
 * Algorithm:
 *   1. Construct the naive local instant as if it were UTC:
 *      naiveUtcMs = Date.UTC(yyyy, mm-1, dd, HH, MM, 0)
 *   2. Probe Intl at that instant to get the offset string for the timezone.
 *   3. Parse the offset string → offsetMs.
 *   4. Result = naiveUtcMs − offsetMs  (local time minus offset = UTC instant).
 *
 * DST safety: the probe uses the naive instant, which is close enough to the
 * true local instant that the offset lookup returns the correct DST rule for
 * all real-world timezones (max error is ±offset itself, but Intl resolves
 * from the tz database, not from the probe epoch).
 *
 * Verification:
 *   2025-01-01 09:00 America/New_York  → 2025-01-01T14:00:00Z  (EST, -5h)
 *   2025-01-01 09:00 Asia/Hong_Kong    → 2025-01-01T01:00:00Z  (HKT, +8h)
 *   2025-03-09 09:00 America/New_York  → 2025-03-09T13:00:00Z  (EDT, -4h)
 */
function parseTimeInTimezone(date: string, time: string, timezone: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  const [year, month, day] = date.split('-').map(Number)

  // 1. Construct the local time as if it were UTC
  const naiveUtcMs = Date.UTC(year, month - 1, day, hours, minutes, 0)

  // 2. Ask Intl for the UTC offset at this instant in the target timezone.
  //    timeZoneName:'longOffset' produces strings like "GMT", "GMT-05:00", "GMT+08:00".
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  })
  const offsetPart = offsetFormatter.formatToParts(new Date(naiveUtcMs))
    .find(p => p.type === 'timeZoneName')?.value ?? 'GMT'

  // 3. Parse "GMT±HH:MM" into milliseconds. "GMT" alone means +00:00.
  let offsetMs = 0
  const match = offsetPart.match(/^GMT([+-])(\d{2}):(\d{2})$/)
  if (match) {
    const sign = match[1] === '+' ? 1 : -1
    offsetMs = sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10)) * 60_000
  }

  // 4. UTC instant = local time − offset
  return naiveUtcMs - offsetMs
}

function intervalsOverlap(
  aStart: number, aEnd: number,
  bStart: number, bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd
}

// ─── Main function ───────────────────────────────────────────────────────────

/**
 * Calculate available time slots for a given date.
 *
 * Returns slots at `slotDurationMinutes` granularity that:
 * - Fall within business hours (open..close)
 * - Do not overlap any busy interval (from Google Calendar)
 * - Do not overlap any existing booking (from bookings table)
 * - Respect buffer minutes around blocked intervals
 */
export function calculateAvailableSlots(params: AvailabilityParams): TimeSlot[] {
  const {
    date,
    businessHours,
    busyIntervals,
    existingBookings,
    slotDurationMinutes,
    bufferMinutes = 0,
    timezone,
  } = params

  if (slotDurationMinutes <= 0) {
    return []
  }

  const openMs = parseTimeInTimezone(date, businessHours.open, timezone)
  const closeMs = parseTimeInTimezone(date, businessHours.close, timezone)

  if (openMs >= closeMs) {
    return []
  }

  const slotMs = slotDurationMinutes * 60_000
  const bufferMs = bufferMinutes * 60_000

  // Build blocked intervals with buffer applied to both sides
  const blocked: Array<{ start: number; end: number }> = []

  for (const interval of [...busyIntervals, ...existingBookings]) {
    const iStart = new Date(interval.start).getTime()
    const iEnd = new Date(interval.end).getTime()
    blocked.push({
      start: iStart - bufferMs,
      end: iEnd + bufferMs,
    })
  }

  // Generate candidate slots and filter
  const slots: TimeSlot[] = []
  let cursor = openMs

  while (cursor + slotMs <= closeMs) {
    const slotStart = cursor
    const slotEnd = cursor + slotMs

    const hasConflict = blocked.some(b =>
      intervalsOverlap(slotStart, slotEnd, b.start, b.end)
    )

    if (!hasConflict) {
      slots.push({
        start: new Date(slotStart).toISOString(),
        end: new Date(slotEnd).toISOString(),
      })
    }

    cursor += slotMs
  }

  return slots
}
