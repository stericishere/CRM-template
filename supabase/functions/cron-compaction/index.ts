// supabase/functions/cron-compaction/index.ts
// Per-workspace daily memory compaction.
// Called by cron-compaction-coordinator with { workspace_id }.
//
// For each client with message activity yesterday:
//
//   ┌───────────────────────────────────────┐
//   │  Query clients with yesterday's msgs  │
//   └──────────┬────────────────────────────┘
//              │
//              v
//   ┌───────────────────────────────────────┐
//   │  For each client:                     │
//   │    ├─ Flush-before-compact check      │  notes.extraction_status = 'pending' → skip
//   │    ├─ Load existing compact_summary   │  memories table, latest version
//   │    ├─ Load yesterday's messages       │
//   │    ├─ LLM call (FLASH_MODEL)          │  merge summary + new messages
//   │    ├─ INSERT memories (new version)   │
//   │    └─ UPDATE clients.summary +        │
//   │         clients.last_compacted_at     │
//   └──────────┬────────────────────────────┘
//              │
//              v
//   ┌───────────────────────────────────────┐
//   │  INSERT cron_run_log                  │  job_type: 'compaction'
//   └───────────────────────────────────────┘
//
// Per-client try-catch: single client failure never blocks others.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { createCronRunLog, finalizeCronRunLog } from '../_shared/cron-helpers.ts'
import { callLLM, FLASH_MODEL } from '../_shared/llm-client.ts'

// ─── Constants ──────────────────────────────────────────────

const COMPACTION_SYSTEM_PROMPT = `You are a memory compaction assistant. Merge the existing client summary with new messages into a concise third-person factual summary (~2000 tokens). Priority: preferences > milestones > unresolved topics > communication style > interaction history. Preserve all actionable information. Drop redundant small talk.`

const COMPACTION_MAX_TOKENS = 2048
const MESSAGE_TRUNCATION_LIMIT = 200
const STALE_RUNNING_THRESHOLD_MINUTES = 30

// ─── Types ──────────────────────────────────────────────────

interface ActiveClient {
  client_id: string
}

interface MemoryRecord {
  id: string
  content: string
  version: number
}

interface MessageRow {
  content: string | null
  direction: string
  sender_type: string
  created_at: string
}

// ─── Main handler ───────────────────────────────────────────

