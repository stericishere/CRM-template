import { z } from 'zod'

export const LIFECYCLE_STATUSES = [
  'open',
  'chosen_service',
  'upcoming_appointment',
  'follow_up',
  'review_complete',
  'inactive',
] as const

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number]

export const lifecycleStatusSchema = z.enum(LIFECYCLE_STATUSES)

export const e164Schema = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Must be E.164 format')

export interface Client {
  id: string
  workspace_id: string
  full_name: string | null
  phone: string
  email: string | null
  lifecycle_status: LifecycleStatus
  tags: string[]
  preferences: Record<string, unknown>
  summary: string | null
  last_contacted_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface ClientProfile {
  id: string
  full_name: string | null
  phone: string
  lifecycle_status: LifecycleStatus
  tags: string[]
  preferences: Record<string, unknown>
}

export const clientPatchSchema = z.object({
  full_name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  tags: z.array(z.string()).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
})

export type ClientPatch = z.infer<typeof clientPatchSchema>

export interface ListClientsOptions {
  lifecycle_status?: LifecycleStatus
  search?: string
  page?: number
  limit?: number
}

export const createClientSchema = z.object({
  phone: e164Schema,
  full_name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
})
