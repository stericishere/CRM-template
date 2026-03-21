import { z } from 'zod'

export const patchRuleSchema = z.object({
  instruction: z.string().min(1).max(2000).optional(),
  active: z.boolean().optional(),
}).refine(data => data.instruction !== undefined || data.active !== undefined, {
  message: 'At least one of instruction or active must be provided',
})

export type PatchRule = z.infer<typeof patchRuleSchema>
