# Sprint 2: AI Pipeline, Governance, Signals & Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the core product experience: inbound WhatsApp messages produce AI-drafted replies with governance, signal capture, and workspace onboarding.

**Architecture:** OpenRouter (OpenAI-compatible SDK) replaces direct Anthropic SDK for LLM calls (ADR-005 update). Context assembly is a pure function feeding a single-agent tool-calling loop. Approval boundary gates all write actions. Signal recording captures every staff action on drafts. Onboarding wizard sets up workspace config, knowledge base, SOPs, and tone profile.

**Tech Stack:** Supabase Edge Functions (Deno), OpenRouter API (Claude Sonnet 4), OpenAI Embeddings (text-embedding-3-small), pgvector, pgmq, Next.js App Router, Zod, Vitest

**Owner decision:** LLM calls route through OpenRouter (`OPENROUTER_API_KEY` in env), not direct Anthropic SDK. This is an ADR-005 amendment.

---

## Dependency Graph

```
                    ┌──────────────┐
                    │   Task 1     │  DB Migration (Sprint 2 schema changes)
                    │   Task 2     │  Shared Types
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              v            v            v
     ┌────────────┐ ┌───────────┐ ┌──────────────────────┐
     │ Stream A   │ │ Stream B  │ │ Stream C (parallel)  │
     │ F-05 Core  │ │ F-06 Gov  │ │ F-01 Onboarding      │
     │            │ │ (after    │ │                       │
     │ Tasks 3-12 │ │ Task 10)  │ │ Tasks 22-28          │
     └─────┬──────┘ │ Tasks     │ └───────────────────────┘
           │        │ 13-17     │
           │        └─────┬─────┘
           │              │
           v              v
     ┌──────────┐  ┌──────────┐
     │ F-10     │  │ Approve  │
     │ Signals  │  │ Action   │
     │ Tasks    │  │ EF       │
     │ 18-21    │  │ Task 17  │
     └──────────┘  └──────────┘
```

**Parallel streams:**
- Stream A (F-05) and Stream C (F-01) can execute concurrently
- Stream B (F-06) starts after F-05 Task 10 (tool registry defines ProposedAction type)
- F-10 (Tasks 18-21) starts after F-05 Task 11 (drafts table populated)

---

## File Structure

### New files (Edge Functions — Deno)

```
supabase/functions/
  _shared/
    llm-client.ts              # OpenRouter client (OpenAI-compatible)
    embedding.ts               # OpenAI text-embedding-3-small
    context-assembly.ts        # Pure function: workspace + client data → ReadOnlyContext
    system-prompt.ts           # Dynamic system prompt from workspace config
    agent-runtime.ts           # LLM call + tool execution loop
    tool-registry.ts           # Tool definitions + Zod schemas
    tool-executor.ts           # Parameter injection + dispatch
    knowledge-search.ts        # pgvector cosine similarity search
    draft-persistence.ts       # Save draft + update conversation state
    approval-policy.ts         # Tier classification (auto/review/human_only)
    action-executor.ts         # Dispatch approved actions to domain writes
    confirmation-builder.ts    # Build human-readable confirmation summaries
    sprint2-types.ts           # Sprint 2 type additions
  approve-action/
    index.ts                   # Edge Function: staff approve/reject
  embed-knowledge/
    index.ts                   # Edge Function: chunk + embed + upsert
```

### New files (Next.js)

```
src/
  lib/
    learning/
      record-signal.ts         # recordDraftEditSignal utility
      record-signal.test.ts    # Unit tests
    supabase/
      service.ts               # Service role client for server actions
  app/
    (dashboard)/
      inbox/
        [conversationId]/
          actions.ts            # Server actions: send, discard, regenerate
          page.tsx              # Conversation thread (modify existing or create)
    onboarding/
      layout.tsx               # Onboarding shell
      page.tsx                  # Redirect to current step
      whatsapp/page.tsx         # Step 1: QR pairing
      identity/page.tsx         # Step 2: Business identity
      knowledge/page.tsx        # Step 3: KB setup
      sops/page.tsx             # Step 4: SOP generation
      tone/page.tsx             # Step 5: Tone profile
      summary/page.tsx          # Step 6: Review + activate
  components/
    draft/
      DraftCard.tsx             # Draft review card
      DraftActions.tsx          # Send/Edit/Regenerate/Discard buttons
    onboarding/
      StepIndicator.tsx         # Progress bar
      QrCodeDisplay.tsx         # QR image + countdown
```

### Modified files

```
supabase/functions/process-message/index.ts   # Upgrade: add context assembly + LLM pipeline
supabase/functions/_shared/types.ts            # Add Sprint 2 types
supabase/migrations/20260318000004_sprint2.sql # Sprint 2 schema changes
.env.local                                      # Add OPENROUTER_API_KEY, OPENAI_API_KEY
.env.local.example                              # Document new env vars
```

---

## Task 1: Sprint 2 Database Migration

**Files:**
- Create: `supabase/migrations/20260318000004_sprint2.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- ============================================================
-- SPRINT 2 SCHEMA CHANGES
-- ============================================================

-- 1. Add scenario_type to drafts (F-05/F-10 need this)
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS scenario_type TEXT;

-- 2. Add draft_id FK to proposed_actions (F-06 links actions to drafts)
ALTER TABLE proposed_actions
  ADD COLUMN IF NOT EXISTS draft_id UUID REFERENCES drafts(id);
ALTER TABLE proposed_actions
  ADD COLUMN IF NOT EXISTS renotified_at TIMESTAMPTZ;
ALTER TABLE proposed_actions
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 3. Add CHECK constraint + indexes to draft_edit_signals (F-10)
ALTER TABLE draft_edit_signals
  ADD COLUMN IF NOT EXISTS scenario_type TEXT NOT NULL DEFAULT 'unclassified';
ALTER TABLE draft_edit_signals
  ADD CONSTRAINT chk_staff_action CHECK (staff_action IN (
    'sent_as_is', 'edited_and_sent', 'regenerated', 'discarded'
  ));
CREATE INDEX IF NOT EXISTS idx_draft_edit_signals_workspace
  ON draft_edit_signals(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_draft_edit_signals_draft
  ON draft_edit_signals(draft_id);
CREATE INDEX IF NOT EXISTS idx_draft_edit_signals_workspace_action
  ON draft_edit_signals(workspace_id, staff_action, created_at DESC);

-- 4. Add workspace onboarding columns (F-01)
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS knowledge_base TEXT;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS whatsapp_connection_status TEXT DEFAULT 'disconnected';
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number TEXT;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS instagram_scrape_data JSONB;

-- 5. Knowledge search RPC (F-05 pgvector)
CREATE OR REPLACE FUNCTION search_knowledge_chunks(
  query_embedding vector(1536),
  match_workspace_id UUID,
  match_count INT DEFAULT 5,
  min_similarity FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  source TEXT,
  source_ref TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.source,
    kc.source_ref,
    1 - (kc.embedding <=> query_embedding)::FLOAT AS similarity
  FROM knowledge_chunks kc
  WHERE kc.workspace_id = match_workspace_id
    AND 1 - (kc.embedding <=> query_embedding) >= min_similarity
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 6. RLS for draft_edit_signals (F-10)
ALTER TABLE draft_edit_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation_select" ON draft_edit_signals
  FOR SELECT TO authenticated
  USING (workspace_id = auth.workspace_id());

-- 7. RLS for knowledge_chunks
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON knowledge_chunks
  FOR ALL TO authenticated
  USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- 8. Index for proposed_actions by conversation
CREATE INDEX IF NOT EXISTS idx_proposed_actions_conversation
  ON proposed_actions(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_proposed_actions_workspace
  ON proposed_actions(workspace_id, status, created_at DESC);
```

- [ ] **Step 2: Apply migration to Supabase**

Run: `npx supabase db push` (or use MCP `apply_migration`)
Expected: Migration applies successfully, no errors.

- [ ] **Step 3: Verify schema**

Run: `npx supabase db diff` — should show no pending changes.
Verify: `drafts.scenario_type` exists, `proposed_actions.draft_id` exists, `search_knowledge_chunks` function exists.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260318000004_sprint2.sql
git commit -m "feat: Sprint 2 database migration — schema extensions for AI pipeline, governance, signals"
```

---

## Task 2: Shared Types for Sprint 2

**Files:**
- Modify: `supabase/functions/_shared/types.ts`
- Create: `supabase/functions/_shared/sprint2-types.ts`

- [ ] **Step 1: Create Sprint 2 types file**

```typescript
// supabase/functions/_shared/sprint2-types.ts
// Types for F-05, F-06, F-10

// === Context Assembly (F-05) ===

export interface ReadOnlyContext {
  sessionKey: string
  workspace: WorkspaceContext
  verticalConfig: VerticalConfig
  communicationRules: CommunicationRule[]
  knowledgeChunks: KnowledgeChunk[]
  client: ClientContext
  compactSummary: string | null
  recentMessages: MessageContext[]
  activeBookings: BookingContext[]
  openFollowUps: FollowUpContext[]
  recentNotes: NoteContext[]
  conversationState: string
  inboundMessage: InboundMessage
}

export interface WorkspaceContext {
  businessName: string
  timezone: string
  businessHours: Record<string, { open: string; close: string }> | null
  toneProfile: string | null
}

export interface VerticalConfig {
  customFields: Array<{ name: string; description: string }>
  appointmentTypes: Array<{ name: string; description: string }>
  sopRules: string[]
}

export interface CommunicationRule {
  rule: string
  source: string
  createdAt: string
}

export interface KnowledgeChunk {
  id: string
  content: string
  source: string
  sourceRef: string | null
  similarity: number
}

export interface ClientContext {
  id: string
  name: string | null
  phone: string
  lifecycleStatus: string
  tags: string[]
  preferences: Record<string, unknown>
  lastContactedAt: string | null
}

export interface MessageContext {
  direction: 'inbound' | 'outbound'
  content: string | null
  timestamp: string
  senderType: string
}

export interface BookingContext {
  appointmentType: string
  startTime: string
  status: string
  confirmationStatus: string
}

export interface FollowUpContext {
  content: string
  dueDate: string | null
  status: string
}

export interface NoteContext {
  content: string
  source: string
  createdAt: string
}

export interface InboundMessage {
  content: string | null
  mediaType: string | null
  mediaTranscription: string | null
  timestamp: string
}

// === Agent Runtime (F-05) ===

export interface ClientWorkerResult {
  draft: string
  intent: string
  confidence: number
  scenarioType: string
  knowledgeSources: string[]
  proposedActions: ProposedAction[]
  usage: { tokensIn: number; tokensOut: number }
}

