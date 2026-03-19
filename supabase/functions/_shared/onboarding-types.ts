// Types for onboarding Edge Functions
// Mirrors src/lib/onboarding/schemas.ts but without Zod dependency
// (Edge Functions run in Deno — keep imports lightweight)

// ─── Domain types ────────────────────────────────────────────────────────────

export interface VerticalConfig {
  sop_rules: string[]
  custom_fields: Array<{ name: string; description: string }>
  appointment_types: Array<{
    name: string
    description: string
    duration_minutes: number
    prerequisites?: string[]
  }>
  lifecycle_stages?: string[]
  business_hours?: Record<string, { open: string; close: string }>
}

export interface ToneProfile {
  voice: string
  formality: 'casual' | 'balanced' | 'formal'
  emoji_usage: 'none' | 'minimal' | 'moderate' | 'frequent'
  greeting_style: string
  sign_off_style: string
  sample_responses?: string[]
}

export interface InstagramScrapeData {
  handle: string
  bio: string | null
  business_category: string | null
  post_captions: string[]
  scraped_at: string
  is_private: boolean
}

// ─── Row shape (workspace with onboarding columns) ───────────────────────────

export interface OnboardingWorkspace {
  id: string
  business_name: string | null
  vertical: string | null
  timezone: string | null
  knowledge_base: string | null
  whatsapp_connection_status: string
  whatsapp_phone_number: string | null
  instagram_scrape_data: InstagramScrapeData | null
  onboarding_status: string
  vertical_config: VerticalConfig | null
  tone_profile: ToneProfile | null
}

// ─── AI generation payloads ──────────────────────────────────────────────────

/** Returned by the knowledge-base structuring step */
export interface KnowledgeBaseGeneration {
  structured_kb: string
  sections: Array<{
    title: string
    content: string
  }>
}

/** Returned by the SOP generation Edge Function */
export interface SopGeneration {
  vertical_config: VerticalConfig
  reasoning: string
}

/** Returned by the tone extraction Edge Function */
export interface ToneExtraction {
  tone_profile: ToneProfile
  reasoning: string
}
