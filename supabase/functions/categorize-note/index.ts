// supabase/functions/categorize-note/index.ts
// Async note categorization: extracts follow-ups, promises, and client updates
// Triggered by pg_net trigger on notes INSERT or pg_cron safety-net retry

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

  // Hoist note_id so catch block can reference it for error recovery
  // without re-reading the consumed request body (req.json() is one-shot)
  let noteId: string | null = null

  try {
    const body = await req.json()
    noteId = body.note_id
    const workspaceId = body.workspace_id
    const clientId = body.client_id

    if (!noteId || !workspaceId || !clientId) {
      return new Response(
        JSON.stringify({ error: 'Missing note_id, workspace_id, or client_id' }),
        { status: 400 }
      )
    }

    const supabase = getSupabaseClient()

    // 1. Optimistic lock: pending -> processing
    // Sets updated_at so recovery cron measures staleness from lock time, not creation
    const { data: note, error: lockError } = await supabase
      .from('notes')
      .update({ extraction_status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', noteId)
      .eq('extraction_status', 'pending')
      .select('*')
      .single()

    if (lockError || !note) {
      console.log('[categorize-note] Skip: already claimed or not found', { noteId })
      return new Response(
        JSON.stringify({ skipped: true, reason: 'already_claimed_or_not_found' }),
        { status: 200 }
      )
    }

    // 2. Skip merge_history notes
    if (note.source === 'merge_history') {
      await supabase
        .from('notes')
        .update({ extraction_status: 'not_applicable' })
        .eq('id', noteId)
      return new Response(
        JSON.stringify({ skipped: true, reason: 'merge_history' }),
        { status: 200 }
      )
    }

    // 3. Increment retry count
    const retryCount = (note.extraction_retry_count ?? 0) + 1
    await supabase
      .from('notes')
      .update({ extraction_retry_count: retryCount })
      .eq('id', noteId)

    // 4. Parallel load: client, workspace config, open promises
    const [clientResult, workspaceResult, promisesResult] = await Promise.all([
      supabase
        .from('clients')
        .select('full_name, phone, email, tags, preferences, lifecycle_status')
        .eq('id', clientId)
        .single(),
      supabase
        .from('workspaces')
        .select('timezone, vertical_config')
        .eq('id', workspaceId)
        .single(),
      supabase
        .from('follow_ups')
        .select('content, due_date')
        .eq('client_id', clientId)
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

    // 5. Resolve date + custom fields
    const tz = workspace.timezone ?? 'UTC'
    const currentDate = new Date().toLocaleDateString('en-CA', { timeZone: tz })

    const verticalConfig = (workspace.vertical_config ?? {}) as Record<string, unknown>
    const rawCustomFields = Array.isArray(verticalConfig.custom_fields)
      ? verticalConfig.custom_fields
      : []
    const customFields: string[] = rawCustomFields.map(
      (f: unknown) => typeof f === 'object' && f !== null && 'name' in f
        ? String((f as { name: string }).name)
        : String(f)
    )

    // 6. Build input and call Haiku
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

    // 7. Parse response
    const rawContent = llmResult.message.content ?? ''
    const parsed = parseCategorizationResponse(typeof rawContent === 'string' ? rawContent : '')

    if (!parsed) {
      throw new Error('Failed to parse categorization response from LLM')
    }

    // 8. Insert proposed_actions for each extraction
    const proposedActions = parsed.extractions.map((extraction) => {
      switch (extraction.category) {
        case 'FOLLOW_UP':
          return {
            workspace_id: workspaceId,
            client_id: clientId,
            source_note_id: noteId,
            action_type: 'followup_create',
            tier: 'review',
            summary: extraction.description,
            payload: {
              type: 'follow_up',
              description: extraction.description,
              dueDate: extraction.due_date,
              sourceNoteId: noteId,
            },
            status: 'pending',
          }

        case 'PROMISE':
          return {
            workspace_id: workspaceId,
            client_id: clientId,
            source_note_id: noteId,
            action_type: 'followup_create',
            tier: 'review',
            summary: extraction.description,
            payload: {
              type: 'promise',
              description: extraction.description,
              dueDate: extraction.due_date,
              sourceNoteId: noteId,
            },
            status: 'pending',
          }

        case 'CLIENT_UPDATE': {
          // Map LLM extraction fields to actual clients table columns:
          //   phone_number -> phone (DB column name)
          //   preferences.* -> merge into preferences JSONB column
          //   full_name, email, lifecycle_status, tags -> direct columns
          const changes: Record<string, unknown> = {}
          const field = extraction.field

          if (field === 'phone_number') {
            changes.phone = extraction.after_value
          } else if (field.startsWith('preferences.')) {
            const prefKey = field.slice('preferences.'.length)
            changes.preferences = { [prefKey]: extraction.after_value }
          } else {
            changes[field] = extraction.after_value
          }

          return {
            workspace_id: workspaceId,
            client_id: clientId,
            source_note_id: noteId,
            action_type: 'client_update',
            tier: 'review',
            summary: `Update ${field}: ${JSON.stringify(extraction.before_value)} -> ${JSON.stringify(extraction.after_value)}`,
            payload: {
              changes,
              before_state: { [field]: extraction.before_value },
              after_state: { [field]: extraction.after_value },
            },
            status: 'pending',
          }
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

    // 9. Mark extraction complete
    await supabase
      .from('notes')
      .update({
        extraction_status: 'complete',
        extraction_completed_at: new Date().toISOString(),
      })
      .eq('id', noteId)

    // 10. Log LLM usage (fire-and-log)
    const costUsd = estimateCost(SMALL_MODEL, llmResult.usage.tokensIn, llmResult.usage.tokensOut)
    logLLMUsage(supabase, {
      workspaceId,
      clientId,
      edgeFunctionName: 'categorize-note',
      model: SMALL_MODEL,
      tokensIn: llmResult.usage.tokensIn,
      tokensOut: llmResult.usage.tokensOut,
      latencyMs,
      costUsd,
    }).catch((logErr) => {
      console.error('[categorize-note] LLM usage logging failed:', logErr)
    })

    console.log('[categorize-note] Complete', { noteId, extractions: parsed.extractions.length, latencyMs })

    return new Response(
      JSON.stringify({ success: true, extractions: parsed.extractions.length, proposed_actions: proposedActions.length }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[categorize-note] Error:', err)

    // Error recovery: noteId is hoisted so we can reference it here
    // without re-reading the consumed request body
    try {
      if (noteId) {
        const supabase = getSupabaseClient()
        const { data: currentNote } = await supabase
          .from('notes')
          .select('extraction_retry_count')
          .eq('id', noteId)
          .single()

        const currentRetries = currentNote?.extraction_retry_count ?? 0
        const nextStatus = currentRetries < MAX_RETRIES ? 'pending' : 'failed'

        await supabase
          .from('notes')
          .update({ extraction_status: nextStatus, extraction_error: String(err) })
          .eq('id', noteId)

        console.log('[categorize-note] Error recovery', { noteId, nextStatus, retryCount: currentRetries })
      }
    } catch (recoveryErr) {
      console.error('[categorize-note] Recovery failed:', recoveryErr)
    }

    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
