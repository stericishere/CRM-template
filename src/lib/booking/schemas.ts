import { z } from 'zod'

// ─── Constants ───────────────────────────────────────────────────────────────

export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
] as const

export type BookingStatus = (typeof BOOKING_STATUSES)[number]

export const CONFIRMATION_STATUSES = [
  'unconfirmed',
  'confirmed',
  'declined',
] as const

export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number]

// ─── Reusable fragments ─────────────────────────────────────────────────────

const isoDateTimeSchema = z.string().datetime({ message: 'Must be ISO 8601 datetime' })

const timeSlotSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
}).refine(
  data => new Date(data.start).getTime() < new Date(data.end).getTime(),
  { message: 'start must be before end' },
)

// ─── API Schemas ─────────────────────────────────────────────────────────────

/** POST /bookings — create a new booking */
export const createBookingSchema = z.object({
  workspace_id: z.string().uuid(),
  client_id: z.string().uuid(),
  appointment_type: z.string().min(1).max(200),
  start_time: isoDateTimeSchema,
  end_time: isoDateTimeSchema,
  notes: z.string().max(2000).optional(),
  google_event_id: z.string().max(500).optional(),
}).refine(
  data => new Date(data.start_time).getTime() < new Date(data.end_time).getTime(),
  { message: 'start_time must be before end_time', path: ['end_time'] },
)

/** PATCH /bookings/:id — update a booking */
export const updateBookingSchema = z.object({
  appointment_type: z.string().min(1).max(200).optional(),
  start_time: isoDateTimeSchema.optional(),
  end_time: isoDateTimeSchema.optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  confirmation_status: z.enum(CONFIRMATION_STATUSES).optional(),
  notes: z.string().max(2000).optional(),
  google_event_id: z.string().max(500).nullable().optional(),
}).refine(
  data => {
    // If both times are provided, start must be before end
    if (data.start_time && data.end_time) {
      return new Date(data.start_time).getTime() < new Date(data.end_time).getTime()
    }
    return true
  },
  { message: 'start_time must be before end_time', path: ['end_time'] },
)

/** POST /bookings/:id/cancel — cancel a booking */
export const cancelBookingSchema = z.object({
  reason: z.string().max(1000).optional(),
  cancel_google_event: z.boolean().default(true),
})

/** GET /bookings/availability — query available slots */
export const availabilityQuerySchema = z.object({
  workspace_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  appointment_type: z.string().min(1).max(200),
  duration_minutes: z.coerce.number().int().min(5).max(480),
  buffer_minutes: z.coerce.number().int().min(0).max(120).default(0),
  timezone: z.string().min(1).max(100).default('UTC'),
})

/** POST /bookings/:id/reschedule — move a booking */
export const rescheduleBookingSchema = z.object({
  new_start_time: isoDateTimeSchema,
  new_end_time: isoDateTimeSchema,
  reason: z.string().max(1000).optional(),
  update_google_event: z.boolean().default(true),
}).refine(
  data => new Date(data.new_start_time).getTime() < new Date(data.new_end_time).getTime(),
  { message: 'new_start_time must be before new_end_time', path: ['new_end_time'] },
)

/** POST /bookings/:id/confirm — client confirms attendance */
export const confirmBookingSchema = z.object({
  confirmation_status: z.enum(['confirmed', 'declined']),
  response_note: z.string().max(500).optional(),
})

/** Shared time slot schema for reuse */
export const timeSlotArraySchema = z.array(timeSlotSchema)

// ─── Legacy aliases (backward compatibility) ─────────────────────────────────

export const bookingStatusSchema = z.enum(BOOKING_STATUSES)
export const confirmationStatusSchema = z.enum(CONFIRMATION_STATUSES)
export const patchBookingSchema = updateBookingSchema

// ─── Inferred types ──────────────────────────────────────────────────────────

export type CreateBooking = z.infer<typeof createBookingSchema>
export type UpdateBooking = z.infer<typeof updateBookingSchema>
export type PatchBooking = z.infer<typeof patchBookingSchema>
export type CancelBooking = z.infer<typeof cancelBookingSchema>
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>
export type RescheduleBooking = z.infer<typeof rescheduleBookingSchema>
export type ConfirmBooking = z.infer<typeof confirmBookingSchema>
export type TimeSlotInput = z.infer<typeof timeSlotSchema>

/** The stored shape in the bookings table */
export interface Booking {
  id: string
  workspace_id: string
  client_id: string
  appointment_type: string
  start_time: string
  end_time: string
  calendar_event_id: string | null
  status: BookingStatus
  confirmation_status: ConfirmationStatus
  notes: string | null
  created_at: string
}
