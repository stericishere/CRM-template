import { z } from 'zod'

// --- Enums -----------------------------------------------------------

export const staffRoleSchema = z.enum(['owner', 'admin', 'member'])
export const staffStatusSchema = z.enum(['active', 'invited', 'removed'])

// --- Invite ----------------------------------------------------------

export const inviteStaffSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']), // cannot invite as owner
})

export type InviteStaffInput = z.infer<typeof inviteStaffSchema>

// --- Update ----------------------------------------------------------

export const updateStaffSchema = z
  .object({
    role: staffRoleSchema.optional(),
    status: staffStatusSchema.optional(),
  })
  .refine((data) => data.role !== undefined || data.status !== undefined, {
    message: 'At least one field must be provided',
  })

export type UpdateStaffInput = z.infer<typeof updateStaffSchema>
