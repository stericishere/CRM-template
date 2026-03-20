// supabase/functions/categorize-note/index.ts
// Async note categorization: extracts follow-ups, promises, and client updates
// Triggered by pg_net trigger on notes INSERT or pg_cron safety-net retry
//
// Flow:
//
//   POST /categorize-note { note_id, workspace_id, client_id }
//         |
//         +-- optimistic lock: UPDATE notes SET extraction_status='processing'
//         |       WHERE id=note_id AND extraction_status='pending'
//         |       (no rows = already claimed, return 200 skip)
//         |
//         +-- skip merge_history notes (source='merge_history' -> 'not_applicable')
//         |
//         +-- increment extraction_retry_count
//         |
//         +-- parallel load: client profile, workspace config, open promises
//         |
//         +-- build CategorizationInput -> callLLM (Haiku)
//         |
//         +-- parseCategorizationResponse
//         |
//         +-- for each extraction:
//         |     FOLLOW_UP  -> proposed_actions (action_type='followup_create', tier='review')
//         |     PROMISE    -> proposed_actions (action_type='followup_create', tier='review', payload.type='promise')
//         |     CLIENT_UPDATE -> proposed_actions (action_type='client_update', tier='review', payload has before/after)
//         |
//         +-- extraction_status='complete'
//         |
//         +-- on error: status='pending' if retry_count < 3, else 'failed'
//         |
//         +-- logLLMUsage (fire-and-log, non-blocking)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { callLLM, SMALL_MODEL, estimateCost } from '../_shared/llm-client.ts'
import { logLLMUsage } from '../_shared/draft-persistence.ts'
import { CATEGORIZATION_SYSTEM_PROMPT, buildCategorizationUserMessage } from '../_shared/categorization-prompt.ts'
import { parseCategorizationResponse } from '../_shared/categorization-parser.ts'
import type { CategorizationInput } from '../_shared/types/extraction.ts'

