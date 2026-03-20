import { z } from 'zod'

// ─── Notes ──────────────────────────────────────────────────

export const createNoteSchema = z.object({
  client_id: z.string().uuid(),
  content: z.string().min(1).max(10000),
  source: z.enum(['manual', 'ai_extracted', 'merge_history']).default('manual'),
})

export type CreateNote = z.infer<typeof createNoteSchema>

// ─── Follow-ups ─────────────────────────────────────────────

export const FOLLOW_UP_STATUSES = ['open', 'completed', 'cancelled'] as const
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number]

export const createFollowUpSchema = z.object({
  client_id: z.string().uuid(),
  content: z.string().min(1).max(5000),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
})

export type CreateFollowUp = z.infer<typeof createFollowUpSchema>

export const patchFollowUpSchema = z.object({
  status: z.enum(FOLLOW_UP_STATUSES).optional(),
  content: z.string().min(1).max(5000).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').nullable().optional(),
})

export type PatchFollowUp = z.infer<typeof patchFollowUpSchema>

// ─── Knowledge ──────────────────────────────────────────────

export const createKnowledgeSchema = z.object({
  content: z.string().min(1).max(50000),
  source: z.string().min(1).max(200),
})

export type CreateKnowledge = z.infer<typeof createKnowledgeSchema>

export const patchKnowledgeSchema = z.object({
  content: z.string().min(1).max(50000),
})

export type PatchKnowledge = z.infer<typeof patchKnowledgeSchema>

// ─── Client merge ───────────────────────────────────────────

export const mergeClientsSchema = z.object({
  source_client_id: z.string().uuid(),
  target_client_id: z.string().uuid(),
}).refine(
  (d) => d.source_client_id !== d.target_client_id,
  { message: 'Source and target clients must be different' }
)

export type MergeClients = z.infer<typeof mergeClientsSchema>