serve(async (req) => {
  const supabase = getSupabaseClient()

  let workspaceId: string

  try {
    const body = await req.json()
    workspaceId = body.workspace_id
  } catch {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid JSON body' }),
      { status: 400 }
    )
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: 'workspace_id is required' }),
      { status: 400 }
    )
  }

  // Create cron_run_log entry
  const runId = await createCronRunLog('compaction', workspaceId)

  // ─── Stale 'running' cleanup ────────────────────────────────
  // Any cron_run_logs stuck in 'running' for >30 min are likely orphaned.
  // Mark them 'failed' so they don't block monitoring/alerting.
  try {
    const staleThreshold = new Date(
      Date.now() - STALE_RUNNING_THRESHOLD_MINUTES * 60 * 1000
    ).toISOString()

    const { data: staleRuns, error: staleError } = await supabase
      .from('cron_run_log')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_details: { reason: 'stale_running_cleanup', threshold_minutes: STALE_RUNNING_THRESHOLD_MINUTES },
      })
      .eq('status', 'running')
      .lt('started_at', staleThreshold)
      .select('run_id')

    if (staleError) {
      console.warn('[compaction] Failed to clean up stale running logs:', staleError.message)
    } else if (staleRuns && staleRuns.length > 0) {
      console.log(
        `[compaction] [${workspaceId}] Cleaned up ${staleRuns.length} stale 'running' cron_run_log(s)`
      )
    }
  } catch (cleanupErr) {
    // Cleanup failure is non-fatal — proceed with compaction
    console.warn('[compaction] Stale running cleanup error (non-fatal):', cleanupErr)
  }

  try {
    // 1. Query clients with message activity yesterday
    //    Uses raw SQL via RPC because we need a date cast + DISTINCT + JOIN
    const { data: activeClients, error: queryError } = await supabase.rpc(
      'get_clients_with_yesterday_activity',
      { p_workspace_id: workspaceId }
    ).returns<ActiveClient[]>()

    // If the RPC doesn't exist yet, fall back to a Supabase query approach
    let clientIds: string[] = []

    if (queryError) {
      console.warn(
        '[compaction] RPC get_clients_with_yesterday_activity not available, using fallback query:',
        queryError.message
      )

      // Fallback: query conversations for this workspace, then check messages
      const { data: conversations, error: convError } = await supabase
        .from('conversations')
        .select('id, client_id')
        .eq('workspace_id', workspaceId)

      if (convError || !conversations) {
        console.error('[compaction] Failed to query conversations:', convError?.message)
        const errMsg = convError?.message ?? 'No conversations found'
        await finalizeCronRunLog(runId, 'failed', 0, 0, { error: errMsg }, { error: errMsg })
        return new Response(
          JSON.stringify({ error: 'Failed to query conversations' }),
          { status: 500 }
        )
      }

      // Batch query: find conversations with yesterday's messages in one query
      const yesterday = getYesterdayDateString()
      const conversationIds = conversations.map((c) => c.id)
      const clientByConv = new Map(conversations.map((c) => [c.id, c.client_id]))
      const clientIdSet = new Set<string>()

      // Query in batches of 200 to stay within PostgREST limits
      const BATCH_SIZE = 200
      for (let i = 0; i < conversationIds.length; i += BATCH_SIZE) {
        const batch = conversationIds.slice(i, i + BATCH_SIZE)
        const { data: msgs, error: msgError } = await supabase
          .from('messages')
          .select('conversation_id')
          .in('conversation_id', batch)
          .gte('created_at', `${yesterday}T00:00:00.000Z`)
          .lt('created_at', `${getTodayDateString()}T00:00:00.000Z`)

        if (!msgError && msgs) {
          for (const m of msgs) {
            const cid = clientByConv.get(m.conversation_id)
            if (cid) clientIdSet.add(cid)
          }
        }
      }

      clientIds = Array.from(clientIdSet)
    } else {
      clientIds = (activeClients ?? []).map((c) => c.client_id)
    }

    console.log(
      `[compaction] [${workspaceId}] Found ${clientIds.length} client(s) with yesterday's activity`
    )

    if (clientIds.length === 0) {
      await finalizeCronRunLog(runId, 'success', 0, 0, {
        message: 'No clients with yesterday activity',
      })
      return new Response(
        JSON.stringify({ success: true, clients_found: 0, clients_compacted: 0 }),
        { status: 200 }
      )
    }

    // 2. Process each client
    let compacted = 0
    let skippedPending = 0
    let skippedError = 0
    const errors: Array<{ clientId: string; error: string }> = []

    for (const clientId of clientIds) {
      try {
        const result = await compactClient(supabase, workspaceId, clientId)

        if (result === 'compacted') {
          compacted++
        } else if (result === 'skipped_pending') {
          skippedPending++
        }
      } catch (clientErr) {
        console.error(
          `[compaction] [${workspaceId}] Error compacting client ${clientId}:`,
          clientErr
        )
        errors.push({ clientId, error: String(clientErr) })
        skippedError++
      }
    }

    // 3. Finalize log
    const finalStatus =
      errors.length === 0
        ? 'success'
        : errors.length < clientIds.length
          ? 'partial_failure'
          : 'failed'

    await finalizeCronRunLog(runId, finalStatus, clientIds.length, compacted, {
      clients_found: clientIds.length,
      clients_compacted: compacted,
      clients_skipped_pending: skippedPending,
      clients_skipped_error: skippedError,
      errors: errors.length > 0 ? errors : undefined,
    })

    console.log(
      `[compaction] [${workspaceId}] Complete: ${compacted} compacted, ${skippedPending} skipped (pending notes), ${skippedError} errors`
    )

    return new Response(
      JSON.stringify({
        success: true,
        clients_found: clientIds.length,
        clients_compacted: compacted,
        clients_skipped_pending: skippedPending,
        clients_skipped_error: skippedError,
      }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[compaction] Fatal error:', err)
    await finalizeCronRunLog(runId, 'failed', 0, 0, {
      error: String(err),
    }, { error: String(err) })
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})

// ─── Per-client compaction ──────────────────────────────────

type CompactionResult = 'compacted' | 'skipped_pending'

async function compactClient(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  clientId: string
): Promise<CompactionResult> {
  // 2a. Flush-before-compact check
  //     If notes.extraction_status column exists and any are 'pending', skip.
  //     Column may not exist (F-13 not yet implemented) — handle gracefully.
  const shouldSkip = await checkPendingExtractions(supabase, clientId)
  if (shouldSkip) {
    console.log(
      `[compaction] [${workspaceId}] Skipping client ${clientId}: pending note extractions`
    )
    return 'skipped_pending'
  }

  // 2b. Load existing compact summary (latest version)
  const existingSummary = await loadLatestCompactSummary(supabase, workspaceId, clientId)

  // 2c. Load yesterday's messages for this client
  const yesterdayMessages = await loadYesterdayMessages(supabase, workspaceId, clientId)

  if (yesterdayMessages.length === 0) {
    console.log(
      `[compaction] [${workspaceId}] No messages found for client ${clientId} (skip)`
    )
    return 'compacted' // Nothing to compact, but not an error
  }

  // 2d. LLM call: merge existing summary with new messages
  const messagesText = yesterdayMessages
    .map((m) => {
      const role = m.direction === 'inbound' ? 'Client' : 'Staff'
      const time = new Date(m.created_at).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
      })
      return `[${time}] ${role}: ${m.content ?? '(media message)'}`
    })
    .join('\n')

  const userContent = existingSummary
    ? `## Existing Summary (version ${existingSummary.version})\n${existingSummary.content}\n\n## New Messages (yesterday)\n${messagesText}`
    : `## New Messages (yesterday)\n${messagesText}\n\n(No existing summary — this is the first compaction for this client.)`

  const llmResult = await callLLM({
    model: FLASH_MODEL,
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    maxTokens: COMPACTION_MAX_TOKENS,
  })

  const newSummary = llmResult.message.content ?? ''

  if (!newSummary) {
    throw new Error('LLM returned empty summary')
  }

  const newVersion = (existingSummary?.version ?? 0) + 1

  // 2e. Atomic write: INSERT memory + UPDATE client in a single RPC call.
  //     write_compaction_result does both in a transaction so they can't diverge.
  const { error: rpcError } = await supabase.rpc('write_compaction_result', {
    p_workspace_id: workspaceId,
    p_client_id: clientId,
    p_memory_type: 'compact_summary',
    p_memory_content: newSummary,
    p_period_date: getYesterdayDateString(),
    p_client_summary: newSummary,
  })

  if (rpcError) {
    throw new Error(`write_compaction_result RPC failed: ${rpcError.message}`)
  }

  console.log(
    `[compaction] [${workspaceId}] Client ${clientId} compacted to v${newVersion} (${llmResult.usage.tokensIn}+${llmResult.usage.tokensOut} tokens)`
  )

  return 'compacted'
}

