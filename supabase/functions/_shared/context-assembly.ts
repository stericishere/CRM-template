// supabase/functions/_shared/context-assembly.ts
// Pure function: assembles GlobalContext + MessageContext into ReadOnlyContext
// No side effects. The LLM cannot influence what data it receives.
//
// ┌────────────────────┐   ┌────────────────┐   ┌────────────────┐
// │ GlobalContext       │   │ Client data    │   │ Knowledge      │
// │ (workspace-level,  │   │ (fresh/invoke) │   │ search         │
// │  cacheable)        │   └───────┬────────┘   └───────┬────────┘
// └───────┬────────────┘           │                     │
//         │                        v                     v
//         │              ┌──────────────────────────────────────┐
//         └─────────────▶│         ReadOnlyContext               │
//                        │  GlobalContext + MessageContext        │
//                        └──────────────────────────────────────┘

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type {
  ReadOnlyContext,
  RecentMessage,
  BookingContext,
  FollowUpContext,
  NoteContext,
  InboundMessage,
} from './sprint2-types.ts'
import { buildGlobalContext } from './context-builders/index.ts'
import { searchKnowledge } from './knowledge-search.ts'

export async function assembleContext(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string,
  inboundMessage: InboundMessage
): Promise<ReadOnlyContext> {
  // All queries run in parallel for latency optimization
  const [
    workspace,
    client,
    compactSummary,
    recentMessages,
    activeBookings,
    openFollowUps,
    recentNotes,
    conversationState,
    knowledgeChunks,
    communicationRuleInstructions,
  ] = await Promise.all([
    loadWorkspaceConfig(supabase, workspaceId),
    loadClientProfile(supabase, workspaceId, clientId),
    loadCompactSummary(supabase, workspaceId, clientId),
    loadRecentMessages(supabase, workspaceId, clientId, 10),
    loadActiveBookings(supabase, workspaceId, clientId, 5),
    loadOpenFollowUps(supabase, workspaceId, clientId, 5),
    loadRecentNotes(supabase, workspaceId, clientId, 5),
    loadConversationState(supabase, clientId),
    inboundMessage.content
      ? searchKnowledge(supabase, workspaceId, inboundMessage.content, { topK: 5, tokenBudget: 2000 })
      : Promise.resolve([]),
    loadCommunicationRules(supabase, workspaceId),
  ])

  // Build GlobalContext, then merge in DB-loaded communication rules (F-15)
  const globalContext = buildGlobalContext(workspaceId, workspace)

  // Merge table-sourced rules (F-15) with any rules from workspace config.
  // Table rules come first (higher signal: learned from staff edits).
  if (communicationRuleInstructions.length > 0) {
    const tableRules = communicationRuleInstructions.map((instruction) => ({
      rule: instruction,
      source: 'learned',
      createdAt: new Date().toISOString(),
    }))
    globalContext.memory = {
      ...globalContext.memory,
      communicationRules: [
        ...tableRules,
        ...globalContext.memory.communicationRules,
      ],
    }
  }

  return {
    // GlobalContext — built by global-context/ router, enriched with F-15 rules
    ...globalContext,

    // MessageContext (per-client, per-message)
    sessionKey: `workspace:${workspaceId}:client:${clientId}`,
    knowledgeChunks,
    client: {
      id: client.id,
      name: client.full_name,
      phone: client.phone,
      lifecycleStatus: client.lifecycle_status,
      tags: client.tags ?? [],
      preferences: client.preferences ?? {},
      lastContactedAt: client.last_contacted_at,
    },
    compactSummary,
    recentMessages,
    activeBookings,
    openFollowUps,
    recentNotes,
    conversationState,
    inboundMessage,
  }
}

// --- Data Loaders (all workspace-scoped) ---

async function loadWorkspaceConfig(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('*')
    .eq('id', workspaceId)
    .single()

  if (error) throw new Error(`Failed to load workspace: ${error.message}`)
  return data
}

async function loadClientProfile(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .single()

  if (error) throw new Error(`Failed to load client: ${error.message}`)
  return data
}

async function loadCompactSummary(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('memories')
    .select('content')
    .eq('workspace_id', workspaceId)
    .eq('client_id', clientId)
    .eq('type', 'compact_summary')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data?.content ?? null
}

async function loadRecentMessages(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string,
  limit: number
): Promise<RecentMessage[]> {
  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('client_id', clientId)
    .single()

  if (!conv) return []

  const { data: msgs } = await supabase
    .from('messages')
    .select('direction, content, created_at, sender_type')
    .eq('conversation_id', conv.id)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit)

  return (msgs ?? []).reverse().map((m: Record<string, unknown>) => ({
    direction: m.direction as 'inbound' | 'outbound',
    content: m.content as string | null,
    timestamp: m.created_at as string,
    senderType: m.sender_type as string,
  }))
}

async function loadActiveBookings(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string,
  limit: number
): Promise<BookingContext[]> {
  const { data } = await supabase
    .from('bookings')
    .select('appointment_type, start_time, status, confirmation_status')
    .eq('workspace_id', workspaceId)
    .eq('client_id', clientId)
    .in('status', ['confirmed', 'pending'])
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true })
    .limit(limit)

  return (data ?? []).map((b: Record<string, unknown>) => ({
    appointmentType: b.appointment_type as string,
    startTime: b.start_time as string,
    status: b.status as string,
    confirmationStatus: b.confirmation_status as string,
  }))
}

async function loadOpenFollowUps(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string,
  limit: number
): Promise<FollowUpContext[]> {
  const { data } = await supabase
    .from('follow_ups')
    .select('content, due_date, status')
    .eq('workspace_id', workspaceId)
    .eq('client_id', clientId)
    .eq('status', 'open')
    .order('due_date', { ascending: true })
    .limit(limit)

  return (data ?? []).map((f: Record<string, unknown>) => ({
    content: f.content as string,
    dueDate: (f.due_date as string) ?? null,
    status: f.status as string,
  }))
}

async function loadRecentNotes(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string,
  limit: number
): Promise<NoteContext[]> {
  const { data } = await supabase
    .from('notes')
    .select('content, source, created_at')
    .eq('workspace_id', workspaceId)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(limit)

  return (data ?? []).map((n: Record<string, unknown>) => ({
    content: n.content as string,
    source: n.source as string,
    createdAt: n.created_at as string,
  }))
}

async function loadConversationState(
  supabase: SupabaseClient,
  clientId: string
): Promise<string> {
  const { data } = await supabase
    .from('conversations')
    .select('state')
    .eq('client_id', clientId)
    .single()

  return data?.state ?? 'idle'
}

/**
 * Load active communication rules from the communication_rules table.
 * These are workspace-scoped instructions learned from staff edit patterns (F-15).
 * Returns rules ordered by confidence (highest first), capped at 20.
 */
async function loadCommunicationRules(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('communication_rules')
    .select('instruction, confidence')
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .order('confidence', { ascending: false })
    .limit(20)

  return (data ?? []).map(
    (r: { instruction: string; confidence: number }) => r.instruction,
  )
}

