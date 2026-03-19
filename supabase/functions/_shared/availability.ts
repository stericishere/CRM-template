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
 * We use a manual approach that works in Deno without heavy timezone libraries:
 * build an ISO string with the timezone offset and let Date parse it.
 * For robustness, we use Intl.DateTimeFormat to resolve the UTC offset.
 */
function parseTimeInTimezone(date: string, time: string, timezone: string): number {
  // Build a date string and use Intl to get timezone-aware epoch
  const [hours, minutes] = time.split(':').map(Number)
  // Create a UTC date at midnight, then adjust
  const utcDate = new Date(`${date}T00:00:00Z`)

  // Use Intl to find the timezone offset at this date
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

  // Parse the formatted date to extract parts
  const parts = formatter.formatToParts(utcDate)
  const getPart = (type: string): number => {
    const part = parts.find(p => p.type === type)
    return part ? parseInt(part.value, 10) : 0
  }

  // The timezone's local time at UTC midnight tells us the offset
  const localHourAtUtcMidnight = getPart('hour') === 24 ? 0 : getPart('hour')
  const localMinuteAtUtcMidnight = getPart('minute')
  const localDayAtUtcMidnight = getPart('day')
  const utcDay = utcDate.getUTCDate()

  // Calculate offset: local = UTC + offset
  let offsetMinutes = (localHourAtUtcMidnight * 60 + localMinuteAtUtcMidnight)
  if (localDayAtUtcMidnight > utcDay) {
    // Timezone is ahead (e.g., Asia/Hong_Kong = UTC+8)
    // offsetMinutes is correct as-is
  } else if (localDayAtUtcMidnight < utcDay) {
    // Timezone is behind (e.g., Pacific/Honolulu = UTC-10)
    offsetMinutes = offsetMinutes - 24 * 60
  }
  // If same day, offsetMinutes is already correct (could be 0 or positive/negative small value)

  // Target epoch: the given HH:MM in the target timezone on the given date
  // targetLocal = date + hours:minutes in local time
  // targetUTC = targetLocal - offset
  const targetLocalMinutes = hours * 60 + minutes
  const targetUtcMinutes = targetLocalMinutes - offsetMinutes

  const epoch = new Date(`${date}T00:00:00Z`).getTime() + targetUtcMinutes * 60_000
  return epoch
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