// ─── Data loaders ───────────────────────────────────────────

async function checkPendingExtractions(
  supabase: ReturnType<typeof getSupabaseClient>,
  clientId: string
): Promise<boolean> {
  try {
    // Try querying extraction_status — column may not exist yet (F-13)
    const { data, error } = await supabase
      .from('notes')
      .select('id')
      .eq('client_id', clientId)
      .eq('extraction_status', 'pending')
      .limit(1)

    if (error) {
      // Column likely doesn't exist — proceed without the check
      if (
        error.message.includes('extraction_status') ||
        error.message.includes('column') ||
        error.code === '42703' // PostgreSQL undefined_column error code
      ) {
        console.log(
          '[compaction] notes.extraction_status column not found — skipping flush-before-compact check'
        )
        return false
      }
      // Some other error — log and proceed without blocking
      console.warn('[compaction] Unexpected error checking extraction_status:', error.message)
      return false
    }

    return (data?.length ?? 0) > 0
  } catch {
    // Any unexpected error — don't block compaction
    return false
  }
}

async function loadLatestCompactSummary(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  clientId: string
): Promise<MemoryRecord | null> {
  const { data, error } = await supabase
    .from('memories')
    .select('id, content, version')
    .eq('workspace_id', workspaceId)
    .eq('client_id', clientId)
    .eq('type', 'compact_summary')
    .order('period_date', { ascending: false })
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[compaction] Failed to load existing summary:', error.message)
    return null
  }

  return data as MemoryRecord | null
}

