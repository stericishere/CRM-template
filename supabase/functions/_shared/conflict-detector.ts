// Dual-source conflict detection (F-07)
// Checks for scheduling conflicts across both:
// 1. Google Calendar busy intervals (passed in, already fetched)
// 2. Bookings table in Supabase (queried live)
//
// ┌──────────────┐     ┌───────────────────┐
// │ Google Cal    │     │ bookings table    │
// │ busy intervals│     │ (DB query)        │
// └──────┬───────┘     └────────┬──────────┘
//        │                      │
//        └──────────┬───────────┘
//                   ▼
//          ┌────────────────┐
//          │ Conflict Check │
//          └────────────────┘

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { TimeSlot } from './availability.ts'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConflictResult {
  hasConflict: boolean
  conflictingEvents: string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function intervalsOverlap(
  aStart: number, aEnd: number,
  bStart: number, bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd
}

// ─── Main function ───────────────────────────────────────────────────────────

/**
 * Detect scheduling conflicts for a proposed time range.
 *
 * Checks two sources:
 * 1. `calendarBusy` — pre-fetched Google Calendar busy intervals (optional)
 * 2. `bookings` table — queries Supabase for overlapping confirmed/pending bookings
 *
 * Returns a list of human-readable conflict descriptions.
 */
export async function detectConflicts(
  supabase: SupabaseClient,
  workspaceId: string,
  startTime: string,
  endTime: string,
  calendarBusy?: TimeSlot[],
): Promise<ConflictResult> {
  const conflictingEvents: string[] = []
  const proposedStart = new Date(startTime).getTime()
  const proposedEnd = new Date(endTime).getTime()

  if (proposedStart >= proposedEnd) {
    return {
      hasConflict: true,
      conflictingEvents: ['Invalid time range: start must be before end'],
    }
  }

  // Source 1: Google Calendar busy intervals
  if (calendarBusy && calendarBusy.length > 0) {
    for (const busy of calendarBusy) {
      const busyStart = new Date(busy.start).getTime()
      const busyEnd = new Date(busy.end).getTime()

      if (intervalsOverlap(proposedStart, proposedEnd, busyStart, busyEnd)) {
        conflictingEvents.push(
          `Google Calendar event: ${busy.start} - ${busy.end}`
        )
      }
    }
  }

  // Source 2: Bookings table — overlapping confirmed or pending bookings
  // Overlap condition: existing.start < proposed.end AND existing.end > proposed.start
  const { data: overlapping, error } = await supabase
    .from('bookings')
    .select('id, appointment_type, start_time, end_time, status')
    .eq('workspace_id', workspaceId)
    .in('status', ['confirmed', 'pending'])
    .lt('start_time', endTime)
    .gt('end_time', startTime)

  if (error) {
    console.error('[conflict-detector] Failed to query bookings:', error.message)
    // Fail open but flag it — caller decides whether to proceed
    conflictingEvents.push(`Database query failed: ${error.message}`)
  } else if (overlapping && overlapping.length > 0) {
    for (const booking of overlapping) {
      conflictingEvents.push(
        `Existing booking (${booking.appointment_type}): ${booking.start_time} - ${booking.end_time} [${booking.status}]`
      )
    }
  }

  return {
    hasConflict: conflictingEvents.length > 0,
    conflictingEvents,
  }
}