const MAX_RETRIES = 3

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    const { note_id, workspace_id, client_id } = await req.json()

    if (!note_id || !workspace_id || !client_id) {
      return new Response(
        JSON.stringify({ error: 'Missing note_id, workspace_id, or client_id' }),
        { status: 400 }
      )
    }

    const supabase = getSupabaseClient()

    // ─── 1. Optimistic lock ───────────────────────────────────
    // Atomically claim the note by transitioning pending -> processing.
    // If no rows returned, another worker already claimed it — skip.
    const { data: note, error: lockError } = await supabase
      .from('notes')
      .update({ extraction_status: 'processing' })
      .eq('id', note_id)
      .eq('extraction_status', 'pending')
      .select('*')
      .single()

    if (lockError || !note) {
      // PGRST116 = no rows matched (already claimed or doesn't exist)
      console.log('[categorize-note] Skip: note already claimed or not found', { note_id })
      return new Response(
        JSON.stringify({ skipped: true, reason: 'already_claimed_or_not_found' }),
        { status: 200 }
      )
    }

    // ─── 2. Skip merge_history notes ──────────────────────────
    if (note.source === 'merge_history') {
      await supabase
        .from('notes')
        .update({ extraction_status: 'not_applicable' })
        .eq('id', note_id)

      console.log('[categorize-note] Skipped merge_history note', { note_id })
      return new Response(
        JSON.stringify({ skipped: true, reason: 'merge_history' }),
        { status: 200 }
      )
    }

    // ─── 3. Increment retry count ─────────────────────────────
    const retryCount = (note.extraction_retry_count ?? 0) + 1
    await supabase
      .from('notes')
      .update({ extraction_retry_count: retryCount })
      .eq('id', note_id)

    // ─── 4. Parallel load: client, workspace config, open promises ─
    const [clientResult, workspaceResult, promisesResult] = await Promise.all([
      supabase
        .from('clients')
        .select('full_name, phone, email, tags, preferences, lifecycle_status')
        .eq('id', client_id)
        .single(),

      supabase
        .from('workspaces')
        .select('timezone, vertical_config')
        .eq('id', workspace_id)
        .single(),

      supabase
        .from('follow_ups')
        .select('content, due_date')
        .eq('client_id', client_id)
        .eq('type', 'promise')
        .in('status', ['open', 'pending']),
    ])

    if (clientResult.error || !clientResult.data) {
      throw new Error(`Client not found: ${clientResult.error?.message ?? 'no data'}`)
    }
    if (workspaceResult.error || !workspaceResult.data) {
      throw new Error(`Workspace not found: ${workspaceResult.error?.message ?? 'no data'}`)
    }

    const client = clientResult.data
    const workspace = workspaceResult.data
    const openPromises = promisesResult.data ?? []

    // ─── 5. Resolve current date in workspace timezone ────────
    const tz = workspace.timezone ?? 'UTC'
    const currentDate = new Date().toLocaleDateString('en-CA', { timeZone: tz }) // YYYY-MM-DD

    // Extract custom fields from vertical_config
    const verticalConfig = (workspace.vertical_config ?? {}) as Record<string, unknown>
    const customFields: string[] = Array.isArray(verticalConfig.customFields)
      ? (verticalConfig.customFields as string[])
      : []

    // ─── 6. Build categorization input and call Haiku ─────────
    const categorizationInput: CategorizationInput = {
      note_content: note.content,
      note_created_at: note.created_at,
      client_profile: {
        full_name: client.full_name ?? null,
        phone_number: client.phone ?? null,
        email: client.email ?? null,
        tags: client.tags ?? [],
        preferences: (client.preferences ?? {}) as Record<string, unknown>,
        lifecycle_status: client.lifecycle_status,
      },
      workspace_custom_fields: customFields,
      current_date: currentDate,
      workspace_timezone: tz,
      existing_open_promises: openPromises.map((p: { content: string; due_date: string | null }) => ({
        content: p.content,
        due_date: p.due_date,
      })),
    }

    const userMessage = buildCategorizationUserMessage(categorizationInput)
    const llmStart = Date.now()

    const llmResult = await callLLM({
      model: SMALL_MODEL,
      systemPrompt: CATEGORIZATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 1024,
    })

    const latencyMs = Date.now() - llmStart

    // ─── 7. Parse response ────────────────────────────────────
    const rawContent = llmResult.message.content ?? ''
    const parsed = parseCategorizationResponse(typeof rawContent === 'string' ? rawContent : '')

    if (!parsed) {
      throw new Error('Failed to parse categorization response from LLM')
    }

    // ─── 8. Insert proposed_actions for each extraction ───────
    const proposedActions = parsed.extractions.map((extraction) => {
      switch (extraction.category) {
        case 'FOLLOW_UP':
          return {
            workspace_id,
            client_id,
            source_note_id: note_id,
            action_type: 'followup_create',
            tier: 'review',
            summary: extraction.description,
            payload: {
              type: 'follow_up',
              description: extraction.description,
              due_date: extraction.due_date,
            },
            status: 'pending',
          }

        case 'PROMISE':
          return {
            workspace_id,
            client_id,
            source_note_id: note_id,
            action_type: 'followup_create',
            tier: 'review',
            summary: extraction.description,
            payload: {
              type: 'promise',
              description: extraction.description,
              due_date: extraction.due_date,
            },
            status: 'pending',
          }

        case 'CLIENT_UPDATE':
          return {
            workspace_id,
            client_id,
            source_note_id: note_id,
            action_type: 'client_update',
            tier: 'review',
            summary: `Update ${extraction.field}`,
            payload: {
              field: extraction.field,
              before_state: extraction.before_value,
              after_state: extraction.after_value,
            },
            status: 'pending',
          }
      }
    })

    if (proposedActions.length > 0) {
      const { error: insertError } = await supabase
        .from('proposed_actions')
        .insert(proposedActions)

      if (insertError) {
        throw new Error(`Failed to insert proposed_actions: ${insertError.message}`)
      }
    }

    // ─── 9. Mark extraction complete ──────────────────────────
    await supabase
      .from('notes')
      .update({
        extraction_status: 'complete',
        extraction_completed_at: new Date().toISOString(),
      })
      .eq('id', note_id)

    // ─── 10. Log LLM usage (fire-and-log, non-blocking) ──────
    const costUsd = estimateCost(SMALL_MODEL, llmResult.usage.tokensIn, llmResult.usage.tokensOut)

    logLLMUsage(supabase, {
      workspaceId: workspace_id,
      clientId: client_id,
      edgeFunctionName: 'categorize-note',
      model: SMALL_MODEL,
      tokensIn: llmResult.usage.tokensIn,
      tokensOut: llmResult.usage.tokensOut,
      latencyMs,
      costUsd,
    }).catch((err) => {
      console.error('[categorize-note] LLM usage logging failed:', err)
    })

    console.log('[categorize-note] Complete', {
      note_id,
      extractions: parsed.extractions.length,
      latencyMs,
    })

    return new Response(
      JSON.stringify({
        success: true,
        extractions: parsed.extractions.length,
        proposed_actions: proposedActions.length,
      }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[categorize-note] Error:', err)

    // ─── Error recovery: reset status based on retry count ────
    try {
      const { note_id } = await req.clone().json().catch(() => ({ note_id: null }))
      if (note_id) {
        const supabase = getSupabaseClient()

        // Read current retry count to decide next status
        const { data: currentNote } = await supabase
          .from('notes')
          .select('extraction_retry_count')
          .eq('id', note_id)
          .single()

        const currentRetries = currentNote?.extraction_retry_count ?? 0
        const nextStatus = currentRetries < MAX_RETRIES ? 'pending' : 'failed'

        await supabase
          .from('notes')
          .update({
            extraction_status: nextStatus,
            extraction_error: String(err),
          })
          .eq('id', note_id)

        console.log('[categorize-note] Error recovery', {
          note_id,
          nextStatus,
          retryCount: currentRetries,
        })
      }
    } catch (recoveryErr) {
      console.error('[categorize-note] Recovery failed:', recoveryErr)
    }

    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