async function loadYesterdayMessages(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  clientId: string
): Promise<MessageRow[]> {
  const yesterday = getYesterdayDateString()
  const today = getTodayDateString()

  // Get conversation for this client
  const { data: conv, error: convError } = await supabase
    .from('conversations')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('client_id', clientId)
    .limit(1)
    .maybeSingle()

  if (convError || !conv) {
    return []
  }

  // Get yesterday's messages (count first to detect truncation)
  const { count: totalCount, error: countError } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conv.id)
    .gte('created_at', `${yesterday}T00:00:00.000Z`)
    .lt('created_at', `${today}T00:00:00.000Z`)

  if (countError) {
    console.warn('[compaction] Failed to count yesterday messages:', countError.message)
    // Fall through — still try to load messages
  }

  if (totalCount !== null && totalCount > MESSAGE_TRUNCATION_LIMIT) {
    console.warn(
      `[compaction] Client has ${totalCount} messages yesterday (limit ${MESSAGE_TRUNCATION_LIMIT}). ` +
      `Only using last ${MESSAGE_TRUNCATION_LIMIT} for compaction.`
    )
  }

  // Query messages, ordered ascending. If truncated, take the most recent N
  // by ordering DESC with limit, then reversing.
  const needsTruncation = totalCount !== null && totalCount > MESSAGE_TRUNCATION_LIMIT

  let messages: MessageRow[]

  if (needsTruncation) {
    // Fetch last MESSAGE_TRUNCATION_LIMIT messages (most recent first), then reverse
    const { data: descMessages, error: msgError } = await supabase
      .from('messages')
      .select('content, direction, sender_type, created_at')
      .eq('conversation_id', conv.id)
      .gte('created_at', `${yesterday}T00:00:00.000Z`)
      .lt('created_at', `${today}T00:00:00.000Z`)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_TRUNCATION_LIMIT)

    if (msgError) {
      console.warn('[compaction] Failed to load yesterday messages:', msgError.message)
      return []
    }

    messages = ((descMessages ?? []) as MessageRow[]).reverse()
  } else {
    const { data: ascMessages, error: msgError } = await supabase
      .from('messages')
      .select('content, direction, sender_type, created_at')
      .eq('conversation_id', conv.id)
      .gte('created_at', `${yesterday}T00:00:00.000Z`)
      .lt('created_at', `${today}T00:00:00.000Z`)
      .order('created_at', { ascending: true })

    if (msgError) {
      console.warn('[compaction] Failed to load yesterday messages:', msgError.message)
      return []
    }

    messages = (ascMessages ?? []) as MessageRow[]
  }

  return messages
}

// ─── Date helpers ───────────────────────────────────────────

function getYesterdayDateString(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

