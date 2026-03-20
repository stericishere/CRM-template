import { z } from 'zod'

// ─── Orchestrate endpoint input ─────────────────────────────────────────────
//
// Combined input for the full onboarding pipeline.
// Only business_name, vertical, and timezone are required — everything else
// is optional so the orchestrator can skip steps gracefully.

export const orchestrateSchema = z.object({
  business_name: z.string().min(1).max(300),
  vertical: z.string().min(1).max(100),
  timezone: z.string().min(1).max(100),
  instagram_handle: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  google_auth_code: z.string().min(1).optional(),
})

export type OrchestrateInput = z.infer<typeof orchestrateSchema>

// ─── Step tracking ──────────────────────────────────────────────────────────

export const ORCHESTRATE_STEPS = [
  'identity',
  'instagram_scrape',
  'knowledge_base',
  'embed_knowledge',
  'generate_sops',
  'extract_tone',
  'google_calendar',
  'activate',
] as const

export type OrchestrateStep = (typeof ORCHESTRATE_STEPS)[number]

export interface StepResult {
  step: OrchestrateStep
  success: boolean
  /** Human-readable reason on failure, omitted on success */
  error?: string
  /** Milliseconds elapsed for this step */
  duration_ms: number
  /** Arbitrary data returned by the step (kept lean — no huge payloads) */
  data?: Record<string, unknown>
}

export interface OrchestrateResponse {
  status: 'complete' | 'partial'
  workspace_id: string
  steps_completed: OrchestrateStep[]
  steps_failed: Array<{ step: OrchestrateStep; error: string }>
  steps_skipped: OrchestrateStep[]
  /** Total wall-clock duration for the entire pipeline */
  total_duration_ms: number
  vertical_config: unknown | null
  tone_profile: unknown | null
  capabilities: Record<string, boolean> | null
}
