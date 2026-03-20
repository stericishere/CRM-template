// supabase/functions/onboarding-tone/index.ts
//
// Extracts or refines a ToneProfile for a workspace.
// Called by the Next.js API routes during onboarding step 5 ("tone").
//
// Two modes:
//
//  ┌─────────────────┐
//  │  POST body      │
//  │  mode: extract  │─── buildToneExtractionPrompt → FLASH_MODEL → ToneProfile + reasoning
//  │  mode: refine   │─── buildToneAdjustmentPrompt → FLASH_MODEL → ToneProfile
//  └────────┬────────┘
//           │
//           v
//  ┌─────────────────┐
//  │ Save to         │  workspace.tone_profile (JSONB)
//  │ workspaces      │
//  └─────────────────┘

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { callLLM, FLASH_MODEL } from '../_shared/llm-client.ts'
import { buildToneExtractionPrompt } from '../_shared/prompts/tone-extraction.ts'
import { buildToneAdjustmentPrompt } from '../_shared/prompts/tone-adjustment.ts'
import type { ToneProfile } from '../_shared/onboarding-types.ts'
import { parseJsonFromLLM } from '../_shared/llm-json-parser.ts'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    const body = await req.json()
    const { workspace_id, mode } = body

    if (!workspace_id || !mode) {
      return new Response(
        JSON.stringify({ error: 'Missing workspace_id or mode' }),
        { status: 400 }
      )
    }

    if (mode !== 'extract' && mode !== 'refine') {
      return new Response(
        JSON.stringify({ error: 'Invalid mode — must be "extract" or "refine"' }),
        { status: 400 }
      )
    }

    const supabase = getSupabaseClient()

    if (mode === 'extract') {
      return await handleExtract(supabase, body)
    } else {
      return await handleRefine(supabase, body)
    }
  } catch (err) {
    console.error('[onboarding-tone] Error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})

// ─── Extract mode ────────────────────────────────────────────────────────────
//
// extract flow:
//   1. Read workspace row for business_name, vertical, instagram_scrape_data
//   2. If source='instagram': use scraped captions + bio
//      If source='description': use provided content string
//   3. Build prompt → call LLM → parse ToneProfile JSON
//   4. Save to workspace.tone_profile
//   5. Return { tone_profile, reasoning }

async function handleExtract(
  supabase: ReturnType<typeof getSupabaseClient>,
  body: {
    workspace_id: string
    source: 'instagram' | 'description'
    content?: string
  }
): Promise<Response> {
  const { workspace_id, source, content } = body

  if (!source) {
    return new Response(
      JSON.stringify({ error: 'Missing source for extract mode' }),
      { status: 400 }
    )
  }

  // Load workspace data for business context
  const { data: workspace, error: wsError } = await supabase
    .from('workspaces')
    .select('business_name, vertical, instagram_scrape_data')
    .eq('id', workspace_id)
    .single()

  if (wsError || !workspace) {
    const msg = wsError?.message ?? 'Workspace not found'
    console.error('[onboarding-tone] Failed to load workspace:', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 404 })
  }

  const businessName = workspace.business_name ?? 'Unknown Business'
  const vertical = workspace.vertical ?? 'general'

  // Build extraction prompt based on source
  const prompt = await buildToneExtractionPrompt({
    source,
    instagram_data: source === 'instagram' && workspace.instagram_scrape_data
      ? {
          bio: workspace.instagram_scrape_data.bio,
          post_captions: workspace.instagram_scrape_data.post_captions,
        }
      : undefined,
    description: source === 'description' ? content : undefined,
    business_name: businessName,
    vertical,
  })

  const result = await callLLM({
    model: FLASH_MODEL,
    systemPrompt: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    maxTokens: 1024,
  })

  const raw = result.message.content ?? ''
  const toneProfile = validateToneProfile(parseJsonFromLLM<ToneProfile>(raw, 'onboarding-tone'))

  // Persist to workspace
  const { error: updateError } = await supabase
    .from('workspaces')
    .update({ tone_profile: toneProfile })
    .eq('id', workspace_id)

  if (updateError) {
    console.error('[onboarding-tone] Save failed:', updateError.message)
    return new Response(
      JSON.stringify({ error: 'Failed to save tone profile' }),
      { status: 500 }
    )
  }

  console.log(`[onboarding-tone] Extracted tone profile for workspace ${workspace_id}`)

  return new Response(
    JSON.stringify({ tone_profile: toneProfile, reasoning: raw }),
    { status: 200 }
  )
}

// ─── Refine mode ─────────────────────────────────────────────────────────────

async function handleRefine(
  supabase: ReturnType<typeof getSupabaseClient>,
  body: {
    workspace_id: string
    feedback: string
    current_tone: Record<string, unknown>
  }
): Promise<Response> {
  const { workspace_id, feedback, current_tone } = body

  if (!feedback || !current_tone) {
    return new Response(
      JSON.stringify({ error: 'Missing feedback or current_tone for refine mode' }),
      { status: 400 }
    )
  }

  const prompt = await buildToneAdjustmentPrompt({ current_tone, feedback })

  const result = await callLLM({
    model: FLASH_MODEL,
    systemPrompt: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    maxTokens: 1024,
  })

  const raw = result.message.content ?? ''
  const toneProfile = validateToneProfile(parseJsonFromLLM<ToneProfile>(raw, 'onboarding-tone'))

  // Persist updated tone profile
  const { error: updateError } = await supabase
    .from('workspaces')
    .update({ tone_profile: toneProfile })
    .eq('id', workspace_id)

  if (updateError) {
    console.error('[onboarding-tone] Refine save failed:', updateError.message)
    return new Response(
      JSON.stringify({ error: 'Failed to save refined tone profile' }),
      { status: 500 }
    )
  }

  console.log(`[onboarding-tone] Refined tone profile for workspace ${workspace_id}`)

  return new Response(
    JSON.stringify({ tone_profile: toneProfile }),
    { status: 200 }
  )
}

// parseJsonFromLLM imported from _shared/llm-json-parser.ts

const VALID_FORMALITY = new Set(['casual', 'balanced', 'formal'])
const VALID_EMOJI = new Set(['none', 'minimal', 'moderate', 'frequent'])

function validateToneProfile(p: unknown): ToneProfile {
  if (!p || typeof p !== 'object') throw new Error('ToneProfile: not an object')
  const t = p as Record<string, unknown>
  if (typeof t.voice !== 'string') throw new Error('ToneProfile: missing voice')
  if (!VALID_FORMALITY.has(t.formality as string))
    throw new Error(`ToneProfile: invalid formality "${t.formality}"`)
  if (!VALID_EMOJI.has(t.emoji_usage as string))
    throw new Error(`ToneProfile: invalid emoji_usage "${t.emoji_usage}"`)
  if (typeof t.greeting_style !== 'string') throw new Error('ToneProfile: missing greeting_style')
  if (typeof t.sign_off_style !== 'string') throw new Error('ToneProfile: missing sign_off_style')
  return t as unknown as ToneProfile
}
