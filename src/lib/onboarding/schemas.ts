import { z } from 'zod'

// ─── Constants ───────────────────────────────────────────────────────────────

export const ONBOARDING_STEPS = [
  'whatsapp',
  'identity',
  'knowledge',
  'sops',
  'tone',
  'activation',
] as const

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export const ONBOARDING_STATUSES = ['pending', 'in_progress', 'complete'] as const
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number]

// ─── Reusable fragments ─────────────────────────────────────────────────────

const e164Schema = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Must be E.164 format')

// ─── Step schemas ────────────────────────────────────────────────────────────

/** POST /onboarding/start — create workspace + owner record */
export const startOnboardingSchema = z.object({
  owner_name: z.string().min(1).max(200),
  owner_phone: e164Schema,
  owner_email: z.string().email().optional(),
})

/** PUT /onboarding/:id/identity — set business identity */
export const identitySchema = z.object({
  business_name: z.string().min(1).max(300),
  vertical: z.string().min(1).max(100),
  timezone: z.string().min(1).max(100), // e.g. "Asia/Hong_Kong"
  instagram_handle: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
})

/** PUT /onboarding/:id/knowledge-base — store raw knowledge base text */
export const knowledgeBaseSchema = z.object({
  content: z.string().min(10).max(50000),
  source: z.string().default('onboarding'),
})

/** POST /onboarding/:id/scrape-instagram — trigger IG scrape */
export const scrapeInstagramSchema = z.object({
  handle: z.string().min(1).max(100),
})

/** POST /onboarding/:id/generate-sops — AI-generate vertical config */
export const generateSopsSchema = z.object({
  vertical: z.string().min(1).max(100),
  business_name: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  knowledge_base: z.string().max(50000).optional(),
})

/** POST /onboarding/:id/refine-sops — iterate on generated config */
export const refineSopsSchema = z.object({
  instruction: z.string().min(1).max(2000),
  current_config: z.record(z.string(), z.unknown()),
})

/** PUT /onboarding/:id/confirm-sops — lock in vertical_config */
export const confirmSopsSchema = z.object({
  vertical_config: z.object({
    sop_rules: z.array(z.string()),
    custom_fields: z.array(
      z.object({
        name: z.string().min(1),
        description: z.string(),
      }),
    ),
    appointment_types: z.array(
      z.object({
        name: z.string().min(1),
        description: z.string(),
        duration_minutes: z.number().int().positive(),
        prerequisites: z.array(z.string()).optional(),
      }),
    ),
    lifecycle_stages: z.array(z.string()).optional(),
    business_hours: z
      .record(
        z.string(),
        z.object({
          open: z.string(),
          close: z.string(),
        }),
      )
      .optional(),
  }),
})

/** POST /onboarding/:id/extract-tone — AI-extract tone from content */
export const extractToneSchema = z.object({
  source: z.enum(['instagram', 'description']),
  content: z.string().max(50000).optional(), // required when source = 'description'
})

/** POST /onboarding/:id/refine-tone — iterate on extracted tone */
export const refineToneSchema = z.object({
  feedback: z.string().min(1).max(2000),
  current_tone: z.record(z.string(), z.unknown()),
})

/** PUT /onboarding/:id/confirm-tone — lock in tone profile */
export const confirmToneSchema = z.object({
  tone_profile: z.object({
    voice: z.string(), // e.g. "warm and professional"
    formality: z.enum(['casual', 'balanced', 'formal']),
    emoji_usage: z.enum(['none', 'minimal', 'moderate', 'frequent']),
    greeting_style: z.string(),
    sign_off_style: z.string(),
    sample_responses: z.array(z.string()).optional(),
  }),
})

// ─── Inferred types ──────────────────────────────────────────────────────────

export type StartOnboarding = z.infer<typeof startOnboardingSchema>
export type Identity = z.infer<typeof identitySchema>
export type KnowledgeBase = z.infer<typeof knowledgeBaseSchema>
export type ScrapeInstagram = z.infer<typeof scrapeInstagramSchema>
export type GenerateSops = z.infer<typeof generateSopsSchema>
export type RefineSops = z.infer<typeof refineSopsSchema>
export type ConfirmSops = z.infer<typeof confirmSopsSchema>
export type ExtractTone = z.infer<typeof extractToneSchema>
export type RefineTone = z.infer<typeof refineToneSchema>
export type ConfirmTone = z.infer<typeof confirmToneSchema>

/** The stored shape in workspace.vertical_config JSONB column */
export type VerticalConfig = ConfirmSops['vertical_config']

/** Tone profile (stored alongside vertical_config) */
export type ToneProfile = ConfirmTone['tone_profile']
