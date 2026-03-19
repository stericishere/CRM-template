import { describe, it, expect } from 'vitest'

// ─── Inline implementation of calculateAvailableSlots ────────────────────────
// Re-implemented here as a pure function to avoid importing from supabase/functions
// (which uses Deno imports). The canonical implementation lives in
// supabase/functions/_shared/availability.ts — keep them in sync.

interface TimeSlot {
  start: string
  end: string
}

interface AvailabilityParams {
  date: string
  businessHours: { open: string; close: string }
  busyIntervals: TimeSlot[]
  existingBookings: TimeSlot[]
  slotDurationMinutes: number
  bufferMinutes?: number
  timezone: string
}

/**
 * Build an epoch ms timestamp for a HH:MM time on a given date in a timezone.
 * Uses Intl.DateTimeFormat to resolve the timezone offset.
 */
function parseTimeInTimezone(date: string, time: string, timezone: string): number {
  const parts_ = time.split(':').map(Number)
  const hours = parts_[0] ?? 0
  const minutes = parts_[1] ?? 0
  const utcDate = new Date(`${date}T00:00:00Z`)

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

  const parts = formatter.formatToParts(utcDate)
  const getPart = (type: string): number => {
    const part = parts.find(p => p.type === type)
    return part ? parseInt(part.value, 10) : 0
  }

  const localHourAtUtcMidnight = getPart('hour') === 24 ? 0 : getPart('hour')
  const localMinuteAtUtcMidnight = getPart('minute')
  const localDayAtUtcMidnight = getPart('day')
  const utcDay = utcDate.getUTCDate()

  let offsetMinutes = localHourAtUtcMidnight * 60 + localMinuteAtUtcMidnight
  if (localDayAtUtcMidnight > utcDay) {
    // Timezone is ahead (positive offset)
  } else if (localDayAtUtcMidnight < utcDay) {
    offsetMinutes = offsetMinutes - 24 * 60
  }

  const targetLocalMinutes = hours * 60 + minutes
  const targetUtcMinutes = targetLocalMinutes - offsetMinutes

  return new Date(`${date}T00:00:00Z`).getTime() + targetUtcMinutes * 60_000
}

function intervalsOverlap(
  aStart: number, aEnd: number,
  bStart: number, bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd
}

