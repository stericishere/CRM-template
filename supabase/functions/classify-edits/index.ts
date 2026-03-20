// supabase/functions/classify-edits/index.ts
// Async worker that classifies staff edits on AI-generated drafts.
// Two trigger modes:
//
//   pgmq (single signal):
//     POST { signal_id, workspace_id }
//       │
//       ├─ acquire advisory lock (workspace-scoped)
//       ├─ process one signal
//       └─ release advisory lock
//
//   pg_cron (batch):
//     POST {} (no signal_id)
//       │
//       └─ fetch up to 10 unprocessed signals, process sequentially
//
// Per-signal processing:
//
//   signal ─► idempotency check (edit_classifications exists?)
//          ─► load workspace pattern keys (top 50 by recurrence)
//          ─► LLM classification (FLASH_MODEL / Haiku)
//          ─► parse response
//          ─► write edit_classifications row
//          ─► update draft_edit_signals (categories, pattern_key, processed_at)
//          ─► upsert pattern recurrence (per pattern key)
//          ─► if always_do_this: create rule immediately (confidence=0.5, staff_flagged)
//          ─► else: check promotion threshold, create rule if met
//          ─► log LLM usage (fire-and-log)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { callLLM, FLASH_MODEL, estimateCost } from '../_shared/llm-client.ts'
import { logLLMUsage } from '../_shared/draft-persistence.ts'
import { buildClassificationPrompt, CLASSIFICATION_FEW_SHOT } from '../_shared/classification-prompt.ts'
import { parseClassificationResponse } from '../_shared/classification-parser.ts'
import { checkPromotionThreshold, calculateConfidence } from '../_shared/pattern-tracking.ts'
import { generateRuleInstruction } from '../_shared/instruction-generator.ts'

/**
 * Simple string hash returning a positive integer, used as advisory lock key.
 *
 *   "workspace_abc" ──► 2038471923
 */
function hashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    hash = ((hash << 5) - hash + ch) | 0  // force 32-bit signed
  }
  return Math.abs(hash)
}

// ────────────────────────────────────────────
// Per-signal classification pipeline
// ────────────────────────────────────────────

interface SignalRow {
  id: string
  workspace_id: string
  client_id: string | null
  draft_id: string | null
  original_draft: string
  final_version: string
  intent_classified: string | null
  scenario_type: string | null
  always_do_this: boolean
  staff_action: string
  processed_at: string | null
}

