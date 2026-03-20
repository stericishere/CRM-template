// Booking prerequisite checking (F-07)
// Pure function — no DB access, no side effects.
//
// Example rule: "deep_cleaning" requires ["initial_consultation"]
// A client must have a completed booking of type "initial_consultation"
// before they can book a "deep_cleaning".

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BookingPrereqCheck {
  allowed: boolean
  reason?: string
}

export interface ClientBookingRecord {
  appointment_type: string
  status: string
}

// Statuses that count as "completed" for prerequisite purposes
const COMPLETED_STATUSES = new Set(['completed', 'confirmed', 'attended'])

// ─── Main function ───────────────────────────────────────────────────────────

/**
 * Check if a client meets prerequisites for an appointment type.
 *
 * Rules:
 * - If `prerequisites` is empty, booking is always allowed.
 * - Each prerequisite is an appointment_type string that must exist
 *   in `clientBookings` with a completed status.
 * - Returns all missing prerequisites in the reason string.
 */
export function checkBookingPrerequisites(
  appointmentType: string,
  prerequisites: string[],
  clientBookings: ClientBookingRecord[],
): BookingPrereqCheck {
  if (prerequisites.length === 0) {
    return { allowed: true }
  }

  // Build a set of completed appointment types for O(1) lookup
  const completedTypes = new Set(
    clientBookings
      .filter(b => COMPLETED_STATUSES.has(b.status))
      .map(b => b.appointment_type)
  )

  const missing = prerequisites.filter(prereq => !completedTypes.has(prereq))

  if (missing.length === 0) {
    return { allowed: true }
  }

  const formattedMissing = missing.map(m => `"${m}"`).join(', ')
  return {
    allowed: false,
    reason: `Cannot book "${appointmentType}": missing prerequisite(s) ${formattedMissing}. `
      + `Please complete ${missing.length === 1 ? 'this appointment' : 'these appointments'} first.`,
  }
}