function calculateAvailableSlots(params: AvailabilityParams): TimeSlot[] {
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

  const blocked: Array<{ start: number; end: number }> = []

  for (const interval of [...busyIntervals, ...existingBookings]) {
    const iStart = new Date(interval.start).getTime()
    const iEnd = new Date(interval.end).getTime()
    blocked.push({
      start: iStart - bufferMs,
      end: iEnd + bufferMs,
    })
  }

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

// ─── Tests ───────────────────────────────────────────────────────────────────
// All tests use UTC to avoid timezone-related flakiness in CI.

describe('calculateAvailableSlots', () => {
  const defaultParams: AvailabilityParams = {
    date: '2026-03-20',
    businessHours: { open: '09:00', close: '17:00' },
    busyIntervals: [],
    existingBookings: [],
    slotDurationMinutes: 30,
    bufferMinutes: 0,
    timezone: 'UTC',
  }

  // ── Basic slot generation ──────────────────────────────────────────────

  describe('basic slot generation', () => {
    it('should generate correct number of 30-min slots for 8-hour day', () => {
      const slots = calculateAvailableSlots(defaultParams)
      // 8 hours = 480 minutes / 30 = 16 slots
      expect(slots).toHaveLength(16)
    })

    it('should generate correct number of 60-min slots', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        slotDurationMinutes: 60,
      })
      // 8 hours / 60 min = 8 slots
      expect(slots).toHaveLength(8)
    })

    it('should generate correct number of 15-min slots', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        slotDurationMinutes: 15,
      })
      // 8 hours = 480 min / 15 = 32 slots
      expect(slots).toHaveLength(32)
    })

    it('should produce slots with correct start/end times', () => {
      const slots = calculateAvailableSlots(defaultParams)
      expect(slots[0]!.start).toBe('2026-03-20T09:00:00.000Z')
      expect(slots[0]!.end).toBe('2026-03-20T09:30:00.000Z')
      expect(slots[1]!.start).toBe('2026-03-20T09:30:00.000Z')
      expect(slots[1]!.end).toBe('2026-03-20T10:00:00.000Z')
    })

    it('should produce the last slot ending exactly at close time', () => {
      const slots = calculateAvailableSlots(defaultParams)
      const lastSlot = slots[slots.length - 1]!
      expect(lastSlot.end).toBe('2026-03-20T17:00:00.000Z')
    })

    it('should not generate a partial slot that exceeds close time', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        businessHours: { open: '09:00', close: '09:45' },
        slotDurationMinutes: 30,
      })
      // 45 min window, 30 min slots -> 1 slot (09:00-09:30), 09:30-10:00 would exceed
      expect(slots).toHaveLength(1)
      expect(slots[0]!.start).toBe('2026-03-20T09:00:00.000Z')
      expect(slots[0]!.end).toBe('2026-03-20T09:30:00.000Z')
    })
  })

  // ── Busy interval exclusion ────────────────────────────────────────────

  describe('busy interval exclusion', () => {
    it('should exclude slots that overlap a busy interval', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          { start: '2026-03-20T10:00:00.000Z', end: '2026-03-20T11:00:00.000Z' },
        ],
      })
      // 16 total - 2 blocked (10:00-10:30, 10:30-11:00) = 14
      expect(slots).toHaveLength(14)

      // Verify the blocked slots are absent
      const startTimes = slots.map(s => s.start)
      expect(startTimes).not.toContain('2026-03-20T10:00:00.000Z')
      expect(startTimes).not.toContain('2026-03-20T10:30:00.000Z')
    })

    it('should exclude slots for multiple busy intervals', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          { start: '2026-03-20T09:00:00.000Z', end: '2026-03-20T09:30:00.000Z' },
          { start: '2026-03-20T12:00:00.000Z', end: '2026-03-20T13:00:00.000Z' },
        ],
      })
      // 16 total - 1 (09:00) - 2 (12:00, 12:30) = 13
      expect(slots).toHaveLength(13)
    })

    it('should handle busy interval that partially overlaps a slot', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          // Starts at 10:15, overlaps with the 10:00-10:30 slot
          { start: '2026-03-20T10:15:00.000Z', end: '2026-03-20T10:45:00.000Z' },
        ],
      })
      // Both 10:00-10:30 and 10:30-11:00 are blocked by the 10:15-10:45 interval
      expect(slots).toHaveLength(14)
    })
  })

  // ── Existing booking exclusion ─────────────────────────────────────────

  describe('existing booking exclusion', () => {
    it('should exclude slots that overlap existing bookings', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        existingBookings: [
          { start: '2026-03-20T14:00:00.000Z', end: '2026-03-20T15:00:00.000Z' },
        ],
      })
      // 16 - 2 = 14
      expect(slots).toHaveLength(14)
    })

    it('should handle combined busy intervals and existing bookings', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          { start: '2026-03-20T09:00:00.000Z', end: '2026-03-20T10:00:00.000Z' },
        ],
        existingBookings: [
          { start: '2026-03-20T14:00:00.000Z', end: '2026-03-20T15:00:00.000Z' },
        ],
      })
      // 16 - 2 (busy) - 2 (booking) = 12
      expect(slots).toHaveLength(12)
    })
  })

  // ── Buffer handling ────────────────────────────────────────────────────

  describe('buffer handling', () => {
    it('should expand blocked intervals by buffer minutes', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          { start: '2026-03-20T12:00:00.000Z', end: '2026-03-20T12:30:00.000Z' },
        ],
        bufferMinutes: 15,
      })
      // The 12:00-12:30 busy interval expands to 11:45-12:45 with 15-min buffer
      // Blocked slots: 11:30-12:00 (overlaps 11:45), 12:00-12:30, 12:30-13:00 (overlaps to 12:45)
      // 16 - 3 = 13
      expect(slots).toHaveLength(13)

      const startTimes = slots.map(s => s.start)
      expect(startTimes).not.toContain('2026-03-20T11:30:00.000Z')
      expect(startTimes).not.toContain('2026-03-20T12:00:00.000Z')
      expect(startTimes).not.toContain('2026-03-20T12:30:00.000Z')
    })

    it('should work with zero buffer (default)', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          { start: '2026-03-20T12:00:00.000Z', end: '2026-03-20T12:30:00.000Z' },
        ],
        // bufferMinutes omitted, defaults to 0
      })
      // Only 12:00-12:30 is blocked
      expect(slots).toHaveLength(15)
    })

    it('should handle large buffer that blocks adjacent slots', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          { start: '2026-03-20T12:00:00.000Z', end: '2026-03-20T12:30:00.000Z' },
        ],
        bufferMinutes: 30,
      })
      // Expands to 11:30-13:00 -> blocks 11:30, 12:00, 12:30 = 3 slots
      // 16 - 3 = 13
      expect(slots).toHaveLength(13)
    })
  })

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should return empty array when business hours are zero', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        businessHours: { open: '12:00', close: '12:00' },
      })
      expect(slots).toHaveLength(0)
    })

    it('should return empty array when open > close', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        businessHours: { open: '18:00', close: '09:00' },
      })
      expect(slots).toHaveLength(0)
    })

    it('should return empty array for zero duration', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        slotDurationMinutes: 0,
      })
      expect(slots).toHaveLength(0)
    })

    it('should return empty array for negative duration', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        slotDurationMinutes: -30,
      })
      expect(slots).toHaveLength(0)
    })

    it('should return empty array when fully booked', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          { start: '2026-03-20T09:00:00.000Z', end: '2026-03-20T17:00:00.000Z' },
        ],
      })
      expect(slots).toHaveLength(0)
    })

    it('should return empty when slot duration exceeds business hours window', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        businessHours: { open: '09:00', close: '09:20' },
        slotDurationMinutes: 30,
      })
      expect(slots).toHaveLength(0)
    })

    it('should handle a single available slot', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        businessHours: { open: '09:00', close: '09:30' },
        slotDurationMinutes: 30,
      })
      expect(slots).toHaveLength(1)
      expect(slots[0]!.start).toBe('2026-03-20T09:00:00.000Z')
      expect(slots[0]!.end).toBe('2026-03-20T09:30:00.000Z')
    })

    it('should handle busy interval outside business hours (no effect)', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          { start: '2026-03-20T07:00:00.000Z', end: '2026-03-20T08:00:00.000Z' },
          { start: '2026-03-20T18:00:00.000Z', end: '2026-03-20T20:00:00.000Z' },
        ],
      })
      // No effect — all 16 slots remain
      expect(slots).toHaveLength(16)
    })

    it('should handle overlapping busy intervals correctly', () => {
      const slots = calculateAvailableSlots({
        ...defaultParams,
        busyIntervals: [
          { start: '2026-03-20T10:00:00.000Z', end: '2026-03-20T11:00:00.000Z' },
          { start: '2026-03-20T10:30:00.000Z', end: '2026-03-20T11:30:00.000Z' },
        ],
      })
      // Blocks: 10:00, 10:30, 11:00 = 3 slots
      // 16 - 3 = 13
      expect(slots).toHaveLength(13)
    })
  })

  // ── Timezone handling ──────────────────────────────────────────────────

  describe('timezone handling', () => {
    it('should produce different UTC times for different timezones', () => {
      const utcSlots = calculateAvailableSlots({
        ...defaultParams,
        timezone: 'UTC',
      })

      const hkSlots = calculateAvailableSlots({
        ...defaultParams,
        timezone: 'Asia/Hong_Kong',
      })

      // Both should have 16 slots (same business hours window)
      expect(utcSlots).toHaveLength(16)
      expect(hkSlots).toHaveLength(16)

      // But the UTC representations should differ
      // UTC 09:00 vs HK 09:00 (which is UTC 01:00)
      expect(utcSlots[0]!.start).toBe('2026-03-20T09:00:00.000Z')
      expect(hkSlots[0]!.start).toBe('2026-03-20T01:00:00.000Z')
    })
  })
})