async function processSignal(
  supabase: ReturnType<typeof getSupabaseClient>,
  signal: SignalRow,
): Promise<{ classified: boolean; error?: string }> {
  const tag = `[classify-edits] signal=${signal.id}`

  // 1. Idempotency: skip if already classified
  const { data: existing } = await supabase
    .from('edit_classifications')
    .select('id')
    .eq('signal_id', signal.id)
    .maybeSingle()

  if (existing) {
    // Already classified — just mark processed if not already
    if (!signal.processed_at) {
      await supabase
        .from('draft_edit_signals')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', signal.id)
    }
    console.log(`${tag} already classified, skipping`)
    return { classified: false }
  }

  // 2. Load existing pattern keys for this workspace (top 50 by recurrence)
  const { data: patternRows } = await supabase
    .from('pattern_recurrences')
    .select('pattern_key')
    .eq('workspace_id', signal.workspace_id)
    .order('recurrence_count', { ascending: false })
    .limit(50)

  const existingPatternKeys = (patternRows ?? []).map(
    (r: { pattern_key: string }) => r.pattern_key,
  )

  // 3. Call Haiku for classification
  const systemPrompt = buildClassificationPrompt(
    signal.original_draft,
    signal.final_version,
    signal.intent_classified,
    signal.scenario_type,
    existingPatternKeys,
  )

  const startMs = Date.now()
  const llmResult = await callLLM({
    model: FLASH_MODEL,
    systemPrompt,
    messages: [
      ...CLASSIFICATION_FEW_SHOT,
      {
        role: 'user' as const,
        content: `Original Draft:\n"${signal.original_draft}"\n\nFinal Version:\n"${signal.final_version}"`,
      },
    ],
    maxTokens: 512,
  })
  const latencyMs = Date.now() - startMs

  // 4. Parse response
  const responseText =
    typeof llmResult.message.content === 'string'
      ? llmResult.message.content
      : Array.isArray(llmResult.message.content) &&
          llmResult.message.content[0]?.type === 'text'
        ? (llmResult.message.content[0] as { type: 'text'; text: string }).text
        : ''

  const classification = parseClassificationResponse(responseText)

  if (!classification) {
    console.error(`${tag} classification parse failed, raw:`, responseText)
    return { classified: false, error: 'parse_failed' }
  }

  const primaryPatternKey = classification.pattern_keys[0] ?? null
  const primaryCategory = classification.edit_categories[0] ?? 'unknown'

  // 5. Write edit_classifications row
  const { error: classInsertErr } = await supabase
    .from('edit_classifications')
    .insert({
      signal_id: signal.id,
      workspace_id: signal.workspace_id,
      edit_categories: classification.edit_categories,
      severity: classification.severity,
      pattern_keys: classification.pattern_keys,
      analysis_notes: classification.analysis_notes,
    })

  if (classInsertErr) {
    console.error(`${tag} classification insert failed:`, classInsertErr.message)
    return { classified: false, error: classInsertErr.message }
  }

  // 6. Update draft_edit_signals with categories, pattern_key, processed_at
  const { error: sigUpdateErr } = await supabase
    .from('draft_edit_signals')
    .update({
      edit_categories: classification.edit_categories,
      pattern_key: primaryPatternKey,
      processed_at: new Date().toISOString(),
    })
    .eq('id', signal.id)

  if (sigUpdateErr) {
    console.error(`${tag} signal update failed:`, sigUpdateErr.message)
  }

  // 7. Upsert pattern recurrences for each pattern key
  for (const patternKey of classification.pattern_keys) {
    const { error: rpcErr } = await supabase.rpc('upsert_pattern_recurrence', {
      p_workspace_id: signal.workspace_id,
      p_pattern_key: patternKey,
      p_category: primaryCategory,
      p_client_id: signal.client_id,
    })

    if (rpcErr) {
      console.error(`${tag} upsert_pattern_recurrence failed for ${patternKey}:`, rpcErr.message)
    }
  }

  // 8-10. Rule creation: immediate (always_do_this) or threshold-based
  if (primaryPatternKey) {
    await maybeCreateRule(supabase, signal, primaryPatternKey, primaryCategory, tag)
  }

  // 11. Log LLM usage (fire-and-log, non-blocking)
  const costUsd = estimateCost(FLASH_MODEL, llmResult.usage.tokensIn, llmResult.usage.tokensOut)
  logLLMUsage(supabase, {
    workspaceId: signal.workspace_id,
    clientId: signal.client_id,
    edgeFunctionName: 'classify-edits',
    model: FLASH_MODEL,
    tokensIn: llmResult.usage.tokensIn,
    tokensOut: llmResult.usage.tokensOut,
    latencyMs,
    costUsd,
  }).catch((err) => console.error(`${tag} LLM usage log failed:`, err))

  console.log(`${tag} classified: categories=${classification.edit_categories.join(',')} severity=${classification.severity} pattern=${primaryPatternKey}`)
  return { classified: true }
}

// ────────────────────────────────────────────
// Rule creation logic
// ────────────────────────────────────────────

async function maybeCreateRule(
  supabase: ReturnType<typeof getSupabaseClient>,
  signal: SignalRow,
  patternKey: string,
  category: string,
  tag: string,
): Promise<void> {
  if (signal.always_do_this) {
    // 8. Staff flagged "always do this" — create rule immediately
    await createRule(supabase, signal.workspace_id, patternKey, category, 0.5, 'staff_flagged', tag)
    return
  }

  // 9. Check promotion threshold
  const { data: recurrence } = await supabase
    .from('pattern_recurrences')
    .select('*')
    .eq('workspace_id', signal.workspace_id)
    .eq('pattern_key', patternKey)
    .maybeSingle()

  if (!recurrence) return

  const result = checkPromotionThreshold(recurrence)
  if (!result.shouldPromote) {
    console.log(`${tag} pattern=${patternKey} not promoted: ${result.reason}`)
    return
  }

  const confidence = calculateConfidence(recurrence.recurrence_count)
  await createRule(supabase, signal.workspace_id, patternKey, category, confidence, 'auto', tag)
}

