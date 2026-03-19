// supabase/functions/onboarding-sops/index.ts
//
// Generates or refines SOP configuration (VerticalConfig) for a workspace.
// Called by the Next.js API routes during onboarding step 4 ("sops").
//
// Two modes:
//
//  ┌─────────────────┐
//  │  POST body      │
//  │  mode: generate │─── buildDeepResearchSopPrompt → PRO_MODEL → VerticalConfig + reasoning
//  │  mode: refine   │─── buildSopRefinementPrompt   → FLASH_MODEL → VerticalConfig
//  └────────┬────────┘
//           │
//           v
//  ┌─────────────────┐
//  │ Save to         │  workspace.vertical_config (JSONB)
//  │ workspaces      │
//  └─────────────────┘

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { callLLM, PRO_MODEL, FLASH_MODEL } from '../_shared/llm-client.ts'
import { buildDeepResearchSopPrompt } from '../_shared/prompts/deep-research-sop.ts'
import { buildSopRefinementPrompt } from '../_shared/prompts/sop-refinement.ts'
import type { VerticalConfig } from '../_shared/onboarding-types.ts'

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

    if (mode !== 'generate' && mode !== 'refine') {
      return new Response(
        JSON.stringify({ error: 'Invalid mode — must be "generate" or "refine"' }),
        { status: 400 }
      )
    }

    const supabase = getSupabaseClient()

    if (mode === 'generate') {
      return await handleGenerate(supabase, body)
    } else {
      return await handleRefine(supabase, body)
    }
  } catch (err) {
    console.error('[onboarding-sops] Error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})

// ─── Generate mode ──────────────────────────────────────────────────────────

async function handleGenerate(
  supabase: ReturnType<typeof getSupabaseClient>,
  body: {
    workspace_id: string
    vertical: string
    business_name: string
    description?: string
    knowledge_base?: string
  }
): Promise<Response> {
  const { workspace_id, vertical, business_name, description, knowledge_base } = body

  if (!vertical || !business_name) {
    return new Response(
      JSON.stringify({ error: 'Missing vertical or business_name for generate mode' }),
      { status: 400 }
    )
  }

  const prompt = await buildDeepResearchSopPrompt({
    vertical,
    business_name,
    description,
    knowledge_base,
  })

  const result = await callLLM({
    model: PRO_MODEL,
    systemPrompt: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    maxTokens: 4096,
  })

  const raw = result.message.content ?? ''
  const verticalConfig = parseJsonResponse<VerticalConfig>(raw)

  // Persist to workspace
  const { error: updateError } = await supabase
    .from('workspaces')
    .update({ vertical_config: verticalConfig })
    .eq('id', workspace_id)

  if (updateError) {
    console.error('[onboarding-sops] Save failed:', updateError.message)
    return new Response(
      JSON.stringify({ error: 'Failed to save vertical config' }),
      { status: 500 }
    )
  }

  console.log(`[onboarding-sops] Generated SOP config for workspace ${workspace_id}`)

  return new Response(
    JSON.stringify({ vertical_config: verticalConfig, reasoning: raw }),
    { status: 200 }
  )
}

// ─── Refine mode ────────────────────────────────────────────────────────────

async function handleRefine(
  supabase: ReturnType<typeof getSupabaseClient>,
  body: {
    workspace_id: string
    instruction: string
    current_config: Record<string, unknown>
  }
): Promise<Response> {
  const { workspace_id, instruction, current_config } = body

  if (!instruction || !current_config) {
    return new Response(
      JSON.stringify({ error: 'Missing instruction or current_config for refine mode' }),
      { status: 400 }
    )
  }

  const prompt = await buildSopRefinementPrompt({ current_config, instruction })

  const result = await callLLM({
    model: FLASH_MODEL,
    systemPrompt: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    maxTokens: 4096,
  })

  const raw = result.message.content ?? ''
  const verticalConfig = parseJsonResponse<VerticalConfig>(raw)

  // Persist updated config
  const { error: updateError } = await supabase
    .from('workspaces')
    .update({ vertical_config: verticalConfig })
    .eq('id', workspace_id)

  if (updateError) {
    console.error('[onboarding-sops] Refine save failed:', updateError.message)
    return new Response(
      JSON.stringify({ error: 'Failed to save refined config' }),
      { status: 500 }
    )
  }

  console.log(`[onboarding-sops] Refined SOP config for workspace ${workspace_id}`)

  return new Response(
    JSON.stringify({ vertical_config: verticalConfig }),
    { status: 200 }
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extracts JSON from an LLM response, stripping markdown fences if present.
 * Throws on invalid JSON so the caller returns a 500.
 */
function parseJsonResponse<T>(raw: string): T {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.trim()

  try {
    return JSON.parse(jsonStr) as T
  } catch {
    console.error('[onboarding-sops] Failed to parse LLM JSON:', jsonStr.slice(0, 500))
    throw new Error('LLM returned invalid JSON — retry or refine the prompt')
  }
}