export interface LLMToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  output: unknown
  proposedAction?: ProposedAction
}

export interface ToolDefinition {
  name: string
  description: string
  authority: 'read' | 'auto_write' | 'propose_write'
  schema: import('https://esm.sh/zod@3').ZodType
  fixedParams: Record<string, unknown>
  execute: (params: Record<string, unknown>) => Promise<ToolResult>
}

export type ToolRegistry = Record<string, ToolDefinition>

// === Approval & Governance (F-06) ===

export interface ProposedAction {
  id?: string
  workspaceId: string
  clientId: string
  conversationId: string
  draftId?: string
  actionType: ProposedActionType
  summary: string
  tier: ApprovalTier
  payload: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'expired'
}

export type ProposedActionType =
  | 'client_update'
  | 'booking_create'
  | 'followup_create'
  | 'message_send'
  | 'note_create'
  | 'last_contacted_update'
  | 'tag_attach'

export type ApprovalTier = 'auto' | 'review' | 'human_only'

export interface ApprovalPolicy {
  autoActions: Set<string>
  humanOnlyActions: Set<string>
  // Everything else defaults to 'review'
}

// === Learning Signals (F-10) ===

export type StaffAction = 'sent_as_is' | 'edited_and_sent' | 'regenerated' | 'discarded'

export interface DraftEditSignalInput {
  workspaceId: string
  clientId: string
  draftId: string
  staffAction: StaffAction
  originalDraft: string
  finalVersion: string | null
  intentClassified: string
  scenarioType: string
}

// === Intent Taxonomy ===

export const INTENT_TAXONOMY = [
  'booking_inquiry',
  'pricing_question',
  'general_question',
  'follow_up',
  'greeting',
  'complaint',
  'cancellation',
  'reschedule',
  'out_of_scope',
] as const

export type IntentType = typeof INTENT_TAXONOMY[number]

export const SCENARIO_TYPES = [
  'first_contact',
  'returning_client',
  'booking_flow',
  'faq_response',
  'follow_up_reply',
  'complaint_handling',
  'general',
] as const

export type ScenarioType = typeof SCENARIO_TYPES[number]
```

- [ ] **Step 2: Update existing types.ts with Sprint 2 additions**

Add to `supabase/functions/_shared/types.ts`:
```typescript
// Re-export Sprint 2 types
export type { ReadOnlyContext, ClientWorkerResult, ProposedAction, ApprovalTier, StaffAction, DraftEditSignalInput } from './sprint2-types.ts'
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/sprint2-types.ts supabase/functions/_shared/types.ts
git commit -m "feat: add Sprint 2 shared types — context assembly, agent runtime, governance, signals"
```

---

## Task 3: OpenRouter LLM Client

**Files:**
- Create: `supabase/functions/_shared/llm-client.ts`
- Modify: `.env.local.example`

- [ ] **Step 1: Create LLM client module**

```typescript
// supabase/functions/_shared/llm-client.ts
// OpenRouter-compatible LLM client using OpenAI SDK
// ADR-005 amendment: routes through OpenRouter, models from env vars

import OpenAI from 'https://esm.sh/openai@4'

// Models from environment variables
export const PRO_MODEL = Deno.env.get('PRO_MODEL') ?? 'anthropic/claude-sonnet-4-20250514'
export const FLASH_MODEL = Deno.env.get('FLASH_MODEL') ?? 'anthropic/claude-haiku-4-5-20251001'
export const SMALL_MODEL = Deno.env.get('SMALL_MODEL') ?? 'anthropic/claude-haiku-4-5-20251001'
export const EMBEDDING_MODEL = Deno.env.get('EMBEDDING_MODEL') ?? 'text-embedding-3-small'

let _client: OpenAI | null = null

export function getLLMClient(): OpenAI {
  if (_client) return _client

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY environment variable')
  }

  _client = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': Deno.env.get('SITE_URL') ?? 'https://crm-template.vercel.app',
      'X-Title': 'CRM Template',
    },
  })

  return _client
}

export interface LLMCallParams {
  model?: string
  systemPrompt: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  tools?: OpenAI.Chat.ChatCompletionTool[]
  maxTokens?: number
}

export interface LLMCallResult {
  message: OpenAI.Chat.ChatCompletionMessage
  usage: { tokensIn: number; tokensOut: number }
  model: string
  finishReason: string | null
}

export async function callLLM(params: LLMCallParams): Promise<LLMCallResult> {
  const client = getLLMClient()
  const model = params.model ?? PRO_MODEL

  const response = await client.chat.completions.create({
    model,
    max_tokens: params.maxTokens ?? 1024,
    messages: [
      { role: 'system', content: params.systemPrompt },
      ...params.messages,
    ],
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
  })

  const choice = response.choices[0]
  if (!choice) throw new Error('LLM returned no choices')

  return {
    message: choice.message,
    usage: {
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
    },
    model: response.model ?? model,
    finishReason: choice.finish_reason,
  }
}

/**
 * Calculate estimated cost in USD based on model and token counts.
 * Prices are approximate and should be updated periodically.
 */
export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  // Approximate pricing per 1M tokens (as of March 2026)
  const pricing: Record<string, { input: number; output: number }> = {
    'anthropic/claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
    'anthropic/claude-haiku-4-5-20251001': { input: 0.80, output: 4.0 },
  }

  const p = pricing[model] ?? { input: 3.0, output: 15.0 }
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000
}

export { PRO_MODEL, FLASH_MODEL }
```

- [ ] **Step 2: Update .env.local.example**

Add:
```
# OpenRouter
OPENROUTER_API_KEY=sk-or-...

# Models (OpenRouter model IDs)
PRO_MODEL=anthropic/claude-sonnet-4-20250514
FLASH_MODEL=anthropic/claude-haiku-4-5-20251001
SMALL_MODEL=anthropic/claude-haiku-4-5-20251001
EMBEDDING_MODEL=text-embedding-3-small

# OpenAI (for embeddings if not using OpenRouter)
OPENAI_API_KEY=sk-...
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/llm-client.ts .env.local.example
git commit -m "feat: OpenRouter LLM client — ADR-005 amendment, routes via OpenRouter"
```

---

## Task 4: Embedding Generator

**Files:**
- Create: `supabase/functions/_shared/embedding.ts`

- [ ] **Step 1: Create embedding module**

```typescript
// supabase/functions/_shared/embedding.ts
// OpenAI text-embedding-3-small (1536 dimensions)
// Used for knowledge base indexing and query-time search

import OpenAI from 'https://esm.sh/openai@4'

let _client: OpenAI | null = null

function getEmbeddingClient(): OpenAI {
  if (_client) return _client

  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable')
  }

  _client = new OpenAI({ apiKey })
  return _client
}

/**
 * Generate a 1536-dimensional embedding for a text string.
 * Uses text-embedding-3-small for cost efficiency.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getEmbeddingClient()

  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000), // Hard limit to prevent token overflow
    dimensions: 1536,
  })

  const embedding = response.data[0]?.embedding
  if (!embedding) throw new Error('Embedding API returned no data')
  return embedding
}

/**
 * Generate embeddings for multiple texts in a single API call.
 * More efficient than calling generateEmbedding() in a loop.
 */
export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const client = getEmbeddingClient()

  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts.map(t => t.slice(0, 8000)),
    dimensions: 1536,
  })

  return response.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding)
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/embedding.ts
git commit -m "feat: embedding generator — text-embedding-3-small via OpenAI"
```

---

## Task 5: Knowledge Search Module

**Files:**
- Create: `supabase/functions/_shared/knowledge-search.ts`

- [ ] **Step 1: Create knowledge search module**

```typescript
// supabase/functions/_shared/knowledge-search.ts
// pgvector cosine similarity search, workspace-scoped

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { KnowledgeChunk } from './sprint2-types.ts'
import { generateEmbedding } from './embedding.ts'

interface SearchOptions {
  topK?: number
  minSimilarity?: number
  tokenBudget?: number
}

/**
 * Semantic search against workspace knowledge base.
 * Returns top-K chunks by cosine similarity, within token budget.
 */
export async function searchKnowledge(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
  options: SearchOptions = {}
): Promise<KnowledgeChunk[]> {
  const { topK = 5, minSimilarity = 0.7, tokenBudget = 2000 } = options

  if (!query || query.trim().length === 0) return []

  // 1. Generate query embedding
  const embedding = await generateEmbedding(query)

  // 2. Call pgvector search RPC
  const { data: chunks, error } = await supabase.rpc('search_knowledge_chunks', {
    query_embedding: JSON.stringify(embedding),
    match_workspace_id: workspaceId,
    match_count: topK,
    min_similarity: minSimilarity,
  })

  if (error) {
    console.error('[knowledge_search] RPC failed:', error.message)
    return []
  }

  if (!chunks || chunks.length === 0) return []

  // 3. Apply token budget (rough estimate: 1 token ~= 4 chars)
  return applyTokenBudget(
    chunks.map((c: Record<string, unknown>) => ({
      id: c.id as string,
      content: c.content as string,
      source: c.source as string,
      sourceRef: (c.source_ref as string) ?? null,
      similarity: c.similarity as number,
    })),
    tokenBudget
  )
}

