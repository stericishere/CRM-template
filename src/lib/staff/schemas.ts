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

// Only allow setting status to 'active' or 'removed' via PATCH.
// 'invited' is a system-managed state from the invitation flow —
// owners should not be able to move real members into limbo.
export const updateStaffSchema = z
  .object({
    role: staffRoleSchema.optional(),
    status: z.enum(['active', 'removed']).optional(),
  })
  .refine((data) => data.role !== undefined || data.status !== undefined, {
    message: 'At least one field must be provided',
  })

export type UpdateStaffInput = z.infer<typeof updateStaffSchema>
