// supabase/functions/onboarding-scrape/index.ts
//
// Scrapes an Instagram profile and generates a structured knowledge base via LLM.
// Called during workspace onboarding (F-01) to bootstrap the KB from social presence.
//
// Flow:
//
//   POST /onboarding-scrape { workspace_id, handle }
//        |
//        +-- validate inputs
//        |
//        +-- scrapeInstagramProfile(handle)
//        |     +-- success -> profile data
//        |     +-- fail    -> return { profile: null, knowledge_base: null }
//        |
//        +-- buildInstagramToKnowledgePrompt(profile)
//        |
//        +-- callLLM(prompt) -> parse JSON response
//        |
//        +-- UPDATE workspace SET instagram_scrape_data, knowledge_base
//        |
//        +-- return { profile, knowledge_base }

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { scrapeInstagramProfile } from '../_shared/instagram-scraper.ts'
import { callLLM, FLASH_MODEL } from '../_shared/llm-client.ts'
import { buildInstagramToKnowledgePrompt } from '../_shared/prompts/instagram-to-knowledge.ts'
import type { InstagramScrapeData, KnowledgeBaseGeneration } from '../_shared/onboarding-types.ts'

const LOG_PREFIX = '[onboarding-scrape]'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    // ── 1. Validate inputs ──────────────────────────────────────────────────

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400 }
      )
    }

    const { workspace_id, handle } = body as { workspace_id?: string; handle?: string }

    if (!workspace_id || typeof workspace_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid workspace_id' }),
        { status: 400 }
      )
    }

    if (!handle || typeof handle !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid handle' }),
        { status: 400 }
      )
    }

    console.log(`${LOG_PREFIX} Starting scrape for @${handle} (workspace: ${workspace_id})`)

    // ── 2. Scrape Instagram profile ─────────────────────────────────────────

    const scrapeResult = await scrapeInstagramProfile(handle)

    if (!scrapeResult.success || !scrapeResult.profile) {
      console.warn(`${LOG_PREFIX} Scrape failed for @${handle}: ${scrapeResult.error ?? 'unknown'}`)
      return new Response(
        JSON.stringify({
          profile: null,
          knowledge_base: null,
          scrape_error: scrapeResult.error ?? 'Scrape failed',
        }),
        { status: 200 }
      )
    }

    const profile = scrapeResult.profile
    console.log(
      `${LOG_PREFIX} Scraped @${profile.handle}: ` +
      `bio=${profile.bio ? 'yes' : 'no'}, ` +
      `captions=${profile.post_captions.length}, ` +
      `private=${profile.is_private}`
    )

    // ── 3. Generate knowledge base via LLM ──────────────────────────────────

    // Build the prompt from scraped data
    const prompt = await buildInstagramToKnowledgePrompt({
      handle: profile.handle,
      bio: profile.bio,
      business_category: profile.business_category,
      post_captions: profile.post_captions,
    })

    let knowledgeBase: KnowledgeBaseGeneration | null = null

    // Only call LLM if we have meaningful content to analyze
    const hasContent = profile.bio || profile.post_captions.length > 0
    if (!hasContent) {
      console.warn(`${LOG_PREFIX} No bio or captions for @${handle} — skipping LLM generation`)
    } else {
      try {
        const llmResult = await callLLM({
          model: FLASH_MODEL,
          systemPrompt: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          maxTokens: 2048,
        })

        const rawContent = llmResult.message.content
        if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
          console.error(`${LOG_PREFIX} LLM returned empty content for @${handle}`)
        } else {
          // Parse the JSON response — strip markdown fences if the model added them
          const cleaned = rawContent
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim()

          try {
            const parsed = JSON.parse(cleaned) as KnowledgeBaseGeneration
            // Validate required fields
            if (parsed.structured_kb && Array.isArray(parsed.sections)) {
              knowledgeBase = parsed
              console.log(
                `${LOG_PREFIX} Generated KB for @${handle}: ` +
                `${parsed.sections.length} sections, ` +
                `${parsed.structured_kb.length} chars, ` +
                `tokens_in=${llmResult.usage.tokensIn} tokens_out=${llmResult.usage.tokensOut}`
              )
            } else {
              console.error(`${LOG_PREFIX} LLM response missing structured_kb or sections`)
            }
          } catch (parseErr) {
            console.error(
              `${LOG_PREFIX} Failed to parse LLM JSON for @${handle}:`,
              parseErr instanceof Error ? parseErr.message : String(parseErr),
              'Raw (first 500 chars):',
              rawContent.slice(0, 500)
            )
          }
        }
      } catch (llmErr) {
        // LLM failure is non-fatal — we still save the scrape data
        console.error(
          `${LOG_PREFIX} LLM call failed for @${handle}:`,
          llmErr instanceof Error ? llmErr.message : String(llmErr)
        )
      }
    }

    // ── 4. Save to workspace ────────────────────────────────────────────────

    const supabase = getSupabaseClient()

    const scrapeData: InstagramScrapeData = {
      handle: profile.handle,
      bio: profile.bio,
      business_category: profile.business_category,
      post_captions: profile.post_captions,
      scraped_at: profile.scraped_at,
      is_private: profile.is_private,
    }

    const updatePayload: Record<string, unknown> = {
      instagram_scrape_data: scrapeData,
    }

    if (knowledgeBase) {
      updatePayload.knowledge_base = knowledgeBase.structured_kb
    }

    const { error: updateError } = await supabase
      .from('workspaces')
      .update(updatePayload)
      .eq('id', workspace_id)

    if (updateError) {
      console.error(`${LOG_PREFIX} Failed to update workspace ${workspace_id}:`, updateError.message)
      return new Response(
        JSON.stringify({
          error: `Failed to save data: ${updateError.message}`,
          profile,
          knowledge_base: knowledgeBase,
        }),
        { status: 500 }
      )
    }

    console.log(`${LOG_PREFIX} Saved scrape data + KB for workspace ${workspace_id}`)

    // ── 5. Return results ───────────────────────────────────────────────────

    return new Response(
      JSON.stringify({
        profile,
        knowledge_base: knowledgeBase,
      }),
      { status: 200 }
    )
  } catch (err) {
    console.error(`${LOG_PREFIX} Unexpected error:`, err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500 }
    )
  }
})
