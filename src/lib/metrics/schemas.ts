import { z } from 'zod'

// ─── Metrics query parameters ─────────────────────────────

export const daysParam = z.coerce.number().int().min(1).max(365).default(30)

export type DaysParam = z.infer<typeof daysParam>

// ─── Staff action values (mirrors chk_staff_action constraint) ──

export const STAFF_ACTIONS = [
  'sent_as_is',
  'edited_and_sent',
  'regenerated',
  'discarded',
] as const

export type StaffAction = (typeof STAFF_ACTIONS)[number]

// ─── Acceptance metrics response ──────────────────────────

export interface AcceptanceMetrics {
  acceptance_rate: number | null
  total_signals: number
  by_action: Record<StaffAction, number>
  by_scenario: Record<string, { total: number; accepted: number; rate: number }>
  insufficient_data: boolean
}

// ─── Reply metrics response ───────────────────────────────

export interface ReplyMetrics {
  reply_rate: number | null
  total_tracked: number
  replied: number
  median_latency_minutes: number | null
  p90_latency_minutes: number | null
  pending: number
  insufficient_data: boolean
}

// ─── Thresholds ───────────────────────────────────────────

/** Minimum number of signals before metrics are considered reliable */
export const INSUFFICIENT_DATA_THRESHOLD = 10

/** Hours within which a reply is still considered "pending" (not timed out) */
export const REPLY_PENDING_WINDOW_HOURS = 72