// ─── Booking schemas tests ───────────────────────────────────────────────────

import {
  createBookingSchema,
  updateBookingSchema,
  cancelBookingSchema,
  availabilityQuerySchema,
  rescheduleBookingSchema,
  confirmBookingSchema,
} from '../schemas'

describe('Booking Schemas', () => {
  describe('createBookingSchema', () => {
    it('should accept valid booking', () => {
      const result = createBookingSchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        client_id: '550e8400-e29b-41d4-a716-446655440001',
        appointment_type: 'Thai Massage',
        start_time: '2026-03-20T10:00:00.000Z',
        end_time: '2026-03-20T11:00:00.000Z',
      })
      expect(result.success).toBe(true)
    })

    it('should accept booking with optional fields', () => {
      const result = createBookingSchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        client_id: '550e8400-e29b-41d4-a716-446655440001',
        appointment_type: 'Deep Cleaning',
        start_time: '2026-03-20T14:00:00.000Z',
        end_time: '2026-03-20T15:30:00.000Z',
        notes: 'First-time client, nervous about procedure',
        google_event_id: 'abc123',
      })
      expect(result.success).toBe(true)
    })

    it('should reject when start_time >= end_time', () => {
      const result = createBookingSchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        client_id: '550e8400-e29b-41d4-a716-446655440001',
        appointment_type: 'Massage',
        start_time: '2026-03-20T11:00:00.000Z',
        end_time: '2026-03-20T10:00:00.000Z',
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid UUID for workspace_id', () => {
      const result = createBookingSchema.safeParse({
        workspace_id: 'not-a-uuid',
        client_id: '550e8400-e29b-41d4-a716-446655440001',
        appointment_type: 'Massage',
        start_time: '2026-03-20T10:00:00.000Z',
        end_time: '2026-03-20T11:00:00.000Z',
      })
      expect(result.success).toBe(false)
    })

    it('should reject empty appointment_type', () => {
      const result = createBookingSchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        client_id: '550e8400-e29b-41d4-a716-446655440001',
        appointment_type: '',
        start_time: '2026-03-20T10:00:00.000Z',
        end_time: '2026-03-20T11:00:00.000Z',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('updateBookingSchema', () => {
    it('should accept partial update with status only', () => {
      const result = updateBookingSchema.safeParse({
        status: 'confirmed',
      })
      expect(result.success).toBe(true)
    })

    it('should accept full update', () => {
      const result = updateBookingSchema.safeParse({
        appointment_type: 'Swedish Massage',
        start_time: '2026-03-20T10:00:00.000Z',
        end_time: '2026-03-20T11:00:00.000Z',
        status: 'confirmed',
        confirmation_status: 'confirmed',
        notes: 'Updated notes',
      })
      expect(result.success).toBe(true)
    })

    it('should reject invalid status', () => {
      const result = updateBookingSchema.safeParse({
        status: 'invalid_status',
      })
      expect(result.success).toBe(false)
    })

    it('should reject when both times provided and start >= end', () => {
      const result = updateBookingSchema.safeParse({
        start_time: '2026-03-20T11:00:00.000Z',
        end_time: '2026-03-20T10:00:00.000Z',
      })
      expect(result.success).toBe(false)
    })

    it('should allow nullable google_event_id', () => {
      const result = updateBookingSchema.safeParse({
        google_event_id: null,
      })
      expect(result.success).toBe(true)
    })
  })

  describe('cancelBookingSchema', () => {
    it('should accept with reason', () => {
      const result = cancelBookingSchema.safeParse({
        reason: 'Client requested cancellation',
      })
      expect(result.success).toBe(true)
    })

    it('should accept empty object (reason optional)', () => {
      const result = cancelBookingSchema.safeParse({})
      expect(result.success).toBe(true)
    })

    it('should default cancel_google_event to true', () => {
      const result = cancelBookingSchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.cancel_google_event).toBe(true)
      }
    })
  })

  describe('availabilityQuerySchema', () => {
    it('should accept valid query', () => {
      const result = availabilityQuerySchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        date: '2026-03-20',
        appointment_type: 'Massage',
        duration_minutes: 60,
      })
      expect(result.success).toBe(true)
    })

    it('should coerce string duration_minutes to number', () => {
      const result = availabilityQuerySchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        date: '2026-03-20',
        appointment_type: 'Massage',
        duration_minutes: '30',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.duration_minutes).toBe(30)
      }
    })

    it('should reject invalid date format', () => {
      const result = availabilityQuerySchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        date: '20-03-2026',
        appointment_type: 'Massage',
        duration_minutes: 30,
      })
      expect(result.success).toBe(false)
    })

    it('should reject duration < 5 minutes', () => {
      const result = availabilityQuerySchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        date: '2026-03-20',
        appointment_type: 'Massage',
        duration_minutes: 2,
      })
      expect(result.success).toBe(false)
    })

    it('should reject duration > 480 minutes', () => {
      const result = availabilityQuerySchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        date: '2026-03-20',
        appointment_type: 'Massage',
        duration_minutes: 500,
      })
      expect(result.success).toBe(false)
    })

    it('should default timezone to UTC', () => {
      const result = availabilityQuerySchema.safeParse({
        workspace_id: '550e8400-e29b-41d4-a716-446655440000',
        date: '2026-03-20',
        appointment_type: 'Massage',
        duration_minutes: 30,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.timezone).toBe('UTC')
      }
    })
  })

  describe('rescheduleBookingSchema', () => {
    it('should accept valid reschedule', () => {
      const result = rescheduleBookingSchema.safeParse({
        new_start_time: '2026-03-21T10:00:00.000Z',
        new_end_time: '2026-03-21T11:00:00.000Z',
      })
      expect(result.success).toBe(true)
    })

    it('should reject when new_start >= new_end', () => {
      const result = rescheduleBookingSchema.safeParse({
        new_start_time: '2026-03-21T11:00:00.000Z',
        new_end_time: '2026-03-21T10:00:00.000Z',
      })
      expect(result.success).toBe(false)
    })

    it('should default update_google_event to true', () => {
      const result = rescheduleBookingSchema.safeParse({
        new_start_time: '2026-03-21T10:00:00.000Z',
        new_end_time: '2026-03-21T11:00:00.000Z',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.update_google_event).toBe(true)
      }
    })
  })

  describe('confirmBookingSchema', () => {
    it('should accept confirmed status', () => {
      const result = confirmBookingSchema.safeParse({
        confirmation_status: 'confirmed',
      })
      expect(result.success).toBe(true)
    })

    it('should accept declined status with note', () => {
      const result = confirmBookingSchema.safeParse({
        confirmation_status: 'declined',
        response_note: 'Cannot make it, will reschedule',
      })
      expect(result.success).toBe(true)
    })

    it('should reject invalid confirmation_status', () => {
      const result = confirmBookingSchema.safeParse({
        confirmation_status: 'maybe',
      })
      expect(result.success).toBe(false)
    })
  })
})