function applyTokenBudget(
  chunks: KnowledgeChunk[],
  tokenBudget: number
): KnowledgeChunk[] {
  const result: KnowledgeChunk[] = []
  let tokenCount = 0

  for (const chunk of chunks) {
    const chunkTokens = Math.ceil(chunk.content.length / 4)
    if (tokenCount + chunkTokens > tokenBudget) break
    result.push(chunk)
    tokenCount += chunkTokens
  }

  return result
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/knowledge-search.ts
git commit -m "feat: knowledge search — pgvector cosine similarity with token budget"
```

---

## Task 6: Context Assembler

**Files:**
- Create: `supabase/functions/_shared/context-assembly.ts`

- [ ] **Step 1: Create context assembly module**

```typescript
// supabase/functions/_shared/context-assembly.ts
// Pure function: assembles all workspace + client data into ReadOnlyContext
// No side effects. The LLM cannot influence what data it receives.
//
// ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
// │ Workspace data │   │ Client data    │   │ Knowledge      │
// │ (cacheable)    │   │ (fresh/invoke) │   │ search         │
// └───────┬────────┘   └───────┬────────┘   └───────┬────────┘
//         │                    │                     │
//         v                    v                     v
//     ┌──────────────────────────────────────────────────┐
//     │             ReadOnlyContext                       │
//     │  (~12K token budget, deterministic truncation)    │
//     └──────────────────────────────────────────────────┘

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type {
  ReadOnlyContext,
  WorkspaceContext,
  VerticalConfig,
  CommunicationRule,
  ClientContext,
  MessageContext,
  BookingContext,
  FollowUpContext,
  NoteContext,
  InboundMessage,
} from './sprint2-types.ts'
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
  ])

  return {
    sessionKey: `workspace:${workspaceId}:client:${clientId}`,
    workspace: {
      businessName: workspace.business_name,
      timezone: workspace.timezone,
      businessHours: workspace.business_hours,
      toneProfile: workspace.tone_profile,
    },
    verticalConfig: parseVerticalConfig(workspace.vertical_config),
    communicationRules: parseCommunicationRules(workspace.communication_profile),
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
): Promise<MessageContext[]> {
  const { data } = await supabase
    .from('messages')
    .select('direction, content, created_at, sender_type, conversation_id')
    .eq('workspace_id', workspaceId)
    .in('conversation_id', supabase
      .from('conversations')
      .select('id')
      .eq('client_id', clientId)
    )
    .order('created_at', { ascending: false })
    .limit(limit)

  // Workaround: subquery in .in() may not work with Supabase client.
  // Alternative: join via conversation_id after loading conversation.
  // For now, use a simpler approach:
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

// --- Parsers ---

function parseVerticalConfig(config: unknown): VerticalConfig {
  if (!config || typeof config !== 'object') {
    return { customFields: [], appointmentTypes: [], sopRules: [] }
  }
  const c = config as Record<string, unknown>
  return {
    customFields: Array.isArray(c.customFields) ? c.customFields : [],
    appointmentTypes: Array.isArray(c.appointmentTypes) ? c.appointmentTypes : [],
    sopRules: Array.isArray(c.sopRules) ? c.sopRules : [],
  }
}

function parseCommunicationRules(profile: unknown): CommunicationRule[] {
  if (!profile || typeof profile !== 'object') return []
  const p = profile as Record<string, unknown>
  return Array.isArray(p.rules) ? p.rules : []
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/context-assembly.ts
git commit -m "feat: context assembler — pure function, parallel data loading, workspace-scoped"
```

---

## Task 7: System Prompt Composer

**Files:**
- Create: `supabase/functions/_shared/system-prompt.ts`

- [ ] **Step 1: Create system prompt module**

```typescript
// supabase/functions/_shared/system-prompt.ts
// Composes dynamic system prompt from workspace config at assembly time

import type { WorkspaceContext, VerticalConfig, CommunicationRule } from './sprint2-types.ts'
import { INTENT_TAXONOMY } from './sprint2-types.ts'

const ROLE_PREAMBLE = `You are a customer service representative acting on behalf of the business below. You respond to client messages via WhatsApp. You are helpful, professional, and personalized.

Your job is to:
1. Classify the client's intent
2. Search the knowledge base if needed
3. Draft a reply as the business (not as an AI)
4. Propose any actions needed (bookings, follow-ups, client updates)

CRITICAL RULES:
- Never reveal you are an AI. Write as the business.
- Never fabricate information. If you don't know, say so honestly.
- Match the tone profile below exactly.
- Personalize using client context.
- All proposed actions go through staff approval. You cannot execute writes directly.`

export function composeSystemPrompt(
  workspace: WorkspaceContext,
  verticalConfig: VerticalConfig,
  communicationRules: CommunicationRule[],
  options: { calendarConnected: boolean } = { calendarConnected: false }
): string {
  const sections: string[] = [ROLE_PREAMBLE]

  // Business Identity
  sections.push(`## Business Identity
Business: ${workspace.businessName}
Timezone: ${workspace.timezone}
Business Hours: ${formatBusinessHours(workspace.businessHours)}`)

  // Tone
  if (workspace.toneProfile) {
    sections.push(`## Tone and Voice
${workspace.toneProfile}`)
  }

  // SOPs
  if (verticalConfig.sopRules.length > 0) {
    sections.push(`## SOP Rules
${verticalConfig.sopRules.map(r => `- ${r}`).join('\n')}`)
  }

  // Custom Fields
  if (verticalConfig.customFields.length > 0) {
    sections.push(`## Custom Fields
${verticalConfig.customFields.map(f => `- ${f.name}: ${f.description}`).join('\n')}`)
  }

  // Appointment Types
  if (verticalConfig.appointmentTypes.length > 0) {
    sections.push(`## Appointment Types
${verticalConfig.appointmentTypes.map(t => `- ${t.name}: ${t.description}`).join('\n')}`)
  }

  // Communication Rules (learned)
  if (communicationRules.length > 0) {
    sections.push(`## Communication Rules (Learned from past interactions)
${communicationRules.map(r => `- ${r.rule}`).join('\n')}`)
  }

  // Intent Classification
  sections.push(`## Intent Classification
Classify every message into exactly one primary intent: ${INTENT_TAXONOMY.join(', ')}.
If multiple intents are present, classify the most actionable one as primary.
Report your confidence as a float between 0.0 and 1.0.`)

  // Calendar note
  if (!options.calendarConnected) {
    sections.push(`## Calendar Status
Calendar is NOT connected. Do not offer to check availability or book appointments. If the client asks about scheduling, let them know you'll need to check manually and follow up.`)
  }

  // Output format
  sections.push(`## Output Format
After processing, your final message should be the draft reply text to send to the client.
Include your intent classification and confidence in a structured JSON block at the START of your response, formatted as:
\`\`\`json
{"intent": "booking_inquiry", "confidence": 0.95, "scenario_type": "returning_client"}
\`\`\`
Then write the draft reply text below it.`)

  return sections.join('\n\n')
}

function formatBusinessHours(
  hours: Record<string, { open: string; close: string }> | null
): string {
  if (!hours) return 'Not specified'
  return Object.entries(hours)
    .map(([day, h]) => `${day}: ${h.open}-${h.close}`)
    .join(', ')
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/system-prompt.ts
git commit -m "feat: system prompt composer — dynamic from workspace config, intent taxonomy"
```

---

## Task 8: Draft Persistence Module

**Files:**
- Create: `supabase/functions/_shared/draft-persistence.ts`

- [ ] **Step 1: Create draft persistence module**

```typescript
// supabase/functions/_shared/draft-persistence.ts
// Saves draft to drafts table + updates conversation state
// The INSERT triggers Supabase Realtime ("draft ready" notification)

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface SaveDraftParams {
  conversationId: string
  workspaceId: string
  content: string
  intentClassified: string
  confidenceScore: number
  knowledgeSources: string[]
  scenarioType: string
}

export async function saveDraft(
  supabase: SupabaseClient,
  params: SaveDraftParams
): Promise<{ draftId: string }> {
  const { data: draft, error } = await supabase
    .from('drafts')
    .insert({
      conversation_id: params.conversationId,
      workspace_id: params.workspaceId,
      content: params.content,
      intent_classified: params.intentClassified,
      confidence_score: params.confidenceScore,
      knowledge_sources: params.knowledgeSources,
      scenario_type: params.scenarioType,
      staff_action: null,
      edited_content: null,
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to save draft: ${error.message}`)

  // Update conversation state -> 'awaiting_staff_review'
  const { error: stateError } = await supabase
    .from('conversations')
    .update({ state: 'awaiting_staff_review' })
    .eq('id', params.conversationId)

  if (stateError) {
    console.error('[draft_persistence] Failed to update conversation state:', stateError.message)
    // Non-fatal: draft is saved, staff will see it
  }

  return { draftId: draft.id }
}

/**
 * Log LLM usage to the llm_usage table.
 * Best-effort: failures are logged but never block processing.
 */
export async function logLLMUsage(
  supabase: SupabaseClient,
  params: {
    workspaceId: string
    clientId: string | null
    edgeFunctionName: string
    model: string
    tokensIn: number
    tokensOut: number
    latencyMs: number
    costUsd: number
  }
): Promise<void> {
  try {
    const { error } = await supabase.from('llm_usage').insert({
      workspace_id: params.workspaceId,
      client_id: params.clientId,
      edge_function_name: params.edgeFunctionName,
      model: params.model,
      tokens_in: params.tokensIn,
      tokens_out: params.tokensOut,
      latency_ms: params.latencyMs,
      cost_usd: params.costUsd,
    })

    if (error) {
      console.error('[llm_usage] Insert failed:', error.message)
    }
  } catch (err) {
    console.error('[llm_usage] Exception:', err)
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/draft-persistence.ts
git commit -m "feat: draft persistence — save draft + LLM usage logging"
```

---

## Task 9: Tool Registry

**Files:**
- Create: `supabase/functions/_shared/tool-registry.ts`

- [ ] **Step 1: Create tool registry**

```typescript
// supabase/functions/_shared/tool-registry.ts
// Defines all tools available to the Client Worker LLM agent
// Tools are registered with Zod schemas for parameter validation
// Authority levels: read (direct), auto_write (immediate), propose_write (needs approval)

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { ToolDefinition, ToolRegistry, ToolResult, ProposedAction } from './sprint2-types.ts'
import { searchKnowledge } from './knowledge-search.ts'

// Build OpenAI-compatible tool definitions for the LLM API call
export function buildToolDefinitions(
  registry: ToolRegistry,
  workspace: { calendarConnected: boolean }
): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  return Object.values(registry)
    .filter(tool => {
      // Exclude calendar tools if not connected
      if (!workspace.calendarConnected &&
          (tool.name === 'calendar_query' || tool.name === 'calendar_book')) {
        return false
      }
      return true
    })
    .map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toolParamsToJsonSchema(tool.name),
      },
    }))
}

function toolParamsToJsonSchema(toolName: string): Record<string, unknown> {
  const schemas: Record<string, Record<string, unknown>> = {
    knowledge_search: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for the knowledge base' },
      },
      required: ['query'],
    },
    calendar_query: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date (ISO 8601)' },
        end_date: { type: 'string', description: 'End date (ISO 8601)' },
        appointment_type: { type: 'string', description: 'Type of appointment (optional)' },
      },
      required: ['start_date', 'end_date'],
    },
    calendar_book: {
      type: 'object',
      properties: {
        slot_id: { type: 'string', description: 'Time slot identifier' },
        appointment_type: { type: 'string', description: 'Type of appointment' },
        notes: { type: 'string', description: 'Additional notes (optional)' },
      },
      required: ['slot_id', 'appointment_type'],
    },
    update_client: {
      type: 'object',
      properties: {
        changes: {
          type: 'object',
          description: 'Key-value pairs of fields to update on the client record',
        },
      },
      required: ['changes'],
    },
    create_note: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note content' },
        type: {
          type: 'string',
          enum: ['observation', 'preference', 'context_update'],
          description: 'Note category',
        },
      },
      required: ['content', 'type'],
    },
    create_followup: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Follow-up task description' },
        due_date: { type: 'string', description: 'Due date (ISO 8601, optional)' },
      },
      required: ['description'],
    },
  }

  return schemas[toolName] ?? { type: 'object', properties: {} }
}

/**
 * Create the tool registry with a Supabase client for data access.
 */
export function createToolRegistry(supabase: SupabaseClient): ToolRegistry {
  return {
    knowledge_search: {
      name: 'knowledge_search',
      description: 'Search the workspace knowledge base for relevant information about services, pricing, policies, etc.',
      authority: 'read',
      schema: {} as never, // Validated via JSON schema at API level
      fixedParams: {},
      execute: async (params) => {
        const chunks = await searchKnowledge(
          supabase,
          params.workspaceId as string,
          params.query as string,
          { topK: 3, tokenBudget: 1500 }
        )
        return {
          output: chunks.map(c => ({
            content: c.content,
            source: c.source,
            similarity: c.similarity,
          })),
        }
      },
    },

    calendar_query: {
      name: 'calendar_query',
      description: 'Query available appointment slots from the business calendar.',
      authority: 'read',
      schema: {} as never,
      fixedParams: {},
      execute: async (_params) => {
        // Sprint 3: Google Calendar integration
        return { output: { message: 'Calendar not yet connected. Suggest manual scheduling.' } }
      },
    },

    calendar_book: {
      name: 'calendar_book',
      description: 'Propose a booking for a specific time slot. Requires staff approval.',
      authority: 'propose_write',
      schema: {} as never,
      fixedParams: {},
      execute: async (params) => {
        const action: ProposedAction = {
          workspaceId: params.workspaceId as string,
          clientId: params.clientId as string,
          conversationId: params.conversationId as string,
          actionType: 'booking_create',
          summary: `Book ${params.appointment_type} appointment`,
          tier: 'review',
          payload: {
            slotId: params.slot_id,
            appointmentType: params.appointment_type,
            notes: params.notes,
          },
          status: 'pending',
        }
        return { output: { proposed: true, summary: action.summary }, proposedAction: action }
      },
    },

    update_client: {
      name: 'update_client',
      description: 'Propose an update to the client record (name, preferences, tags, etc.).',
      authority: 'propose_write',
      schema: {} as never,
      fixedParams: {},
      execute: async (params) => {
        const action: ProposedAction = {
          workspaceId: params.workspaceId as string,
          clientId: params.clientId as string,
          conversationId: params.conversationId as string,
          actionType: 'client_update',
          summary: `Update client: ${Object.keys(params.changes as Record<string, unknown>).join(', ')}`,
          tier: 'review',
          payload: { changes: params.changes },
          status: 'pending',
        }
        return { output: { proposed: true, summary: action.summary }, proposedAction: action }
      },
    },

    create_note: {
      name: 'create_note',
      description: 'Create an observation note about this client interaction. Auto-saved.',
      authority: 'auto_write',
      schema: {} as never,
      fixedParams: { source: 'ai_extracted' },
      execute: async (params) => {
        const { error } = await supabase.from('notes').insert({
          workspace_id: params.workspaceId,
          client_id: params.clientId,
          content: params.content,
          source: 'ai_extracted',
        })

        if (error) {
          console.error('[create_note] Failed:', error.message)
          return { output: { success: false, error: error.message } }
        }

        return { output: { success: true } }
      },
    },

    create_followup: {
      name: 'create_followup',
      description: 'Propose a follow-up task for this client. Requires staff approval.',
      authority: 'propose_write',
      schema: {} as never,
      fixedParams: {},
      execute: async (params) => {
        const action: ProposedAction = {
          workspaceId: params.workspaceId as string,
          clientId: params.clientId as string,
          conversationId: params.conversationId as string,
          actionType: 'followup_create',
          summary: `Follow up: ${params.description}`,
          tier: 'review',
          payload: { description: params.description, dueDate: params.due_date ?? null },
          status: 'pending',
        }
        return { output: { proposed: true, summary: action.summary }, proposedAction: action }
      },
    },
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/tool-registry.ts
git commit -m "feat: tool registry — 6 tools with parameter injection, authority levels, JSON schemas"
```

---

## Task 10: Tool Executor with Parameter Injection

**Files:**
- Create: `supabase/functions/_shared/tool-executor.ts`

- [ ] **Step 1: Create tool executor**

```typescript
// supabase/functions/_shared/tool-executor.ts
// Critical safety mechanism: injects workspaceId + clientId on EVERY tool call
// LLM-provided values are silently overwritten (architecture-final.md SS 6.4)
//
// ┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
// │ LLM tool call│────▶│ Parameter Injector │────▶│ Tool Execute │
// │ (untrusted)  │     │ workspaceId ←session│    │ (trusted)    │
// └──────────────┘     │ clientId   ←session │    └──────────────┘
//                      └───────────────────┘

import type { ToolRegistry, ToolResult, LLMToolCall } from './sprint2-types.ts'

interface Session {
  workspaceId: string
  clientId: string
  conversationId: string
}

export async function executeToolCall(
  call: LLMToolCall,
  session: Session,
  toolRegistry: ToolRegistry
): Promise<ToolResult> {
  const tool = toolRegistry[call.name]
  if (!tool) {
    console.warn('[tool_executor] Unknown tool:', call.name)
    return { output: { error: `Unknown tool: ${call.name}` } }
  }

  // Security: log if LLM attempted to override session-scoped fields
  const args = call.arguments ?? {}
  if (args.workspaceId && args.workspaceId !== session.workspaceId) {
    console.warn('[security] LLM attempted to override workspaceId', {
      attempted: args.workspaceId,
      injected: session.workspaceId,
      tool: call.name,
    })
  }
  if (args.clientId && args.clientId !== session.clientId) {
    console.warn('[security] LLM attempted to override clientId', {
      attempted: args.clientId,
      injected: session.clientId,
      tool: call.name,
    })
  }

  // Merge: LLM args first, then session overwrite, then fixed params
  const params = {
    ...args,
    workspaceId: session.workspaceId,
    clientId: session.clientId,
    conversationId: session.conversationId,
    ...tool.fixedParams,
  }

  try {
    return await tool.execute(params)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[tool_executor] ${call.name} failed:`, message)
    return { output: { error: message } }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/tool-executor.ts
git commit -m "feat: tool executor — parameter injection, session-scoped security, error handling"
```

---

## Task 11: Agent Runtime (LLM + Tool Loop)

**Files:**
- Create: `supabase/functions/_shared/agent-runtime.ts`

- [ ] **Step 1: Create agent runtime**

```typescript
// supabase/functions/_shared/agent-runtime.ts
// Client Worker: single LLM invocation with tool-calling loop
// Max 5 tool loops. Produces draft text + ProposedActions.
//
// ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
// │ Context │──▶│ LLM Call │──▶│ Tool     │──▶│ LLM Call │─ ... ─▶ Draft
// │ Assembly│   │ (tools)  │   │ Execute  │   │ (results)│
// └─────────┘   └──────────┘   └──────────┘   └──────────┘

import type { ReadOnlyContext, ClientWorkerResult, ToolRegistry, ProposedAction, LLMToolCall } from './sprint2-types.ts'
import { callLLM, estimateCost, PRO_MODEL } from './llm-client.ts'
import { composeSystemPrompt } from './system-prompt.ts'
import { executeToolCall } from './tool-executor.ts'
import { buildToolDefinitions } from './tool-registry.ts'
import type OpenAI from 'https://esm.sh/openai@4'

const MAX_TOOL_LOOPS = 5

export async function invokeClientWorker(
  context: ReadOnlyContext,
  toolRegistry: ToolRegistry,
  options: { calendarConnected: boolean } = { calendarConnected: false }
): Promise<ClientWorkerResult> {
  const systemPrompt = composeSystemPrompt(
    context.workspace,
    context.verticalConfig,
    context.communicationRules,
    options
  )

  const session = {
    workspaceId: context.sessionKey.split(':')[1],
    clientId: context.sessionKey.split(':')[3],
    conversationId: '', // Will be set from context
  }

  // Build conversation messages from context
  const messages = buildConversationMessages(context)
  const tools = buildToolDefinitions(toolRegistry, options)

  const allProposedActions: ProposedAction[] = []
  let totalTokensIn = 0
  let totalTokensOut = 0
  let loopCount = 0

  // Initial LLM call
  let result = await callLLM({
    systemPrompt,
    messages,
    tools,
    maxTokens: 1024,
  })

  totalTokensIn += result.usage.tokensIn
  totalTokensOut += result.usage.tokensOut

  // Tool execution loop
  while (result.finishReason === 'tool_calls' && loopCount < MAX_TOOL_LOOPS) {
    loopCount++

    const toolCalls = result.message.tool_calls ?? []
    if (toolCalls.length === 0) break

    // Execute each tool call
    const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = []
    for (const toolCall of toolCalls) {
      const llmToolCall: LLMToolCall = {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments),
      }

      const toolResult = await executeToolCall(llmToolCall, session, toolRegistry)

      if (toolResult.proposedAction) {
        allProposedActions.push(toolResult.proposedAction)
      }

      toolResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult.output),
      })
    }

    // Continue conversation with tool results
    messages.push(result.message)
    messages.push(...toolResults)

    result = await callLLM({
      systemPrompt,
      messages,
      tools,
      maxTokens: 1024,
    })

    totalTokensIn += result.usage.tokensIn
    totalTokensOut += result.usage.tokensOut
  }

  // Extract draft text and structured output from final response
  const responseText = result.message.content ?? ''
  const { intent, confidence, scenarioType, draftText } = parseAgentResponse(responseText)

  // Collect knowledge sources from context
  const knowledgeSources = context.knowledgeChunks.map(c => c.source)

  return {
    draft: draftText,
    intent,
    confidence,
    scenarioType,
    knowledgeSources: [...new Set(knowledgeSources)],
    proposedActions: allProposedActions,
    usage: { tokensIn: totalTokensIn, tokensOut: totalTokensOut },
  }
}

/**
 * Build the conversation messages array for the LLM from context.
 * Recent messages become a conversation thread. The inbound message is last.
 */
function buildConversationMessages(
  context: ReadOnlyContext
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []

  // Client context summary as first user message
  const contextSummary = buildContextSummary(context)
  messages.push({ role: 'user', content: contextSummary })
  messages.push({ role: 'assistant', content: 'I understand the context. I\'ll now respond to the latest message.' })

  // Recent messages as conversation history
  for (const msg of context.recentMessages) {
    const role = msg.senderType === 'client' ? 'user' : 'assistant'
    if (msg.content) {
      messages.push({ role, content: msg.content })
    }
  }

  // The actual inbound message (if not already in recent messages)
  if (context.inboundMessage.content) {
    messages.push({ role: 'user', content: context.inboundMessage.content })
  }

  return messages
}

function buildContextSummary(context: ReadOnlyContext): string {
  const parts: string[] = []

  // Client info
  parts.push(`[Client: ${context.client.name ?? 'Unknown'} | Phone: ${context.client.phone} | Status: ${context.client.lifecycleStatus}]`)

  // Compact summary
  if (context.compactSummary) {
    parts.push(`[Previous interaction summary: ${context.compactSummary}]`)
  }

  // Knowledge chunks
  if (context.knowledgeChunks.length > 0) {
    parts.push(`[Relevant knowledge base entries:\n${context.knowledgeChunks.map(c => `- ${c.content} (source: ${c.source})`).join('\n')}]`)
  }

  // Active bookings
  if (context.activeBookings.length > 0) {
    parts.push(`[Active bookings: ${context.activeBookings.map(b => `${b.appointmentType} on ${b.startTime} (${b.status})`).join(', ')}]`)
  }

  // Open follow-ups
  if (context.openFollowUps.length > 0) {
    parts.push(`[Open follow-ups: ${context.openFollowUps.map(f => `${f.content} (due: ${f.dueDate ?? 'no date'})`).join(', ')}]`)
  }

  // Recent notes
  if (context.recentNotes.length > 0) {
    parts.push(`[Recent notes: ${context.recentNotes.map(n => n.content).join('; ')}]`)
  }

  return parts.join('\n\n')
}

/**
 * Parse the agent's final text response.
 * Expects a JSON block with intent/confidence/scenario_type followed by draft text.
 */
function parseAgentResponse(text: string): {
  intent: string
  confidence: number
  scenarioType: string
  draftText: string
} {
  // Try to extract JSON block
  const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)\n?\s*```/)
  let intent = 'general_question'
  let confidence = 0.5
  let scenarioType = 'general'
  let draftText = text

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      intent = parsed.intent ?? 'general_question'
      confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5
      scenarioType = parsed.scenario_type ?? 'general'
      // Draft text is everything after the JSON block
      draftText = text.slice(text.indexOf('```', jsonMatch.index! + 3) + 3).trim()
    } catch {
      // Failed to parse JSON — use full text as draft
      console.warn('[agent_runtime] Failed to parse structured output from LLM response')
    }
  }

  // If draft text is empty, use the full response
  if (!draftText || draftText.length === 0) {
    draftText = text.replace(/```json[\s\S]*?```/g, '').trim()
  }

  return { intent, confidence, scenarioType, draftText }
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/agent-runtime.ts
git commit -m "feat: agent runtime — LLM + tool loop, max 5 iterations, structured output parsing"
```

---

## Task 12: Upgrade process-message Edge Function

**Files:**
- Modify: `supabase/functions/process-message/index.ts`

- [ ] **Step 1: Replace the Sprint 1 stub with the full AI pipeline**

The full process-message flow:
1. Dequeue from pgmq (existing)
2. Advisory lock (existing)
3. Audit event (existing)
4. **NEW: Idempotency check** — skip if draft already exists for this message
5. **NEW: Context assembly** — load all workspace + client data
6. **NEW: Agent runtime** — LLM call with tool loop
7. **NEW: Approval policy evaluation** — classify proposed actions
8. **NEW: Save proposed actions** — persist review/human_only actions
9. **NEW: Save draft** — triggers Realtime notification
10. **NEW: Log LLM usage**
11. Delete from pgmq (existing)

```typescript
// supabase/functions/process-message/index.ts
// Full AI pipeline: dequeue → context → LLM → tools → approval → draft → usage log
//
// ┌──────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌────────┐
// │ Dequeue  │→ │ Lock    │→ │ Context │→ │ LLM +   │→ │ Approval │→ │ Save   │
// │ pgmq     │  │ advisory│  │ Assembly│  │ Tools   │  │ Evaluate │  │ Draft  │
// └──────────┘  └─────────┘  └─────────┘  └─────────┘  └──────────┘  └────────┘

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import type { InboundMessagePayload, AuditEvent } from '../_shared/types.ts'
import { assembleContext } from '../_shared/context-assembly.ts'
import { invokeClientWorker } from '../_shared/agent-runtime.ts'
import { createToolRegistry } from '../_shared/tool-registry.ts'
import { evaluateApprovalPolicy, DEFAULT_POLICY } from '../_shared/approval-policy.ts'
import { saveDraft, logLLMUsage } from '../_shared/draft-persistence.ts'
import { estimateCost, PRO_MODEL } from '../_shared/llm-client.ts'