async function createRule(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  patternKey: string,
  category: string,
  confidence: number,
  sourceType: 'auto' | 'staff_flagged',
  tag: string,
): Promise<void> {
  // 10a. Idempotency: check if rule already exists for this pattern_key + workspace
  const { data: existingRule } = await supabase
    .from('communication_rules')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('source_pattern_key', patternKey)
    .maybeSingle()

  if (existingRule) {
    console.log(`${tag} rule already exists for pattern=${patternKey}, skipping`)
    return
  }

  // 10b. Fetch 3 example edits for this pattern
  const { data: exampleSignals } = await supabase
    .from('draft_edit_signals')
    .select('original_draft, final_version')
    .eq('workspace_id', workspaceId)
    .eq('pattern_key', patternKey)
    .order('created_at', { ascending: false })
    .limit(3)

  const exampleEdits = (exampleSignals ?? []).map(
    (s: { original_draft: string; final_version: string }) => ({
      original: s.original_draft,
      final: s.final_version,
    }),
  )

  // 10c. Generate instruction via LLM
  let instruction: string
  try {
    instruction = await generateRuleInstruction(patternKey, category, exampleEdits)
  } catch (err) {
    console.error(`${tag} generateRuleInstruction failed:`, err)
    instruction = `Apply the "${patternKey}" pattern when drafting messages.`
  }

  // 10d. Insert communication_rules row
  const now = new Date().toISOString()
  const { error: ruleErr } = await supabase.from('communication_rules').insert({
    workspace_id: workspaceId,
    category,
    instruction,
    confidence,
    source_pattern_key: patternKey,
    source_type: sourceType,
    example_edits: exampleEdits,
    active: true,
    promoted_at: now,
  })

  if (ruleErr) {
    console.error(`${tag} rule insert failed:`, ruleErr.message)
    return
  }

  // 10e. Mark pattern as promoted
  const { error: promoErr } = await supabase
    .from('pattern_recurrences')
    .update({ promoted: true, promoted_at: now })
    .eq('workspace_id', workspaceId)
    .eq('pattern_key', patternKey)

  if (promoErr) {
    console.error(`${tag} pattern promotion update failed:`, promoErr.message)
  }

  console.log(`${tag} rule created: pattern=${patternKey} confidence=${confidence} source=${sourceType}`)
}

// ────────────────────────────────────────────
// Entrypoint
// ────────────────────────────────────────────

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    const body = await req.json()
    const supabase = getSupabaseClient()

    // Single-signal mode (pgmq-triggered)
    if (body.signal_id && body.workspace_id) {
      const lockKey = hashCode(`classify-edits:${body.workspace_id}`)

      // Acquire advisory lock
      const { data: lockAcquired, error: lockErr } = await supabase.rpc('try_advisory_lock', {
        lock_key: lockKey,
      })

      if (lockErr || !lockAcquired) {
        console.log(`[classify-edits] Could not acquire lock for workspace=${body.workspace_id}, skipping`)
        return new Response(
          JSON.stringify({ skipped: true, reason: 'lock_not_acquired' }),
          { status: 200 },
        )
      }

      try {
        // Fetch the signal
        const { data: signal, error: fetchErr } = await supabase
          .from('draft_edit_signals')
          .select('*')
          .eq('id', body.signal_id)
          .single()

        if (fetchErr || !signal) {
          return new Response(
            JSON.stringify({ error: fetchErr?.message ?? 'Signal not found' }),
            { status: 404 },
          )
        }

        const result = await processSignal(supabase, signal as SignalRow)
        return new Response(JSON.stringify({ processed: 1, ...result }), { status: 200 })
      } finally {
        // Always release advisory lock
        await supabase.rpc('advisory_unlock', { lock_key: lockKey }).catch((err: unknown) => {
          console.error('[classify-edits] advisory_unlock failed:', err)
        })
      }
    }

    // Batch mode (pg_cron-triggered)
    const { data: signals, error: batchErr } = await supabase
      .from('draft_edit_signals')
      .select('*')
      .eq('staff_action', 'edited_and_sent')
      .is('processed_at', null)
      .order('always_do_this', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(10)

    if (batchErr) {
      console.error('[classify-edits] Batch fetch failed:', batchErr.message)
      return new Response(JSON.stringify({ error: batchErr.message }), { status: 500 })
    }

    if (!signals || signals.length === 0) {
      return new Response(JSON.stringify({ processed: 0, message: 'No unprocessed signals' }), { status: 200 })
    }

    let processed = 0
    let errors = 0

    for (const signal of signals as SignalRow[]) {
      try {
        const result = await processSignal(supabase, signal)
        if (result.classified) processed++
        if (result.error) errors++
      } catch (err) {
        console.error(`[classify-edits] signal=${signal.id} unhandled error:`, err)
        errors++
      }
    }

    return new Response(
      JSON.stringify({ processed, errors, total: signals.length }),
      { status: 200 },
    )
  } catch (err) {
    console.error('[classify-edits] Error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
