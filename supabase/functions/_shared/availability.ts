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
 * We use Intl.DateTimeFormat to derive the UTC offset without relying on
 * day-of-month comparisons. The old day-number approach had two failure modes:
 *
 *   1. Month-boundary bug: on 2025-01-01 in America/New_York, UTC midnight is
 *      Dec 31 locally. localDay (31) > utcDay (1) is numerically true, so the
 *      code incorrectly treated the timezone as "ahead" of UTC.
 *
 *   2. Year-boundary: same issue when UTC midnight falls in the previous year
 *      (e.g., UTC+14 Pacific/Kiritimati on Jan 1).
 *
 * Fix: reconstruct the local time as a UTC epoch and subtract the probe's
 * actual UTC epoch. The sign and magnitude are always correct regardless of
 * which calendar day or year the local time falls in.
 *
 * DST safety: the probe is the UTC midnight of the requested date, so the
 * offset we read is the one in effect at that specific instant — precisely
 * what we need for placing business-hours boundaries on that calendar day.
 */
function parseTimeInTimezone(date: string, time: string, timezone: string): number {
  const [hours, minutes] = time.split(':').map(Number)

  // Probe: UTC midnight of the requested calendar date.
  // Formatting this through the timezone tells us what local time corresponds
  // to UTC midnight, which gives us the timezone offset for that day.
  const probe = new Date(`${date}T00:00:00Z`)

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const parts = formatter.formatToParts(probe)
  const get = (type: string): number =>
    parseInt(parts.find(p => p.type === type)?.value ?? '0', 10)

  const localYear   = get('year')
  const localMonth  = get('month')  // 1-based from Intl
  const localDay    = get('day')
  const localHour   = get('hour') % 24  // guard against the rare '24' sentinel
  const localMinute = get('minute')
  const localSecond = get('second')

  // Reconstruct what the Intl formatter reported as if it were a UTC timestamp.
  // Date.UTC uses a 0-based month, so subtract 1 from the 1-based Intl value.
  //
  // Example — America/New_York on 2025-01-01:
  //   probe  = 2025-01-01T00:00:00Z  (epoch 1735689600000)
  //   Intl   → 2024-12-31 19:00:00
  //   localAsUtcMs = Date.UTC(2024, 11, 31, 19, 0, 0) = 1735671600000
  //   offsetMs = 1735671600000 − 1735689600000 = −18000000 ms  (= −5 h)  ✓
  //
  // Example — Asia/Hong_Kong on 2025-01-01:
  //   probe  = 2025-01-01T00:00:00Z  (epoch 1735689600000)
  //   Intl   → 2025-01-01 08:00:00
  //   localAsUtcMs = Date.UTC(2025, 0, 1, 8, 0, 0) = 1735718400000
  //   offsetMs = 1735718400000 − 1735689600000 = +28800000 ms  (= +8 h)  ✓
  const localAsUtcMs = Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, localSecond)
  const offsetMs = localAsUtcMs - probe.getTime()

  // Place the requested HH:MM on the given date in the target timezone.
  // "Local midnight in UTC" = probe.getTime() − offsetMs
  // Add the requested time-of-day on top of that.
  const localMidnightUtcMs = probe.getTime() - offsetMs
  return localMidnightUtcMs + (hours * 60 + minutes) * 60_000
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