serve(async (_req) => {
  const supabase = getSupabaseClient()
  const startTime = Date.now()

  try {
    // 1. Dequeue from pgmq
    const { data: messages, error: dequeueError } = await supabase.rpc('pgmq_read', {
      queue_name: 'inbound_messages',
      vt: 120, // Increased VT to 120s for LLM processing time
      qty: 1,
    })

    if (dequeueError) {
      console.error('Failed to dequeue:', dequeueError)
      return new Response(JSON.stringify({ error: 'Dequeue failed' }), { status: 500 })
    }

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 })
    }

    const queueMsg = messages[0]
    const payload = queueMsg.message as InboundMessagePayload

    // 2. DLQ check: if read_ct > 3, move to DLQ
    if (queueMsg.read_ct > 3) {
      console.error('[process-message] Max retries exceeded, moving to DLQ:', payload.message_id)
      await supabase.rpc('pgmq_send', {
        queue_name: 'inbound_dlq',
        msg: { ...payload, read_ct: queueMsg.read_ct, error: 'max_retries_exceeded' },
      })
      await supabase.rpc('pgmq_delete', {
        queue_name: 'inbound_messages',
        msg_id: queueMsg.msg_id,
      })
      return new Response(JSON.stringify({ processed: 0, dlq: true }), { status: 200 })
    }

    console.log('Processing message:', {
      messageId: payload.message_id,
      workspaceId: payload.workspace_id,
      clientId: payload.client_id,
      readCount: queueMsg.read_ct,
    })

    // 3. Advisory lock on client_id
    const lockKey = payload.client_id.replace(/-/g, '').slice(0, 8)
    const { data: lockAcquired } = await supabase.rpc('pg_try_advisory_xact_lock', {
      key: parseInt(lockKey, 16),
    })

    if (!lockAcquired) {
      console.log('Advisory lock not acquired, skipping:', payload.client_id)
      return new Response(JSON.stringify({ processed: 0, locked: true }), { status: 200 })
    }

    // 4. Audit event
    try {
      await supabase.from('audit_events').insert({
        workspace_id: payload.workspace_id,
        actor_type: 'system',
        actor_id: null,
        action_type: 'message_received',
        target_type: 'message',
        target_id: payload.message_id,
        metadata: {
          client_id: payload.client_id,
          conversation_id: payload.conversation_id,
          phone: payload.phone,
        },
      })
    } catch (auditErr) {
      console.error('Audit write failed (non-blocking):', auditErr)
    }

    // 5. Idempotency: check if draft already exists for this conversation's latest message
    const { data: existingDraft } = await supabase
      .from('drafts')
      .select('id')
      .eq('conversation_id', payload.conversation_id)
      .is('staff_action', null) // Only pending drafts
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingDraft) {
      console.log('Draft already exists for conversation, skipping:', payload.conversation_id)
      await supabase.rpc('pgmq_delete', {
        queue_name: 'inbound_messages',
        msg_id: queueMsg.msg_id,
      })
      return new Response(JSON.stringify({ processed: 0, idempotent: true }), { status: 200 })
    }

    // 6. Context assembly
    const context = await assembleContext(supabase, payload.workspace_id, payload.client_id, {
      content: payload.content,
      mediaType: payload.media_type,
      mediaTranscription: null,
      timestamp: new Date().toISOString(),
    })

    // 7. Check for human_only intent based on simple keyword detection
    // (Full intent-based routing happens after LLM classification)
    const calendarConnected = false // Sprint 3: check workspace.calendar_config

    // 8. Invoke Client Worker (LLM + tools)
    const toolRegistry = createToolRegistry(supabase)
    const workerResult = await invokeClientWorker(context, toolRegistry, { calendarConnected })

    // 9. Evaluate approval policy for proposed actions
    const savedActions: string[] = []
    for (const action of workerResult.proposedActions) {
      const tier = evaluateApprovalPolicy(action, DEFAULT_POLICY)
      action.tier = tier

      if (tier === 'auto') {
        // Auto-execute: already done in tool executor (create_note)
        console.log('[approval] Auto-executed:', action.actionType)
      } else {
        // Save as pending for staff review
        const { data: savedAction, error: actionError } = await supabase
          .from('proposed_actions')
          .insert({
            workspace_id: action.workspaceId,
            client_id: action.clientId,
            conversation_id: action.conversationId,
            action_type: action.actionType,
            summary: action.summary,
            tier: action.tier,
            payload: action.payload,
            status: action.status,
          })
          .select('id')
          .single()

        if (actionError) {
          console.error('[approval] Failed to save proposed action:', actionError.message)
        } else {
          savedActions.push(savedAction.id)
        }
      }
    }

    // 10. Save draft (triggers Realtime "draft ready" notification)
    const { draftId } = await saveDraft(supabase, {
      conversationId: payload.conversation_id,
      workspaceId: payload.workspace_id,
      content: workerResult.draft,
      intentClassified: workerResult.intent,
      confidenceScore: workerResult.confidence,
      knowledgeSources: workerResult.knowledgeSources,
      scenarioType: workerResult.scenarioType,
    })

    // 11. Log LLM usage
    const latencyMs = Date.now() - startTime
    await logLLMUsage(supabase, {
      workspaceId: payload.workspace_id,
      clientId: payload.client_id,
      edgeFunctionName: 'process-message',
      model: PRO_MODEL,
      tokensIn: workerResult.usage.tokensIn,
      tokensOut: workerResult.usage.tokensOut,
      latencyMs,
      costUsd: estimateCost(PRO_MODEL, workerResult.usage.tokensIn, workerResult.usage.tokensOut),
    })

    // 12. Delete from queue (successfully processed)
    await supabase.rpc('pgmq_delete', {
      queue_name: 'inbound_messages',
      msg_id: queueMsg.msg_id,
    })

    console.log('Message processed successfully:', {
      messageId: payload.message_id,
      draftId,
      intent: workerResult.intent,
      confidence: workerResult.confidence,
      proposedActions: savedActions.length,
      latencyMs,
      tokensIn: workerResult.usage.tokensIn,
      tokensOut: workerResult.usage.tokensOut,
    })

    return new Response(
      JSON.stringify({
        processed: 1,
        messageId: payload.message_id,
        draftId,
        intent: workerResult.intent,
        latencyMs,
      }),
      { status: 200 }
    )
  } catch (err) {
    console.error('Process-message error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
```

- [ ] **Step 2: Verify build**

Run: `cd supabase && npx supabase functions serve process-message --no-verify-jwt` (should start without import errors)

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/process-message/index.ts
git commit -m "feat(F-05): upgrade process-message — full AI pipeline with context assembly, LLM, tools, approval"
```

---

## Task 13: Approval Policy Module

**Files:**
- Create: `supabase/functions/_shared/approval-policy.ts`

- [ ] **Step 1: Create approval policy module**

```typescript
// supabase/functions/_shared/approval-policy.ts
// Deterministic tier classification for ProposedActions
// MVP: fixed policy (hardcoded). No per-workspace customization.

import type { ProposedAction, ApprovalTier, ApprovalPolicy } from './sprint2-types.ts'

export const DEFAULT_POLICY: ApprovalPolicy = {
  autoActions: new Set([
    'note_create',
    'last_contacted_update',
    'tag_attach',
  ]),
  humanOnlyActions: new Set([
    'refund_request',
    'pricing_change',
    'policy_exception',
    'complaint_handling',
    'liability_commitment',
  ]),
}

/**
 * Classify a ProposedAction into an approval tier.
 * Unknown action types default to 'review' (principle of least privilege).
 */
export function evaluateApprovalPolicy(
  action: ProposedAction,
  policy: ApprovalPolicy
): ApprovalTier {
  if (policy.autoActions.has(action.actionType)) return 'auto'
  if (policy.humanOnlyActions.has(action.actionType)) return 'human_only'
  return 'review'
}

/**
 * Human-only intent categories.
 * When the LLM classifies an inbound message with these intents,
 * draft generation is suppressed and the conversation is flagged.
 */
export const HUMAN_ONLY_INTENTS = new Set([
  'complaint',
  'out_of_scope',
])

export function isHumanOnlyIntent(intent: string): boolean {
  return HUMAN_ONLY_INTENTS.has(intent)
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/approval-policy.ts
git commit -m "feat(F-06): approval policy — tier classification, human-only intents"
```

---

## Task 14: Action Executor

**Files:**
- Create: `supabase/functions/_shared/action-executor.ts`

- [ ] **Step 1: Create action executor**

```typescript
// supabase/functions/_shared/action-executor.ts
// Dispatches approved ProposedActions to domain writes
// Each handler: validate → write → audit

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface ExecuteResult {
  success: boolean
  error?: string
}

export async function executeApprovedAction(
  supabase: SupabaseClient,
  action: {
    id: string
    actionType: string
    workspaceId: string
    clientId: string
    payload: Record<string, unknown>
  },
  staffId: string
): Promise<ExecuteResult> {
  const handlers: Record<string, () => Promise<ExecuteResult>> = {
    client_update: () => executeClientUpdate(supabase, action, staffId),
    booking_create: () => executeBookingCreate(supabase, action, staffId),
    followup_create: () => executeFollowUpCreate(supabase, action, staffId),
  }

  const handler = handlers[action.actionType]
  if (!handler) {
    return { success: false, error: `Unknown action type: ${action.actionType}` }
  }

  return handler()
}

async function executeClientUpdate(
  supabase: SupabaseClient,
  action: { workspaceId: string; clientId: string; payload: Record<string, unknown> },
  staffId: string
): Promise<ExecuteResult> {
  const changes = action.payload.changes as Record<string, unknown>
  if (!changes || Object.keys(changes).length === 0) {
    return { success: false, error: 'No changes provided' }
  }

  // Allowlist of updatable fields
  const allowedFields = new Set(['full_name', 'email', 'lifecycle_status', 'tags', 'preferences'])
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(changes)) {
    if (allowedFields.has(key)) {
      filtered[key] = value
    }
  }

  if (Object.keys(filtered).length === 0) {
    return { success: false, error: 'No allowed fields to update' }
  }

  filtered.updated_at = new Date().toISOString()

  const { error } = await supabase
    .from('clients')
    .update(filtered)
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)

  if (error) return { success: false, error: error.message }

  // Audit
  await writeAuditEvent(supabase, action.workspaceId, staffId, 'client_updated', 'client', action.clientId, { changes: filtered })

  return { success: true }
}

async function executeBookingCreate(
  supabase: SupabaseClient,
  action: { workspaceId: string; clientId: string; payload: Record<string, unknown> },
  staffId: string
): Promise<ExecuteResult> {
  const { error, data } = await supabase
    .from('bookings')
    .insert({
      workspace_id: action.workspaceId,
      client_id: action.clientId,
      appointment_type: action.payload.appointmentType as string,
      start_time: action.payload.startTime as string,
      end_time: action.payload.endTime as string,
      notes: (action.payload.notes as string) ?? null,
      status: 'confirmed',
      confirmation_status: 'confirmed',
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }

  await writeAuditEvent(supabase, action.workspaceId, staffId, 'booking_created', 'booking', data.id, action.payload)

  return { success: true }
}

async function executeFollowUpCreate(
  supabase: SupabaseClient,
  action: { workspaceId: string; clientId: string; payload: Record<string, unknown> },
  staffId: string
): Promise<ExecuteResult> {
  const { error, data } = await supabase
    .from('follow_ups')
    .insert({
      workspace_id: action.workspaceId,
      client_id: action.clientId,
      content: action.payload.description as string,
      due_date: (action.payload.dueDate as string) ?? null,
      status: 'open',
      created_by: staffId,
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }

  await writeAuditEvent(supabase, action.workspaceId, staffId, 'followup_created', 'follow_up', data.id, action.payload)

  return { success: true }
}

async function writeAuditEvent(
  supabase: SupabaseClient,
  workspaceId: string,
  staffId: string,
  actionType: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await supabase.from('audit_events').insert({
      workspace_id: workspaceId,
      actor_type: 'staff',
      actor_id: staffId,
      action_type: actionType,
      target_type: targetType,
      target_id: targetId,
      metadata,
    })
  } catch (err) {
    console.error('[audit] Failed to write audit event:', err)
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/action-executor.ts
git commit -m "feat(F-06): action executor — dispatch approved actions to domain writes with audit"
```

---

## Task 15: approve-action Edge Function

**Files:**
- Create: `supabase/functions/approve-action/index.ts`

- [ ] **Step 1: Create the Edge Function**

```typescript
// supabase/functions/approve-action/index.ts
// Staff approve/reject a ProposedAction
// Validates workspace ownership, executes action, updates status atomically

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient, getSupabaseClientWithAuth } from '../_shared/db.ts'
import { executeApprovedAction } from '../_shared/action-executor.ts'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401 })
  }

  try {
    const body = await req.json()
    const { proposed_action_id, decision, staff_id } = body

    if (!proposed_action_id || !decision || !staff_id) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: proposed_action_id, decision, staff_id' }),
        { status: 400 }
      )
    }

    if (decision !== 'approve' && decision !== 'reject') {
      return new Response(
        JSON.stringify({ error: 'Decision must be "approve" or "reject"' }),
        { status: 400 }
      )
    }

    const supabase = getSupabaseClient()

    // Optimistic lock: update status only if still pending
    const { data: action, error: lockError } = await supabase
      .from('proposed_actions')
      .update({
        status: decision === 'approve' ? 'approved' : 'rejected',
        reviewed_at: new Date().toISOString(),
        reviewed_by: staff_id,
      })
      .eq('id', proposed_action_id)
      .eq('status', 'pending')
      .select('*')
      .single()

    if (lockError || !action) {
      return new Response(
        JSON.stringify({ error: 'Action not found or already processed' }),
        { status: 409 }
      )
    }

    if (decision === 'approve') {
      const result = await executeApprovedAction(supabase, {
        id: action.id,
        actionType: action.action_type,
        workspaceId: action.workspace_id,
        clientId: action.client_id,
        payload: action.payload,
      }, staff_id)

      if (!result.success) {
        // Rollback: set status back to pending
        await supabase
          .from('proposed_actions')
          .update({ status: 'pending', reviewed_at: null, reviewed_by: null })
          .eq('id', proposed_action_id)

        return new Response(
          JSON.stringify({ error: `Action execution failed: ${result.error}` }),
          { status: 500 }
        )
      }
    }

    // Audit the decision
    try {
      await supabase.from('audit_events').insert({
        workspace_id: action.workspace_id,
        actor_type: 'staff',
        actor_id: staff_id,
        action_type: decision === 'approve' ? 'proposed_action_approved' : 'proposed_action_rejected',
        target_type: 'proposed_action',
        target_id: proposed_action_id,
        metadata: { action_type: action.action_type, tier: action.tier },
      })
    } catch {
      // Non-blocking
    }

    return new Response(
      JSON.stringify({ success: true, action_id: proposed_action_id, decision }),
      { status: 200 }
    )
  } catch (err) {
    console.error('approve-action error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/approve-action/index.ts
git commit -m "feat(F-06): approve-action Edge Function — staff approve/reject with optimistic lock"
```

---

## Task 16: Learning Signal Record Utility

**Files:**
- Create: `src/lib/learning/record-signal.ts`
- Create: `src/lib/learning/record-signal.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/learning/record-signal.test.ts
import { describe, it, expect, vi } from 'vitest'
import { recordDraftEditSignal, determineStaffAction } from './record-signal'

describe('determineStaffAction', () => {
  it('should return sent_as_is when texts match', () => {
    expect(determineStaffAction('Hello world', 'Hello world')).toBe('sent_as_is')
  })

  it('should return edited_and_sent when texts differ', () => {
    expect(determineStaffAction('Hello world', 'Hello there')).toBe('edited_and_sent')
  })

  it('should return edited_and_sent for whitespace-only changes', () => {
    expect(determineStaffAction('Hello world', 'Hello world ')).toBe('edited_and_sent')
  })
})

describe('recordDraftEditSignal', () => {
  it('should return success:true on valid input', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockResolvedValue({ error: null }),
      }),
    }

    const result = await recordDraftEditSignal(mockSupabase as never, {
      workspaceId: '123',
      clientId: '456',
      draftId: '789',
      staffAction: 'sent_as_is',
      originalDraft: 'Hello',
      finalVersion: 'Hello',
      intentClassified: 'greeting',
      scenarioType: 'first_contact',
    })

    expect(result.success).toBe(true)
  })

  it('should substitute unclassified for null intentClassified', async () => {
    const insertFn = vi.fn().mockResolvedValue({ error: null })
    const mockSupabase = {
      from: vi.fn().mockReturnValue({ insert: insertFn }),
    }

    await recordDraftEditSignal(mockSupabase as never, {
      workspaceId: '123',
      clientId: '456',
      draftId: '789',
      staffAction: 'sent_as_is',
      originalDraft: 'Hello',
      finalVersion: 'Hello',
      intentClassified: '',
      scenarioType: '',
    })

    const insertArg = insertFn.mock.calls[0][0]
    expect(insertArg.intent_classified).toBe('unclassified')
    expect(insertArg.scenario_type).toBe('unclassified')
  })

  it('should return success:false on DB error without throwing', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockResolvedValue({ error: { message: 'DB error', code: '42000' } }),
      }),
    }

    const result = await recordDraftEditSignal(mockSupabase as never, {
      workspaceId: '123',
      clientId: '456',
      draftId: '789',
      staffAction: 'sent_as_is',
      originalDraft: 'Hello',
      finalVersion: 'Hello',
      intentClassified: 'greeting',
      scenarioType: 'first_contact',
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('DB error')
  })

  it('should never throw even on unexpected errors', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('Unexpected')
      }),
    }

    const result = await recordDraftEditSignal(mockSupabase as never, {
      workspaceId: '123',
      clientId: '456',
      draftId: '789',
      staffAction: 'discarded',
      originalDraft: 'Hello',
      finalVersion: null,
      intentClassified: 'greeting',
      scenarioType: 'general',
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('Unexpected')
  })

  it('should reject sent_as_is with null finalVersion', async () => {
    const result = await recordDraftEditSignal({} as never, {
      workspaceId: '123',
      clientId: '456',
      draftId: '789',
      staffAction: 'sent_as_is',
      originalDraft: 'Hello',
      finalVersion: null,
      intentClassified: 'greeting',
      scenarioType: 'general',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('finalVersion')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/lib/learning/record-signal.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the signal recorder**

```typescript
// src/lib/learning/record-signal.ts
import type { SupabaseClient } from '@supabase/supabase-js'

export type StaffAction = 'sent_as_is' | 'edited_and_sent' | 'regenerated' | 'discarded'

export interface DraftEditSignalInput {
  workspaceId: string
  clientId: string
  draftId: string
  staffAction: StaffAction
  originalDraft: string
  finalVersion: string | null
  intentClassified: string
  scenarioType: string
}

/**
 * Determine staff action by comparing original and sent text.
 * Whitespace-only changes classify as edited_and_sent.
 */
export function determineStaffAction(
  originalContent: string,
  sentText: string
): 'sent_as_is' | 'edited_and_sent' {
  return originalContent === sentText ? 'sent_as_is' : 'edited_and_sent'
}

/**
 * Record a draft edit signal. NEVER throws.
 * All errors are caught and returned as structured results.
 */
export async function recordDraftEditSignal(
  supabase: SupabaseClient,
  input: DraftEditSignalInput
): Promise<{ success: boolean; error?: string }> {
  try {
    // Validate: send actions require finalVersion
    if (
      (input.staffAction === 'sent_as_is' || input.staffAction === 'edited_and_sent') &&
      input.finalVersion === null
    ) {
      return { success: false, error: 'finalVersion is required for send actions' }
    }

    // Sentinel fallback for missing classifications
    const intentClassified = input.intentClassified?.trim() || 'unclassified'
    const scenarioType = input.scenarioType?.trim() || 'unclassified'

    if (intentClassified === 'unclassified' || scenarioType === 'unclassified') {
      console.warn('[learning] missing classification on signal write', {
        draftId: input.draftId,
        missingFields: [
          intentClassified === 'unclassified' ? 'intentClassified' : null,
          scenarioType === 'unclassified' ? 'scenarioType' : null,
        ].filter(Boolean),
      })
    }

    const { error } = await supabase.from('draft_edit_signals').insert({
      workspace_id: input.workspaceId,
      client_id: input.clientId,
      draft_id: input.draftId,
      staff_action: input.staffAction,
      original_draft: input.originalDraft,
      final_version: input.finalVersion,
      intent_classified: intentClassified,
      scenario_type: scenarioType,
    })

    if (error) {
      console.error('[learning] signal write failed', {
        draftId: input.draftId,
        action: input.staffAction,
        error: error.message,
        code: error.code,
      })
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[learning] signal write threw', {
      draftId: input.draftId,
      action: input.staffAction,
      error: message,
    })
    return { success: false, error: message }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/lib/learning/record-signal.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/learning/record-signal.ts src/lib/learning/record-signal.test.ts
git commit -m "feat(F-10): learning signal recorder — non-blocking, sentinel fallback, full test coverage"
```

---

## Task 17: Supabase Service Role Client for Server Actions

**Files:**
- Create: `src/lib/supabase/service.ts`

- [ ] **Step 1: Create service role client**

```typescript
// src/lib/supabase/service.ts
// Service role client for Next.js Server Actions that need to bypass RLS
// (e.g., writing draft_edit_signals, calling Baileys server)

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _serviceClient: SupabaseClient | null = null

export function getServiceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  _serviceClient = createClient(url, key)
  return _serviceClient
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/supabase/service.ts
git commit -m "feat: service role Supabase client for server actions"
```

---

## Task 18: Send/Discard/Regenerate Server Actions

**Files:**
- Create: `src/app/(dashboard)/inbox/[conversationId]/actions.ts`

- [ ] **Step 1: Create server actions file**

```typescript
// src/app/(dashboard)/inbox/[conversationId]/actions.ts
'use server'

import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { recordDraftEditSignal, determineStaffAction } from '@/lib/learning/record-signal'

// ─── Send Draft ─────────────────────────────────────────────────────────────

export async function sendDraftReply(
  draftId: string,
  finalText: string,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const serviceClient = getServiceClient()

  // 1. Fetch draft record
  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .select('id, content, intent_classified, scenario_type, conversation_id, workspace_id, client_id:conversations(client_id)')
    .eq('id', draftId)
    .single()

  if (draftError || !draft) {
    return { success: false, error: 'Draft not found' }
  }

  const workspaceId = draft.workspace_id
  const conversationId = draft.conversation_id
  // Get client_id from the conversation
  const { data: conv } = await supabase
    .from('conversations')
    .select('client_id')
    .eq('id', conversationId)
    .single()

  if (!conv) return { success: false, error: 'Conversation not found' }
  const clientId = conv.client_id

  // 2. INSERT outbound message
  const { error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      workspace_id: workspaceId,
      direction: 'outbound',
      content: finalText.trim(),
      sender_type: 'staff',
      delivery_status: 'sent',
      draft_id: draftId,
    })

  if (msgError) return { success: false, error: msgError.message }

  // 3. Record learning signal (non-blocking, fire-and-forget)
  const staffAction = determineStaffAction(draft.content, finalText)
  void recordDraftEditSignal(serviceClient, {
    workspaceId,
    clientId,
    draftId,
    staffAction,
    originalDraft: draft.content,
    finalVersion: finalText.trim(),
    intentClassified: draft.intent_classified ?? 'unclassified',
    scenarioType: draft.scenario_type ?? 'unclassified',
  }).catch(() => {})

  // 4. UPDATE draft status
  await supabase
    .from('drafts')
    .update({
      staff_action: staffAction,
      reviewed_at: new Date().toISOString(),
      reviewed_by: staffId,
      edited_content: staffAction === 'edited_and_sent' ? finalText.trim() : null,
    })
    .eq('id', draftId)

  // 5. POST to Baileys server: /send
  try {
    const baileysUrl = process.env.BAILEYS_SERVER_URL
    if (baileysUrl) {
      const { data: client } = await supabase
        .from('clients')
        .select('phone')
        .eq('id', clientId)
        .single()

      if (client) {
        await fetch(`${baileysUrl}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            to: client.phone,
            content: finalText.trim(),
          }),
        })
      }
    }
  } catch (err) {
    console.error('[send] Failed to dispatch via Baileys:', err)
    // Non-blocking: message is saved even if WhatsApp dispatch fails
  }

  // 6. Update conversation state
  await supabase
    .from('conversations')
    .update({ state: 'awaiting_client_reply' })
    .eq('id', conversationId)

  return { success: true }
}

// ─── Discard Draft ──────────────────────────────────────────────────────────

export async function discardDraft(
  draftId: string,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const serviceClient = getServiceClient()

  const { data: draft } = await supabase
    .from('drafts')
    .select('id, content, intent_classified, scenario_type, conversation_id, workspace_id')
    .eq('id', draftId)
    .single()

  if (!draft) return { success: false, error: 'Draft not found' }

  const { data: conv } = await supabase
    .from('conversations')
    .select('client_id')
    .eq('id', draft.conversation_id)
    .single()

  if (!conv) return { success: false, error: 'Conversation not found' }

  // Signal (non-blocking)
  void recordDraftEditSignal(serviceClient, {
    workspaceId: draft.workspace_id,
    clientId: conv.client_id,
    draftId,
    staffAction: 'discarded',
    originalDraft: draft.content,
    finalVersion: null,
    intentClassified: draft.intent_classified ?? 'unclassified',
    scenarioType: draft.scenario_type ?? 'unclassified',
  }).catch(() => {})

  // Update draft
  await supabase
    .from('drafts')
    .update({
      staff_action: 'discarded',
      reviewed_at: new Date().toISOString(),
      reviewed_by: staffId,
    })
    .eq('id', draftId)

  return { success: true }
}

// ─── Regenerate Draft ───────────────────────────────────────────────────────

export async function regenerateDraft(
  draftId: string,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const serviceClient = getServiceClient()

  const { data: draft } = await supabase
    .from('drafts')
    .select('id, content, intent_classified, scenario_type, conversation_id, workspace_id')
    .eq('id', draftId)
    .single()

  if (!draft) return { success: false, error: 'Draft not found' }

  const { data: conv } = await supabase
    .from('conversations')
    .select('client_id')
    .eq('id', draft.conversation_id)
    .single()

  if (!conv) return { success: false, error: 'Conversation not found' }

  // 1. Signal for superseded draft (non-blocking)
  void recordDraftEditSignal(serviceClient, {
    workspaceId: draft.workspace_id,
    clientId: conv.client_id,
    draftId,
    staffAction: 'regenerated',
    originalDraft: draft.content,
    finalVersion: null,
    intentClassified: draft.intent_classified ?? 'unclassified',
    scenarioType: draft.scenario_type ?? 'unclassified',
  }).catch(() => {})

  // 2. Update superseded draft
  await supabase
    .from('drafts')
    .update({
      staff_action: 'regenerated',
      reviewed_at: new Date().toISOString(),
      reviewed_by: staffId,
    })
    .eq('id', draftId)

  // 3. Re-enqueue to pgmq for new LLM call
  // Find the latest inbound message in this conversation
  const { data: latestMsg } = await supabase
    .from('messages')
    .select('id, content, media_type, wamid')
    .eq('conversation_id', draft.conversation_id)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (latestMsg) {
    await serviceClient.rpc('pgmq_send', {
      queue_name: 'inbound_messages',
      msg: {
        message_id: latestMsg.id,
        workspace_id: draft.workspace_id,
        client_id: conv.client_id,
        conversation_id: draft.conversation_id,
        phone: '', // Not needed for regeneration
        content: latestMsg.content,
        media_type: latestMsg.media_type,
        wamid: latestMsg.wamid,
      },
    })
  }

  return { success: true }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(dashboard\)/inbox/\[conversationId\]/actions.ts
git commit -m "feat(F-10): server actions — send, discard, regenerate with signal recording"
```

---

## Task 19: embed-knowledge Edge Function

**Files:**
- Create: `supabase/functions/embed-knowledge/index.ts`

- [ ] **Step 1: Create embed-knowledge Edge Function**

```typescript
// supabase/functions/embed-knowledge/index.ts
// Chunk text, generate embeddings, upsert to knowledge_chunks
// Called when workspace knowledge base is updated (F-01 onboarding or settings)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { generateEmbeddings } from '../_shared/embedding.ts'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    const { workspace_id, content, source } = await req.json()

    if (!workspace_id || !content || !source) {
      return new Response(
        JSON.stringify({ error: 'Missing workspace_id, content, or source' }),
        { status: 400 }
      )
    }

    const supabase = getSupabaseClient()

    // 1. Delete existing chunks for this source (re-embed on update)
    await supabase
      .from('knowledge_chunks')
      .delete()
      .eq('workspace_id', workspace_id)
      .eq('source', source)

    // 2. Chunk the content (simple paragraph-based chunking)
    const chunks = chunkText(content, 500) // ~500 chars per chunk

    if (chunks.length === 0) {
      return new Response(JSON.stringify({ chunks: 0 }), { status: 200 })
    }

    // 3. Generate embeddings for all chunks
    const embeddings = await generateEmbeddings(chunks)

    // 4. Upsert chunks with embeddings
    const rows = chunks.map((text, i) => ({
      workspace_id,
      content: text,
      source,
      source_ref: `chunk-${i + 1}`,
      embedding: JSON.stringify(embeddings[i]),
    }))

    const { error } = await supabase.from('knowledge_chunks').insert(rows)

    if (error) {
      console.error('[embed-knowledge] Insert failed:', error.message)
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    console.log(`[embed-knowledge] Embedded ${chunks.length} chunks for workspace ${workspace_id}`)

    return new Response(
      JSON.stringify({ chunks: chunks.length, source }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[embed-knowledge] Error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})

/**
 * Split text into chunks of approximately maxChars characters.
 * Splits on paragraph boundaries (\n\n), then sentence boundaries.
 */
function chunkText(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)
  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxChars) {
      current += (current ? '\n\n' : '') + para
    } else {
      if (current) chunks.push(current.trim())
      // If a single paragraph exceeds maxChars, split by sentences
      if (para.length > maxChars) {
        const sentences = para.split(/(?<=[.!?])\s+/)
        current = ''
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 <= maxChars) {
            current += (current ? ' ' : '') + sentence
          } else {
            if (current) chunks.push(current.trim())
            current = sentence
          }
        }
      } else {
        current = para
      }
    }
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/embed-knowledge/index.ts
git commit -m "feat: embed-knowledge Edge Function — chunk text, generate embeddings, upsert"
```

---

## Task 20: Update .env.local.example and ADR-005

**Files:**
- Modify: `.env.local.example`
- Modify: `docs/phase-3-architecture/adr/005-api-design.md`

- [ ] **Step 1: Update env example**

Add to `.env.local.example`:
```
# LLM (Sprint 2)
OPENROUTER_API_KEY=sk-or-...
OPENAI_API_KEY=sk-...
```

- [ ] **Step 2: Append ADR-005 amendment**

Append to `docs/phase-3-architecture/adr/005-api-design.md`:
```markdown

---

## Amendment: 2026-03-18 — OpenRouter replaces direct Anthropic SDK

**Decision:** LLM calls route through OpenRouter (https://openrouter.ai) using the OpenAI-compatible SDK, not the Anthropic SDK directly.

**Rationale:** Owner decision. OpenRouter provides model flexibility (switch between Claude, GPT, etc. by changing model string), unified billing, and automatic fallback. The OpenAI SDK is more broadly supported in Deno.

**Impact:** `supabase/functions/_shared/llm-client.ts` uses `openai` SDK with `baseURL: 'https://openrouter.ai/api/v1'`. Model IDs use OpenRouter format: `anthropic/claude-sonnet-4-20250514`. Env var: `OPENROUTER_API_KEY`.

**Migration path:** If OpenRouter is removed, replace `llm-client.ts` with direct Anthropic SDK (one-file change).
```

- [ ] **Step 3: Commit**

```bash
git add .env.local.example docs/phase-3-architecture/adr/005-api-design.md
git commit -m "docs: ADR-005 amendment — OpenRouter replaces direct Anthropic SDK"
```

---

## Task 21: Create DLQ Queue

**Files:**
- Modify: `supabase/migrations/20260318000004_sprint2.sql`

- [ ] **Step 1: Add DLQ queue creation to migration**

Add to the Sprint 2 migration:
```sql
-- Create DLQ for failed messages
SELECT pgmq.create('inbound_dlq');
```

- [ ] **Step 2: Commit** (amend migration if not yet applied, or create new migration)

---

## Tasks 22-28: F-01 Onboarding Wizard (Parallel Stream)

> **Note:** F-01 is an XL feature (13-18 days) that can develop in parallel with the AI pipeline. The full breakdown is below. These tasks are independent of Tasks 3-21 except for Task 1 (DB migration) and Task 19 (embed-knowledge).

### Task 22: Onboarding Layout + Step Indicator

**Files:**
- Create: `src/app/onboarding/layout.tsx`
- Create: `src/app/onboarding/page.tsx`
- Create: `src/components/onboarding/StepIndicator.tsx`

Implement a wizard shell with 6 steps: WhatsApp → Identity → Knowledge → SOPs → Tone → Summary. Use URL-based step progression. Each step stores progress to `workspaces.onboarding_status` (values: `pending`, `whatsapp_connected`, `identity_complete`, `knowledge_complete`, `sops_complete`, `tone_complete`, `active`).

### Task 23: WhatsApp Pairing Step

**Files:**
- Create: `src/app/onboarding/whatsapp/page.tsx`
- Create: `src/components/onboarding/QrCodeDisplay.tsx`
- Create: `src/hooks/use-whatsapp-pairing.ts`

Connect to existing Baileys server QR SSE endpoint. Display QR code with 30s refresh. On successful pairing, update `workspaces.whatsapp_connection_status = 'connected'` and advance to next step.

### Task 24: Business Identity Step

**Files:**
- Create: `src/app/onboarding/identity/page.tsx`

Form: business_name, vertical_type (select), timezone (select), business_hours (JSON editor), instagram_handle (optional). On submit, UPDATE workspaces row.

### Task 25: Knowledge Base Step

**Files:**
- Create: `src/app/onboarding/knowledge/page.tsx`
- Create: `src/components/onboarding/KnowledgeEditor.tsx`

If Instagram handle provided, call a knowledge generation endpoint (LLM call via OpenRouter to draft knowledge base from business description). Display markdown editor for manual editing. On save, update `workspaces.knowledge_base` and call `embed-knowledge` Edge Function (Task 19).

### Task 26: SOP Generation Step

**Files:**
- Create: `src/app/onboarding/sops/page.tsx`

Call LLM to generate vertical-specific SOPs based on business type and knowledge base. Display as editable cards. On save, update `workspaces.vertical_config.sopRules`.

### Task 27: Tone Profile Step

**Files:**
- Create: `src/app/onboarding/tone/page.tsx`
- Create: `src/components/onboarding/ToneProfileCard.tsx`

Call LLM to extract tone profile from knowledge base and business description. Display tone attributes with examples. Allow adjustment. On save, update `workspaces.tone_profile`.

### Task 28: Summary + Activation Step

**Files:**
- Create: `src/app/onboarding/summary/page.tsx`

Show summary of all configured items. "Activate" button sets `workspaces.onboarding_status = 'active'`. Redirects to dashboard.

---

## Task 29: Integration Verification

- [ ] **Step 1: Verify the full pipeline end-to-end**

Manual test flow:
1. Send a WhatsApp message to the connected number
2. Verify message appears in `messages` table
3. Verify pgmq enqueue
4. Trigger `process-message` Edge Function
5. Verify context assembly queries run
6. Verify LLM call returns a draft
7. Verify `drafts` row created with intent + confidence + scenario_type
8. Verify `proposed_actions` rows created for any write tools
9. Verify `llm_usage` row created with token counts and cost

- [ ] **Step 2: Verify signal recording**

1. Call `sendDraftReply` server action
2. Verify `draft_edit_signals` row created
3. Verify outbound message in `messages` table
4. Verify Baileys server `/send` called

- [ ] **Step 3: Verify approval flow**

1. Create a proposed_action with status=pending
2. Call `approve-action` with decision=approve
3. Verify domain write executed
4. Verify audit event created
5. Verify status=approved

---

## Task 30: Build Verification + Cleanup

- [ ] **Step 1: Build Next.js app**

Run: `npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 4: Final commit + PR**

```bash
git add -A
git commit -m "feat: Sprint 2 complete — AI pipeline, governance, signals, onboarding wizard"
```

---

## Sprint 2 Exit Criteria Checklist

- [ ] Inbound WhatsApp message produces an AI-drafted reply within 30 seconds
- [ ] Drafts include intent classification, confidence score, scenario_type, and knowledge source attribution
- [ ] Staff can approve, reject proposed actions via confirmation cards
- [ ] Three-tier trust model correctly routes actions (auto/review/human_only)
- [ ] Learning signals captured for every staff action on a draft (sent_as_is, edited_and_sent, regenerated, discarded)
- [ ] Full pipeline works end-to-end: message → client resolution → context assembly → AI draft → staff review → send
- [ ] Workspace onboarding wizard creates workspace with knowledge base, SOPs, and tone profile
- [ ] Knowledge base is embedded and searchable via pgvector
- [ ] LLM usage is logged with token counts and cost per invocation
