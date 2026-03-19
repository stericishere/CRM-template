# Feature Spec — F-05: Context Assembly & AI Draft Generation

**Feature:** F-05
**Phase:** 2 (AI Drafting & Booking)
**Size:** XL (2+ weeks)
**PRD Functions:** CS-02, CS-03, CS-04, AD-01, AD-02, AD-03, AD-04, AD-05, AD-06, AD-07
**User Stories:** F05-S01 through F05-S10
**Architecture modules:** `conversation` (GenerateReplyDraft, RegenerateDraft), `workspace-knowledge` (SearchKnowledge), `client-relationship` (AssembleClientContext), `agent/ClientWorkerRuntime`, `agent/ContextAssembler`
**ADR dependencies:** ADR-1 (single agent with tools), ADR-2 (context assembly is DB queries), ADR-3 (fixed token budget, no reactive compaction)
**Depends on:** F-02 (message pipeline -- messages exist in DB, pgmq queue operational), F-03 (client identity -- client find-or-create), F-01 (workspace onboarding -- workspace config, vertical config, knowledge base populated)
**Last updated:** March 2026

---

## Architecture alignment note

The canonical architecture (`docs/phase-3-architecture/architecture-final.md`) establishes context assembly and AI drafting as the core processing pipeline within the `process-message` Edge Function. This spec implements steps 7-13 of the inbound message pipeline (architecture-final.md SS 2.1).

Key canonical decisions this spec adheres to:

- **process-message Edge Function (Deno)** handles the entire pipeline: dequeue, normalize, find-or-create, context assembly, LLM call, tool loop, approval eval, save draft (architecture-final.md SS 3.2).
- **pgmq for queuing** -- messages are dequeued from pgmq with 60-second visibility timeout. Advisory locks via `pg_try_advisory_lock(hashtext(session_key))` serialize per-client processing.
- **Claude Sonnet 4 via OpenRouter** -- uses OpenAI-compatible SDK with `baseURL: 'https://openrouter.ai/api/v1'`. Model ID: `anthropic/claude-sonnet-4-20250514`. Single LLM call per inbound message. (Owner decision: OpenRouter for model flexibility and unified billing; ADR-005 amended.)
- **pgvector for knowledge search** with `text-embedding-3-small` (1536 dimensions, cosine similarity) (architecture-final.md SS 9.1).
- **Supabase Realtime** for dual notification pattern: `messages` INSERT fires immediately (staff sees message), `drafts` INSERT fires after LLM processing (staff sees draft) (architecture-final.md SS 2.1 steps 6 and 11).
- **Flat module structure** -- shared code in `supabase/functions/_shared/`, not DDD bounded contexts.
- **workspace_id denormalized** on `messages` and `drafts` tables for Realtime filtering.
- **~12K token context budget** with fixed per-section allocations and deterministic truncation (architecture-final.md SS 6.2).
- **Context assembly is a pure function** -- `assembleContext(workspaceId, clientId, inboundMessage) -> ReadOnlyContext`. The LLM cannot influence what data it receives.

---

## 1. Overview

F-05 is the core product feature. It transforms an inbound WhatsApp message into an AI-generated draft reply ready for staff review. The pipeline has four stages:

1. **Context assembly** -- deterministic, pure-function aggregation of workspace-level and client-level data into a fixed-budget context window.
2. **Knowledge retrieval** -- pgvector semantic search against the workspace knowledge base, executed as part of context assembly (before the LLM).
3. **Client Worker invocation** -- single LLM API call with tool-calling capability, producing intent classification, draft text, confidence score, and optional tool calls (ProposedActions).
4. **Draft persistence and notification** -- save the draft to the `drafts` table (triggering Realtime notification), handle escalation for low-confidence or human-only intents, support staff reprompting.

---

## 2. Component Breakdown

### 2.1 `process-message` Edge Function (`supabase/functions/process-message/index.ts`)

The orchestrator. This function is the entry point for all inbound message processing. F-05 owns steps 7-13 of the pipeline; steps 1-6 are covered by F-02 (message pipeline) and F-03 (client identity).

**F-05-relevant responsibilities (steps 7-13):**

```
Step 7:  assembleContext(workspaceId, clientId, inboundMessage) -> ReadOnlyContext
Step 8:  composeSystemPrompt(context.workspace, context.verticalConfig, context.communicationRules)
Step 9:  invokeClientWorker(systemPrompt, context, tools) -> { draft, toolCalls, intent, confidence }
Step 10: executeToolLoop(toolCalls, session, toolRegistry) -> { results, proposedActions }
Step 11: evaluateApprovalPolicy(proposedActions) -> routed actions (auto/review/human_only)
Step 12: saveDraft(conversationId, draft, intent, confidence, knowledgeSources)
Step 13: logLLMUsage(workspaceId, clientId, model, tokensIn, tokensOut, latencyMs, costUsd)
         archivePgmqMessage(msgId)
```

**Error boundaries:**

- Each step has try/catch wrapping. Failures at any step log the error, archive or leave the pgmq message for retry, and do not corrupt state.
- The function acquires `pg_try_advisory_lock(hashtext(session_key))` at the start. If the lock cannot be acquired (another worker has this client), the function returns early; the pgmq visibility timeout (60s) will make the message available again.
- Max 3 retries per message (tracked by pgmq `read_ct`). After 3 failures, the message is moved to `inbound_dlq`.

**Idempotency guard:**

Before running context assembly, check if a draft already exists for this specific inbound message using `drafts.source_message_id` (UUID FK to `messages.id`). Idempotency is **per-message, not per-conversation**: multiple client messages received before staff reviews each get their own draft. The guard query is:

```sql
SELECT id FROM drafts WHERE source_message_id = $messageId LIMIT 1;
```

If a row exists, skip processing. This prevents duplicate LLM calls on retry without blocking new messages from the same client.

### 2.2 Context assembler (`supabase/functions/_shared/context-assembly.ts`)

Pure function with no side effects. Returns a `ReadOnlyContext` object.

```typescript
export async function assembleContext(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string,
  inboundMessage: InboundMessage
): Promise<ReadOnlyContext> {
  // 1. Global sections (cacheable per workspace)
  const workspace = await loadWorkspaceConfig(supabase, workspaceId);
  const verticalConfig = workspace.vertical_config;
  const communicationRules = workspace.communication_profile?.rules ?? [];

  // 2. Knowledge search (workspace-scoped, query-dependent)
  const knowledgeChunks = await searchKnowledge(
    supabase, workspaceId, inboundMessage.content
  );

  // 3. Client-scoped sections (fresh per invocation)
  const client = await loadClientProfile(supabase, workspaceId, clientId);
  const compactSummary = await loadCompactSummary(supabase, workspaceId, clientId);
  const recentMessages = await loadRecentMessages(supabase, workspaceId, clientId, 10);
  const activeBookings = await loadActiveBookings(supabase, workspaceId, clientId, 5);
  const openFollowUps = await loadOpenFollowUps(supabase, workspaceId, clientId, 5);
  const recentNotes = await loadRecentNotes(supabase, workspaceId, clientId, 5);
  const conversationState = await loadConversationState(supabase, clientId);

  // 4. Apply token budgets and truncation
  return {
    sessionKey: `workspace:${workspaceId}:client:${clientId}`,
    workspace: truncateWorkspaceConfig(workspace),
    verticalConfig: truncateVerticalConfig(verticalConfig),
    communicationRules: truncateCommunicationRules(communicationRules),
    knowledgeChunks: truncateKnowledgeChunks(knowledgeChunks),
    client: truncateClientProfile(client),
    compactSummary: truncateCompactSummary(compactSummary),
    recentMessages: formatMessages(recentMessages),
    activeBookings: formatBookings(activeBookings),
    openFollowUps: formatFollowUps(openFollowUps),
    recentNotes: formatNotes(recentNotes),
    conversationState,
    inboundMessage,
  };
}
```

**Every database query includes `WHERE workspace_id = $1`.** Client-scoped queries add `AND client_id = $2`. No exceptions.

### 2.3 System prompt composer (`supabase/functions/_shared/system-prompt.ts`)

Composes the system prompt dynamically from workspace config at assembly time (not from a static file). The prompt instructs the Client Worker on its role, tone, behavior rules, intent taxonomy, output format, and tool usage.

```typescript
export function composeSystemPrompt(
  workspace: WorkspaceConfig,
  verticalConfig: VerticalConfig,
  communicationRules: CommunicationRule[]
): string {
  return `${ROLE_PREAMBLE}

## Business Identity
Business: ${workspace.businessName}
Timezone: ${workspace.timezone}
Business Hours: ${formatBusinessHours(workspace.businessHours)}

## Tone and Voice
${workspace.toneProfile}

## SOP Rules
${verticalConfig.sopRules.map(r => `- ${r}`).join('\n')}

## Custom Fields
${verticalConfig.customFields.map(f => `- ${f.name}: ${f.description}`).join('\n')}

## Appointment Types
${verticalConfig.appointmentTypes.map(t => `- ${t.name}: ${t.description}`).join('\n')}

${communicationRules.length > 0 ? `## Communication Rules (Learned)\n${communicationRules.map(r => `- ${r.rule}`).join('\n')}` : ''}

## Intent Classification
Classify every message into exactly one primary intent: ${INTENT_TAXONOMY.join(', ')}.
If multiple intents are present, classify the most actionable one as primary and note secondaries.
Report your confidence as a float between 0.0 and 1.0.

## Draft Generation Rules
- Write as the business, not as an AI assistant.
- Match the tone profile above.
- When knowledge base content is available, cite the source in your reasoning.
- When information is not available, acknowledge the gap honestly. Do not fabricate.
- Personalize using client context (preferences, lifecycle stage, history).

## Output Format
After processing, return:
1. Your intent classification and confidence score via the structured output.
2. Any tool calls needed (knowledge search, calendar, etc.).
3. Your draft reply text as the final assistant message.

${calendarDisabledNote(workspace)}`;
}
```

**ROLE_PREAMBLE** is a short static string defining the agent's role (customer service representative acting on behalf of the business). It does not change per workspace.

**INTENT_TAXONOMY** default set: `booking_inquiry`, `pricing_question`, `general_question`, `follow_up`, `greeting`, `complaint`, `cancellation`, `reschedule`, `out_of_scope`. Workspace-configurable via `verticalConfig.intentCategories` (optional override).

**Calendar disabled note:** If Google Calendar is not connected for the workspace, the system prompt includes: "Calendar is not connected. Do not offer to check availability or book appointments." (architecture-final.md SS 6.3).

### 2.4 Agent runtime (`supabase/functions/_shared/agent-runtime.ts`)

The Client Worker runtime: manages the LLM API call, structured output parsing, and the tool execution loop. Uses OpenRouter via OpenAI-compatible SDK.

```typescript
import { getLLMClient, DEFAULT_MODEL } from './llm-client.ts';

export async function invokeClientWorker(
  systemPrompt: string,
  context: ReadOnlyContext,
  toolRegistry: ToolRegistry,
  session: { workspaceId: string; clientId: string }
): Promise<ClientWorkerResult> {
  const client = getLLMClient();

  // Build the messages array
  const messages = buildConversationMessages(context);

  // First LLM call (OpenRouter, OpenAI-compatible format)
  let response = await client.chat.completions.create({
    model: DEFAULT_MODEL,  // 'anthropic/claude-sonnet-4-20250514'
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    tools: buildToolDefinitions(toolRegistry, session),
  });

  const allToolResults: ToolResult[] = [];
  const proposedActions: ProposedAction[] = [];
  let loopCount = 0;
  const MAX_TOOL_LOOPS = 5;

  // Tool execution loop
  while (response.choices[0]?.finish_reason === 'tool_calls' && loopCount < MAX_TOOL_LOOPS) {
    loopCount++;
    const toolCalls = response.choices[0].message.tool_calls ?? [];

    const toolResultMsgs = [];
    for (const toolCall of toolCalls) {
      const result = await executeToolCall({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments),
      }, session, toolRegistry);
      if (result.proposedAction) {
        proposedActions.push(result.proposedAction);
      }
      toolResultMsgs.push({
        role: 'tool' as const,
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.output),
      });
      allToolResults.push(result);
    }

    // Continue conversation with tool results
    messages.push(response.choices[0].message);
    messages.push(...toolResultMsgs);

    response = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      tools: buildToolDefinitions(toolRegistry, session),
    });
  }

  // Extract the final text response (the draft)
  const responseText = response.choices[0]?.message.content ?? '';
  const { intent, confidence, scenarioType, draftText } = parseAgentResponse(responseText);

  return {
    draft: draftText,
    intent,
    confidence,
    scenarioType,
    knowledgeSources: collectKnowledgeSources(allToolResults, context.knowledgeChunks),
    proposedActions,
    usage: {
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
    },
  };
}
```

**MAX_TOOL_LOOPS = 5** -- hard cap to prevent runaway tool calling. If the LLM is still requesting tools after 5 iterations, the loop stops and whatever text content exists is used as the draft. If no text content exists, the conversation is flagged for manual handling.

**Tool execution** is delegated to `executeToolCall()` in `_shared/tool-executor.ts` (shared with F-06). Read tools return results to the LLM. Write tools return `ProposedAction` objects (never commit directly).

### 2.5 LLM client (`supabase/functions/_shared/llm-client.ts`)

OpenRouter client using OpenAI-compatible SDK. Routes to Claude Sonnet 4 via OpenRouter for model flexibility and unified billing.

```typescript
import OpenAI from 'https://esm.sh/openai@4';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-20250514';

export function getLLMClient(): OpenAI {
  return new OpenAI({
    apiKey: Deno.env.get('OPENROUTER_API_KEY')!,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': Deno.env.get('SITE_URL') ?? 'https://crm-template.vercel.app',
      'X-Title': 'CRM Template',
    },
  });
}
```

Uses OpenAI SDK with OpenRouter's API endpoint. Model ID uses OpenRouter format (`anthropic/claude-sonnet-4-20250514`). The OpenAI SDK provides a stable interface; switching models is a one-line change.

### 2.6 Tool registry (`supabase/functions/_shared/tool-registry.ts`)

Defines all tools available to the Client Worker. Each tool has: name, description, Zod input schema, authority level, fixed params, and execute function.

```typescript
import { z } from 'zod';

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  knowledge_search: {
    name: 'knowledge_search',
    description: 'Search the workspace knowledge base for relevant information.',
    authority: 'read',
    schema: z.object({
      workspaceId: z.string().uuid(),
      query: z.string().min(1).max(500),
    }),
    fixedParams: {},
    execute: executeKnowledgeSearch,
  },

  calendar_query: {
    name: 'calendar_query',
    description: 'Query available appointment slots from Google Calendar.',
    authority: 'read',
    schema: z.object({
      workspaceId: z.string().uuid(),
      dateRange: z.object({
        start: z.string().datetime(),
        end: z.string().datetime(),
      }),
      appointmentType: z.string().optional(),
    }),
    fixedParams: {},
    execute: executeCalendarQuery,
  },

  calendar_book: {
    name: 'calendar_book',
    description: 'Propose a booking for a specific appointment type and start time.',
    authority: 'propose_write',
    schema: z.object({
      workspaceId: z.string().uuid(),
      clientId: z.string().uuid(),
      appointmentType: z.string(),   // key from verticalConfig.appointmentTypes
      startTime: z.string().datetime(),  // ISO 8601; end_time computed from durationMinutes at execution
      notes: z.string().optional(),
    }),
    fixedParams: {},
    execute: proposeCalendarBooking,
  },

  update_client: {
    name: 'update_client',
    description: 'Propose an update to the client record.',
    authority: 'propose_write',
    schema: z.object({
      workspaceId: z.string().uuid(),
      clientId: z.string().uuid(),
      changes: z.record(z.unknown()),
    }),
    fixedParams: {},
    execute: proposeClientUpdate,
  },

  create_note: {
    name: 'create_note',
    description: 'Create a note about this client interaction.',
    authority: 'auto_write',
    schema: z.object({
      workspaceId: z.string().uuid(),
      clientId: z.string().uuid(),
      content: z.string().min(1),
      type: z.enum(['observation', 'preference', 'context_update']),
      source: z.literal('ai_extracted'),
    }),
    fixedParams: { source: 'ai_extracted' },
    execute: executeCreateNote,
  },

  create_followup: {
    name: 'create_followup',
    description: 'Propose a follow-up task for this client.',
    authority: 'propose_write',
    schema: z.object({
      workspaceId: z.string().uuid(),
      clientId: z.string().uuid(),
      description: z.string().min(1),
      dueDate: z.string().optional(),
    }),
    fixedParams: {},
    execute: proposeFollowUpCreate,
  },
};
```

**Dynamic tool availability:** The `buildToolDefinitions()` function filters the registry before passing tools to the LLM. If Google Calendar is not connected for the workspace, `calendar_query` and `calendar_book` are excluded from the tool array sent to OpenRouter.

**Tool parameter injection:** Handled by `executeToolCall()` in `_shared/tool-executor.ts` (specified in F-06). `workspaceId` and `clientId` are always overwritten with session values.

### 2.7 Knowledge search module (`supabase/functions/_shared/knowledge-search.ts`)

Handles both pre-retrieval (during context assembly) and on-demand search (as a tool call during the tool loop).

```typescript
export async function searchKnowledge(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
  options: { topK?: number; minSimilarity?: number; tokenBudget?: number } = {}
): Promise<KnowledgeChunk[]> {
  const { topK = 5, minSimilarity = 0.7, tokenBudget = 2000 } = options;

  // 1. Generate embedding for the query
  const embedding = await generateEmbedding(query);

  // 2. Cosine similarity search, scoped to workspace
  const { data: chunks } = await supabase
    .rpc('search_knowledge_chunks', {
      query_embedding: embedding,
      match_workspace_id: workspaceId,
      match_count: topK,
      min_similarity: minSimilarity,
    });

  // 3. Apply token budget (include in descending similarity order until budget exceeded)
  return applyTokenBudget(chunks ?? [], tokenBudget);
}
```

**RPC function** (defined in migration):

```sql
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
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.source,
    kc.source_ref,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks kc
  WHERE kc.workspace_id = match_workspace_id
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

The `<=>` operator is pgvector's cosine distance operator. `1 - distance = similarity`. Results are filtered post-query by `min_similarity` threshold in application code (pgvector does not natively support a minimum similarity filter in the index scan, so filtering happens after retrieval).

### 2.8 Embedding generator (`supabase/functions/_shared/embedding.ts`)

Generates embeddings at query time using the same model as indexing (consistency requirement from F05-S03).

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY')! });

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    dimensions: 1536,
  });
  return response.data[0].embedding;
}
```

Uses OpenAI's embedding API directly (architecture-final.md SS 6.6). The same model and dimensions must be used for both indexing (F-09) and query-time search.

### 2.9 Draft persistence module (`supabase/functions/_shared/draft-persistence.ts`)

Saves the draft to the `drafts` table and updates conversation state atomically.

```typescript
export async function saveDraft(
  supabase: SupabaseClient,
  params: {
    conversationId: string;
    workspaceId: string;
    content: string;
    intentClassified: string;
    confidenceScore: number;
    knowledgeSources: string[];
  }
): Promise<{ draftId: string }> {
  // Single transaction: insert draft + update conversation state
  const { data: draft, error } = await supabase
    .from('drafts')
    .insert({
      conversation_id: params.conversationId,
      workspace_id: params.workspaceId,
      content: params.content,
      intent_classified: params.intentClassified,
      confidence_score: params.confidenceScore,
      knowledge_sources: params.knowledgeSources,
      staff_action: null,
      edited_content: null,
    })
    .select('id')
    .single();

  if (error) throw error;

  // Update conversation state to awaiting_staff_review
  await supabase
    .from('conversations')
    .update({
      state: 'awaiting_staff_review',
      last_message_at: new Date().toISOString(),
    })
    .eq('id', params.conversationId);

  // The drafts INSERT triggers Supabase Realtime -> staff sees "Draft ready"
  return { draftId: draft.id };
}
```

### 2.10 LLM usage logger (`supabase/functions/_shared/llm-usage.ts`)

Logs every LLM invocation to the `llm_usage` table for cost tracking (architecture-final.md SS 6.7).

```typescript
export async function logLLMUsage(
  supabase: SupabaseClient,
  params: {
    workspaceId: string;
    clientId: string | null;
    edgeFunctionName: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    costUsd: number;
  }
): Promise<void> {
  await supabase.from('llm_usage').insert(params);
}
```

Cost is calculated from model pricing constants defined in `_shared/llm-pricing.ts`:

```typescript
const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'claude-sonnet-4-20250514': { inputPer1M: 3.0, outputPer1M: 15.0 },
};

export function calculateCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (tokensIn / 1_000_000) * p.inputPer1M + (tokensOut / 1_000_000) * p.outputPer1M;
}
```

---

## 3. Data Model

### 3.1 Tables involved

F-05 reads from and writes to the following tables. All are defined in architecture-final.md SS 9.1.

| Table | F-05 access | Purpose |
|---|---|---|
| `workspaces` | READ | Workspace config, tone profile, vertical config, communication profile |
| `clients` | READ | Client profile, lifecycle status, preferences, tags |
| `conversations` | READ + WRITE | Conversation state, last message timestamp |
| `messages` | READ | Recent messages (last 10) for context assembly |
| `drafts` | WRITE | Draft text, intent, confidence, knowledge sources |
| `knowledge_chunks` | READ | pgvector semantic search for relevant business knowledge |
| `memories` | READ | Latest compact summary for the client |
| `bookings` | READ | Active bookings for context assembly |
| `follow_ups` | READ | Open follow-ups for context assembly |
| `notes` | READ + WRITE | Recent notes for context; AI-extracted notes from `create_note` tool |
| `proposed_actions` | WRITE | ProposedActions from write tools (routed to F-06 approval) |
| `llm_usage` | WRITE | LLM invocation cost tracking |
| `audit_events` | WRITE | Audit trail for escalations and auto-executed actions |

### 3.2 `drafts` table (canonical schema)

Already defined in architecture-final.md SS 9.1. Reproduced with F-05-specific notes:

```sql
CREATE TABLE drafts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID        NOT NULL REFERENCES conversations(id),
  workspace_id        UUID        NOT NULL REFERENCES workspaces(id),  -- denormalized for Realtime
  content             TEXT        NOT NULL,                             -- full draft reply text
  intent_classified   TEXT,                                             -- e.g., 'pricing_question'
  confidence_score    REAL,                                             -- 0.0 to 1.0
  knowledge_sources   TEXT[],                                           -- source references, e.g., ['Pricing Guide.pdf - Two-Piece Suits']
  staff_action        TEXT,                                             -- NULL on creation; set by F-06/F-10
  edited_content      TEXT,                                             -- NULL on creation; set by staff edit
  reprompt_of         UUID        REFERENCES drafts(id),               -- NULL if original; FK to prior draft if regenerated
  staff_instruction   TEXT,                                             -- NULL if original; the reprompt instruction text
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at         TIMESTAMPTZ,
  reviewed_by         UUID        REFERENCES staff(id)
);

CREATE INDEX idx_drafts_workspace ON drafts(workspace_id, created_at DESC);
CREATE INDEX idx_drafts_conversation ON drafts(conversation_id, created_at DESC);
```

**Additions beyond architecture-final.md SS 9:**
- `reprompt_of` -- links a regenerated draft to the previous draft it replaced. Enables the audit trail for sequential reprompts.
- `staff_instruction` -- stores the staff's reprompt instruction text (e.g., "make it shorter"). NULL for original drafts.

### 3.3 `ReadOnlyContext` type (canonical from architecture-final.md SS 6.2)

**Sprint 2 implementation:** `ReadOnlyContext` is split into `GlobalContext` (workspace-level, cacheable) and `MessageContext` (per-client, per-message). The LLM call receives `ReadOnlyContext = GlobalContext & MessageContext`.

```typescript
// GlobalContext — workspace-level, safe to cache per workspace
interface GlobalContext {
  identity: {
    businessName: string;
    vertical: string;
    description: string;
    toneProfile: string;
  };
  agent: {
    sopRules: string[];
    intentTaxonomy: string[];
    customFields: CustomFieldDef[];
    appointmentTypes: AppointmentTypeDef[];
  };
  tools: {
    calendarConnected: boolean;
    knowledgeBaseEnabled: boolean;
  };
  businessContext: {
    timezone: string;
    businessHours: Record<string, { open: string; close: string }>;
    scheduledReminder: {
      enabled: boolean;
      daysBefore: number;  // default: 1
    };
  };
  memory: {
    communicationRules: CommunicationRule[];  // learned from edit loop, empty initially
  };
  heartbeat: {
    workspaceId: string;
    status: string;
  };
}

// MessageContext — per-client, per-message, assembled fresh on every invocation
interface MessageContext {
  sessionKey: string;  // 'workspace:{id}:client:{id}'
  knowledgeChunks: KnowledgeChunk[];  // top-K semantic search results
  client: {
    id: string;
    name: string;
    phone: string;
    lifecycleStatus: string;
    tags: string[];
    preferences: Record<string, unknown>;
    lastContactedAt: string;
  };
  compactSummary: string | null;
  recentMessages: Array<{
    direction: 'inbound' | 'outbound';
    content: string;
    timestamp: string;
    senderType: 'client' | 'staff';
  }>;
  activeBookings: Array<{
    appointmentType: string;
    startTime: string;
    status: string;
    confirmationStatus: string;
  }>;
  openFollowUps: Array<{
    content: string;
    dueDate: string | null;
    status: string;
  }>;
  recentNotes: Array<{
    content: string;
    source: string;
    createdAt: string;
  }>;
  conversationState: string;
  inboundMessage: {
    content: string;
    mediaType: string | null;
    mediaTranscription: string | null;
    timestamp: string;
  };
}

// ReadOnlyContext is the union passed to the LLM.
type ReadOnlyContext = GlobalContext & MessageContext;
```

**Agent system prompt templates** are Markdown files at `src/app/api/workspaces/agent/`:
- `IDENTITY.md`, `AGENT.md`, `TOOLS.md`, `BUSINESS.md`, `MEMORY.md`, `HEARTBEAT.md`, `OUTPUT.md`

Builder modules in `global-context/` at project root populate `GlobalContext` from the database.

### 3.4 `ClientWorkerResult` type

```typescript
type ClientWorkerResult = {
  draft: string;                       // the generated reply text
  intent: string;                      // classified intent label
  confidence: number;                  // 0.0 to 1.0
  knowledgeSources: string[];          // source attributions used
  proposedActions: ProposedAction[];   // write tool outputs
  usage: {
    tokensIn: number;
    tokensOut: number;
  };
};
```

### 3.5 `KnowledgeChunk` type

```typescript
type KnowledgeChunk = {
  id: string;
  content: string;
  source: string;          // e.g., 'manual_upload'
  sourceRef: string;       // e.g., 'Pricing Guide 2026.pdf'
  similarity: number;      // cosine similarity score (0.0 to 1.0)
};
```

---

## 4. Context Assembly

### 4.1 Assembly order and per-section token budgets

Context is assembled in a fixed order. Each section has a deterministic token budget and truncation strategy. The total budget is approximately 12,000 tokens (excluding the inbound message).

| # | Section | Source | Budget | Truncation strategy | Query scope |
|---|---------|--------|--------|---------------------|-------------|
| 1 | System prompt + tone | Static template + workspace config | ~1,500 | None (fixed) | `workspaces WHERE id = $1` |
| 2 | Tool definitions | Static registry | ~800 | None (fixed) | N/A (code) |
| 3 | Vertical config / SOP | `workspaces.vertical_config` | ~500 | None (workspace-authored) | `workspaces WHERE id = $1` |
| 4 | Communication rules | `workspaces.communication_profile` | ~500 | Omit if empty; cap at 20 rules | `workspaces WHERE id = $1` |
| 5 | Knowledge chunks | pgvector search on `knowledge_chunks` | ~2,000 | Top-K by similarity score | `knowledge_chunks WHERE workspace_id = $1` |
| 6 | Client profile | `clients` | ~500 | Trim oldest tags if > 20 | `clients WHERE workspace_id = $1 AND id = $2` |
| 7 | Compact summary | `memories` (type = `compact_summary`) | ~2,000 | Truncate from the start (oldest sections) | `memories WHERE workspace_id = $1 AND client_id = $2` |
| 8 | Active items | `bookings` + `follow_ups` + `notes` | ~1,000 | Cap 5 per category, most recent first | `WHERE workspace_id = $1 AND client_id = $2` |
| 9 | Conversation state | `conversations.state` | ~100 | None (single enum) | `conversations WHERE client_id = $2` |
| 10 | Recent messages | `messages` | ~3,000 | Hard cap at 10, chronological order | `messages WHERE conversation_id = $conv ORDER BY created_at DESC LIMIT 10` |
| 11 | Inbound message | From pgmq payload | Variable | Hard truncation at 2,000 chars | N/A (from queue) |

**Total:** ~12,400 tokens maximum. This is a target, not a hard wall. Slight overages (12,200-12,500) are acceptable.

### 4.2 `assembleContext()` implementation details

**Global sections (rows 1-4):**
- Loaded from a single `workspaces` row query.
- These sections are identical across all clients in the same workspace.
- **Caching opportunity:** Global sections change rarely (only on settings update). A per-workspace in-memory cache with 5-minute TTL is safe. For MVP, fresh query every invocation is acceptable (single DB round trip).

**Knowledge chunks (row 5):**
- Executed as part of context assembly, before the LLM (F05-S03).
- Uses the inbound message text as the search query.
- Returns top-K chunks (default K=5) ranked by cosine similarity.
- Chunks are added in descending similarity order until the ~2,000 token budget would be exceeded.
- If zero chunks meet the minimum similarity threshold (default 0.7), the section is empty but present (no error).
- Each chunk includes source attribution (`sourceRef` field).

**Client-scoped sections (rows 6-10):**
- Assembled fresh every invocation. No caching.
- All queries are scoped by `workspace_id` AND `client_id`.
- For new clients: compact summary is null, active items are empty, notes are empty. The context window is well under budget. No errors.

**Inbound message (row 11):**
- Client message text is hard-truncated to 2,000 characters (architecture-final.md SS 5.5).
- Media transcriptions (voice notes) replace or supplement the text content.

### 4.3 Token counting

Token counting uses a simple word-based approximation (1 token ~ 4 characters). Exact token counts are not critical -- the budget is a cost and latency target, not a hard wall (ADR-3).

```typescript
export function estimateTokens(text: string): number {
  // Rough approximation: 1 token ≈ 4 characters for English text
  return Math.ceil(text.length / 4);
}

export function applyTokenBudget<T extends { content: string }>(
  items: T[],
  budget: number
): T[] {
  const result: T[] = [];
  let used = 0;
  for (const item of items) {
    const tokens = estimateTokens(item.content);
    if (used + tokens > budget) break;
    result.push(item);
    used += tokens;
  }
  return result;
}
```

### 4.4 Cross-client isolation enforcement

Every query function in context assembly enforces isolation:

```typescript
async function loadClientProfile(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string
): Promise<Client> {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', clientId)
    .is('deleted_at', null)
    .single();

  if (error || !data) throw new Error(`Client not found: ${clientId}`);
  return data;
}
```

This pattern repeats for every client-scoped loader. The `workspace_id` filter is redundant with RLS (since Edge Functions use the service role key which bypasses RLS) but is included as defense-in-depth per architecture-final.md SS 5.1 Layer 4.

---

## 5. LLM Integration

### 5.1 OpenRouter setup

```typescript
import OpenAI from 'https://esm.sh/openai@4';

// Models from environment variables
const PRO_MODEL = Deno.env.get('PRO_MODEL')!;       // drafting, tool-calling
const FLASH_MODEL = Deno.env.get('FLASH_MODEL')!;   // compaction, cheap tasks
const EMBEDDING_MODEL = Deno.env.get('EMBEDDING_MODEL')!;

const client = new OpenAI({
  apiKey: Deno.env.get('OPENROUTER_API_KEY')!,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': Deno.env.get('SITE_URL') ?? 'https://crm-template.vercel.app',
    'X-Title': 'CRM Template',
  },
});
```

**Deno import:** Uses `esm.sh` for OpenAI SDK. OpenRouter uses OpenAI-compatible API.

**Models from env:** `PRO_MODEL` for Client Worker drafting, `FLASH_MODEL` for compaction, `SMALL_MODEL` for lightweight tasks, `EMBEDDING_MODEL` for embeddings. All go through OpenRouter — including embeddings (not direct OpenAI). Allows model switching without code changes.

### 5.2 System prompt composition

The system prompt is injected as the first message with `role: 'system'` in the OpenAI-compatible API call. It is composed dynamically per invocation from workspace config (SS 2.3 above).

### 5.3 User message construction

The assembled context is formatted into a single user message. The structure separates global and client sections with clear delimiters:

```typescript
function buildConversationMessages(context: ReadOnlyContext): Message[] {
  const contextBlock = `
<client_profile>
Name: ${context.client.name}
Phone: ${context.client.phone}
Status: ${context.client.lifecycleStatus}
Tags: ${context.client.tags.join(', ')}
Preferences: ${JSON.stringify(context.client.preferences)}
</client_profile>

${context.compactSummary ? `<conversation_history_summary>\n${context.compactSummary}\n</conversation_history_summary>` : ''}

<active_items>
Bookings: ${formatBookingsForPrompt(context.activeBookings)}
Follow-ups: ${formatFollowUpsForPrompt(context.openFollowUps)}
Notes: ${formatNotesForPrompt(context.recentNotes)}
</active_items>

<conversation_state>${context.conversationState}</conversation_state>

<knowledge_base>
${context.knowledgeChunks.map(c => `[Source: ${c.sourceRef}]\n${c.content}`).join('\n\n')}
</knowledge_base>

<recent_messages>
${context.recentMessages.map(m => `[${m.timestamp}] ${m.senderType}: ${m.content}`).join('\n')}
</recent_messages>

<new_message>
${context.inboundMessage.content}
${context.inboundMessage.mediaTranscription ? `[Voice note transcription]: ${context.inboundMessage.mediaTranscription}` : ''}
</new_message>`;

  return [{ role: 'user', content: contextBlock }];
}
```

**Prompt injection mitigation:** Client-provided content (messages, name) is placed in the user turn with explicit XML delimiters, never in the system prompt. The system prompt contains only workspace-authored content (architecture-final.md SS 5.5).

### 5.4 Tool definitions (OpenAI-compatible format)

Tools are converted from the internal registry to OpenAI-compatible tool definition format (used by OpenRouter):

```typescript
function buildToolDefinitions(
  registry: ToolRegistry,
  session: { workspaceId: string }
): OpenAI.Chat.ChatCompletionTool[] {
  const tools: OpenAI.Chat.ChatCompletionTool[] = [];

  for (const [name, tool] of Object.entries(registry)) {
    // Filter out calendar tools if not connected
    if ((name === 'calendar_query' || name === 'calendar_book') &&
        !isCalendarConnected(session.workspaceId)) {
      continue;
    }

    tools.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.schema),
      },
    });
  }

  return tools;
}
```

The `zodToJsonSchema()` utility converts Zod schemas to JSON Schema format. The `workspaceId` and `clientId` fields are included in the schema but are always overwritten by runtime injection (the LLM does not need to know this).

### 5.5 Tool execution loop

The loop runs after each LLM response that contains `tool_use` blocks:

1. Extract all `tool_use` blocks from the response.
2. For each tool call:
   a. Look up the tool in the registry. Reject unknown tools.
   b. Inject session-scoped `workspaceId` and `clientId` (overwriting any LLM-provided values).
   c. Apply per-tool fixed params (e.g., `source: 'ai_extracted'` for `create_note`).
   d. Validate merged params against Zod schema. On failure, return validation error to LLM.
   e. Execute the tool:
      - **Read tools** (`knowledge_search`, `calendar_query`): execute immediately, return result.
      - **Auto-write tools** (`create_note`): execute immediately, log audit event.
      - **Propose-write tools** (`calendar_book`, `update_client`, `create_followup`): wrap in `ProposedAction`, do not execute.
3. Append assistant message + tool results to conversation history.
4. Make another LLM call with the updated history.
5. Repeat until the LLM returns a text response (the draft) or MAX_TOOL_LOOPS (5) is reached.

### 5.6 Structured output extraction

The Client Worker outputs intent classification and confidence as structured metadata. This is extracted from the LLM response via a combination of:

1. **Tool-based approach (preferred):** Define a `classify_and_draft` tool that the LLM must call as its final action, returning `{ intent, confidence, draft_text }`. This guarantees structured output.

2. **Fallback parsing:** If the LLM returns plain text without calling the classification tool, parse intent and confidence from the response using regex or default to `{ intent: 'general_question', confidence: 0.5 }`.

```typescript
function extractStructuredOutput(response: OpenAI.Chat.ChatCompletion): {
  intent_classified: string;
  confidence_score: number;
} {
  // Look for the classify_and_draft tool call in tool_calls
  const toolCalls = response.choices[0]?.message.tool_calls ?? [];
  const classifyCall = toolCalls.find(tc => tc.function.name === 'classify_and_draft');

  if (classifyCall) {
    const args = JSON.parse(classifyCall.function.arguments);
    return {
      intent_classified: args.intent,
      confidence_score: args.confidence,
    };
  }

  // Fallback: parse from response text or default
  return {
    intent_classified: 'general_question',
    confidence_score: 0.5,
  };
}
```

---

## 6. Knowledge Search

### 6.1 Pre-retrieval (during context assembly)

Runs as step 7 of the pipeline, before the LLM is invoked. Uses the inbound message text as the query.

**Flow:**
1. Generate embedding for the inbound message text via OpenAI `text-embedding-3-small`.
2. Execute pgvector cosine similarity search against `knowledge_chunks` WHERE `workspace_id = $1`.
3. Retrieve top-K results (default K=5).
4. Filter by minimum similarity threshold (default 0.7) in application code.
5. Apply token budget: include chunks in descending similarity order until ~2,000 tokens would be exceeded.
6. Include source attribution (`source`, `source_ref`) for each chunk.

**No matches:** If zero chunks meet the threshold, the knowledge section in the context is empty. The LLM proceeds without pre-loaded knowledge. This is not an error.

### 6.2 On-demand search (tool call during tool loop)

The `knowledge_search` tool in the Client Worker's inventory allows the LLM to perform additional searches if the pre-loaded chunks are insufficient.

```typescript
async function executeKnowledgeSearch(
  params: { workspaceId: string; query: string }
): Promise<ToolResult> {
  const chunks = await searchKnowledge(supabase, params.workspaceId, params.query, {
    topK: 3,           // fewer results for tool calls (already have pre-loaded)
    minSimilarity: 0.65,
    tokenBudget: 1000, // smaller budget for supplementary search
  });

  return {
    output: chunks.map(c => ({
      content: c.content,
      source: `${c.sourceRef}`,
      similarity: c.similarity,
    })),
  };
}
```

### 6.3 Knowledge source attribution collection

After the Client Worker completes, knowledge sources are collected from two places:

1. **Pre-retrieved chunks** that were included in the context (from `context.knowledgeChunks`).
2. **Tool call results** from any `knowledge_search` invocations during the tool loop.

```typescript
function collectKnowledgeSources(
  toolResults: ToolResult[],
  preRetrievedChunks: KnowledgeChunk[]
): string[] {
  const sources = new Set<string>();

  // From pre-retrieved chunks
  for (const chunk of preRetrievedChunks) {
    if (chunk.sourceRef) sources.add(chunk.sourceRef);
  }

  // From tool call results
  for (const result of toolResults) {
    if (result.toolName === 'knowledge_search' && result.output) {
      for (const chunk of result.output) {
        if (chunk.source) sources.add(chunk.source);
      }
    }
  }

  return Array.from(sources);
}
```

The collected sources are stored in `drafts.knowledge_sources` as a text array.

---

## 7. Draft Save & Notifications

### 7.1 Draft persistence

After the Client Worker completes:

1. **If confidence >= threshold AND intent is not human-only:**
   - Insert a row into `drafts` with content, intent, confidence, knowledge sources.
   - Update `conversations.state` to `awaiting_staff_review`.
   - The `drafts` INSERT triggers Supabase Realtime -- staff sees "Draft ready" notification.

2. **If confidence < threshold OR intent is human-only:**
   - No draft is created.
   - The conversation is flagged for manual handling (SS 7.3 below).

### 7.2 Confidence scoring

The confidence score is a float between 0.0 and 1.0, produced by the Client Worker LLM as part of its structured output. The threshold is workspace-configurable with a default of 0.4.

```typescript
const DEFAULT_CONFIDENCE_THRESHOLD = 0.4;

function getConfidenceThreshold(workspace: WorkspaceConfig): number {
  return workspace.confidence_threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
}
```

**Confidence semantics (guidance to the LLM via system prompt):**
- 0.9-1.0: High confidence. Clear intent, knowledge available, straightforward reply.
- 0.6-0.9: Moderate confidence. Intent clear but reply may need staff adjustment.
- 0.4-0.6: Low-moderate confidence. Ambiguous intent or insufficient knowledge.
- 0.0-0.4: Low confidence. Unclear intent, no relevant knowledge, or sensitive topic.

### 7.3 Escalation logic

Escalation is evaluated in two places (consistent with F-06):

**Intent-level gate (evaluated first, in process-message):**
```typescript
if (isHumanOnlyIntent(result.intent, MVP_APPROVAL_POLICY)) {
  await flagForManualHandling(supabase, conversationId, workspaceId, result.intent);
  // No draft saved. Return early.
  return;
}
```

**Confidence gate (evaluated second):**
```typescript
if (result.confidence < getConfidenceThreshold(workspace)) {
  await flagForManualHandling(supabase, conversationId, workspaceId, result.intent);
  // No draft saved. Return early.
  return;
}
```

**`flagForManualHandling()` implementation:**

```typescript
async function flagForManualHandling(
  supabase: SupabaseClient,
  conversationId: string,
  workspaceId: string,
  intent: string
): Promise<void> {
  // Update conversation state
  await supabase
    .from('conversations')
    .update({
      state: 'awaiting_staff_review',
      manual_handling_required: true,
    })
    .eq('id', conversationId);

  // Write audit event
  await supabase.from('audit_events').insert({
    workspace_id: workspaceId,
    actor_type: 'system',
    action_type: 'escalation_flagged',
    target_type: 'conversation',
    target_id: conversationId,
    metadata: { intent_category: intent, reason: 'human_only_or_low_confidence' },
  });
}
```

The conversation moves to `awaiting_staff_review` but without a draft attached. Staff sees the inbound message, the intent classification, and the escalation flag. The assembled context (profile, summary, messages) remains accessible via the client thread page.

### 7.4 Notification flow

Notifications use Supabase Realtime Postgres Changes (architecture-final.md SS 14). No additional infrastructure.

| Event | Table | Filter | Staff sees |
|---|---|---|---|
| Inbound message received (F-02) | `messages` INSERT | `workspace_id = eq.{wid}` AND `direction = inbound` | "New message from [Client]" (< 1s) |
| Draft ready (F-05) | `drafts` INSERT | `workspace_id = eq.{wid}` | "Draft reply ready for [Client]" (~5-15s after message) |
| Escalation (F-05) | `conversations` UPDATE | `workspace_id = eq.{wid}` | "Needs manual attention: [Client]" |

The staff app's existing `useRealtimeInbox` hook (from F-04) subscribes to these events. F-05 adds the `drafts` INSERT subscription:

```typescript
.on('postgres_changes', {
  event: 'INSERT',
  schema: 'public',
  table: 'drafts',
  filter: `workspace_id=eq.${workspaceId}`,
}, handleDraftReady)
```

---

## 8. Reprompt / Regeneration

### 8.1 Staff reprompt flow

When staff provides a reprompt instruction (e.g., "make it shorter"), the system:

1. Marks the current draft's `staff_action` as `'regenerated'`.
2. Reassembles context fresh (captures any state changes since the original draft).
3. Builds a new LLM conversation that includes:
   - The same system prompt (recomposed from current workspace config).
   - The same context sections (freshly assembled).
   - The previous draft as an assistant message.
   - The staff instruction as a new user message.
4. Makes a new LLM API call.
5. Saves a new draft with `reprompt_of` pointing to the previous draft.

### 8.2 Reprompt API endpoint

Reprompting is triggered from the staff app via a Next.js API route that invokes the `process-message` Edge Function with a reprompt payload:

```typescript
// POST /api/conversations/[conversationId]/reprompt
// Body: { instruction: string, currentDraftId: string }

// Edge Function receives:
type RepromptPayload = {
  type: 'reprompt';
  conversationId: string;
  workspaceId: string;
  clientId: string;
  currentDraftId: string;
  instruction: string;
};
```

### 8.3 Reprompt implementation

```typescript
async function handleReprompt(
  supabase: SupabaseClient,
  payload: RepromptPayload
): Promise<void> {
  const { conversationId, workspaceId, clientId, currentDraftId, instruction } = payload;

  // 1. Rate limit check: max 5 reprompts per conversation per hour
  const recentReprompts = await countRecentReprompts(supabase, conversationId, 60);
  if (recentReprompts >= 5) {
    throw new Error('Reprompt rate limit exceeded (5/hour). Please try again later.');
  }

  // 2. Load the current draft
  const currentDraft = await loadDraft(supabase, currentDraftId);

  // 3. Mark current draft as regenerated
  await supabase
    .from('drafts')
    .update({ staff_action: 'regenerated' })
    .eq('id', currentDraftId);

  // 4. Fresh context assembly
  const inboundMessage = await loadOriginalInboundMessage(supabase, conversationId);
  const context = await assembleContext(supabase, workspaceId, clientId, inboundMessage);

  // 5. Build reprompt conversation
  const systemPrompt = composeSystemPrompt(
    context.workspace, context.verticalConfig, context.communicationRules
  );
  const messages = buildConversationMessages(context);

  // Append previous draft as assistant response
  messages.push({ role: 'assistant', content: currentDraft.content });

  // Append staff instruction as user message
  messages.push({ role: 'user', content: `Staff instruction: ${instruction}` });

  // 6. New LLM call
  const result = await invokeClientWorkerWithMessages(systemPrompt, messages, toolRegistry, {
    workspaceId, clientId,
  });

  // 7. Save new draft
  await saveDraft(supabase, {
    conversationId,
    workspaceId,
    content: result.draft,
    intentClassified: result.intent,
    confidenceScore: result.confidence,
    knowledgeSources: result.knowledgeSources,
    repromptOf: currentDraftId,
    staffInstruction: instruction,
  });

  // 8. Log LLM usage
  await logLLMUsage(supabase, {
    workspaceId,
    clientId,
    edgeFunctionName: 'process-message',
    model: 'claude-sonnet-4-20250514',
    tokensIn: result.usage.tokensIn,
    tokensOut: result.usage.tokensOut,
    latencyMs: result.usage.latencyMs,
    costUsd: calculateCost('claude-sonnet-4-20250514', result.usage.tokensIn, result.usage.tokensOut),
  });
}
```

### 8.4 Rate limiting

Max 5 reprompts per conversation per hour (architecture-final.md SS 5.4). Tracked by querying the `drafts` table:

```typescript
async function countRecentReprompts(
  supabase: SupabaseClient,
  conversationId: string,
  windowMinutes: number
): Promise<number> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('drafts')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .not('reprompt_of', 'is', null)
    .gte('created_at', since);
  return count ?? 0;
}
```

Staff receives a 429 error with a clear message if the limit is exceeded.

### 8.5 Sequential reprompts

Multiple sequential reprompts are supported. Each produces a new draft referencing the previous one via `reprompt_of`. The chain is preserved for audit:

```
draft-001 (original) -> staff_action: 'regenerated'
  |
  v
draft-002 (reprompt 1, reprompt_of: draft-001) -> staff_action: 'regenerated'
  |
  v
draft-003 (reprompt 2, reprompt_of: draft-002) -> staff_action: null (active)
```

### 8.6 Reprompt with escalation checks

Regenerated drafts go through the same confidence and escalation checks as original drafts. If the new draft falls below the confidence threshold, the escalation flag is re-raised.

---

## 9. Edge Cases

### 9.1 Edge Function timeout (150s limit)

The Supabase Edge Function has a 150-second timeout (Pro tier). The LLM call typically takes 5-15 seconds, but can be longer for complex tool loops.

**Mitigation:**
1. The pgmq visibility timeout (60s) expires before the Edge Function timeout. If the function is still running, it completes normally.
2. If the function truly times out (> 150s), the pgmq message becomes visible again after the visibility timeout. The pg_cron safety net re-triggers processing.
3. Context assembly is idempotent. Re-running is safe.
4. The idempotency guard (SS 2.1) checks if a draft already exists for this message. If the LLM completed but the draft save failed, a retry produces a new LLM call (wasted cost, not data corruption).
5. The tool loop cap (MAX_TOOL_LOOPS = 5) bounds the worst case for LLM call chains.

**Latency budget:**
- Context assembly: ~200ms (parallel DB queries)
- Embedding generation: ~100ms
- Knowledge search: ~100ms
- LLM call + tool loop: ~5-30s (depending on tool iterations)
- Draft save + audit: ~100ms
- LLM usage log: ~50ms
- **Total typical:** 6-31 seconds. Well within 150s.

### 9.2 LLM API errors

If the OpenRouter API returns an error (rate limit, server error, invalid request):

1. Log the error with full context (workspace, client, model, error code).
2. Do not save a draft. Do not flag as escalated.
3. Let the pgmq visibility timeout expire. The message will be retried.
4. After 3 retries (`read_ct > 3`), move to dead letter queue (`inbound_dlq`).
5. Staff is notified that a message could not be processed (via a system message in the conversation).

### 9.3 Tool execution errors

If a tool call fails during the loop (e.g., `calendar_query` fails because Google Calendar is unreachable):

1. Return an error result to the LLM: `{ error: "Calendar service unavailable" }`.
2. The LLM receives the error and can adjust its draft (e.g., "I'll check availability and get back to you").
3. Processing continues. The failed tool does not crash the entire pipeline.
4. If the error is a Zod validation failure, the LLM receives the validation error and can retry with corrected params.

### 9.4 Empty context (new client, no history)

A brand-new client with no messages, no summary, no bookings, no notes.

**Behavior:**
- Compact summary is null -- section omitted.
- Recent messages contain only the current inbound message.
- Active items sections are empty.
- Notes section is empty.
- The Client Worker receives the workspace config, knowledge base, and the inbound message.
- Total context is well under 12K tokens. No errors.
- The draft is generated normally, relying on knowledge base content and workspace tone.

### 9.5 No knowledge matches

The inbound message has no semantic match in the knowledge base (e.g., "What's the weather?").

**Behavior:**
- Knowledge chunks section is empty but present in the context.
- The system prompt instructs the LLM: "When information is not available, acknowledge the gap honestly."
- The LLM generates a draft acknowledging it does not have the information (e.g., "Let me check with the team and get back to you").
- Confidence score reflects the lower certainty.
- `knowledge_sources` is an empty array.

### 9.6 Oversized compact summary

A long-running client has a compact summary exceeding the ~2,000 token budget.

**Behavior:**
- The summary is truncated from the start (oldest sections removed first).
- The most recent summary content is preserved.
- This is deterministic -- the same input always produces the same truncation.
- The daily compaction job (F-11) keeps summaries manageable over time.

### 9.7 Concurrent messages from the same client

Two messages arrive in quick succession from the same client.

**Behavior:**
- The advisory lock (`pg_try_advisory_lock(hashtext(session_key))`) ensures only one worker processes messages for a client at a time.
- The second message stays in pgmq and becomes visible after the visibility timeout (60s).
- The first message completes processing (draft saved). The second message is then processed with fresh context (including the first message in recent history).
- Per-client serialization guarantees ordering (architecture-final.md SS 8.1).

### 9.8 Tool loop runaway

The LLM keeps calling tools without producing a final text response.

**Behavior:**
- The MAX_TOOL_LOOPS cap (5) stops the loop.
- If any text content has been generated, it is used as the draft.
- If no text content exists, the conversation is flagged for manual handling with an audit event: `{ action_type: 'tool_loop_exhausted' }`.
- LLM usage is logged for all iterations.

### 9.9 Reprompt on stale conversation

Staff reprompts 30 minutes after the original draft. A new message arrived during that time.

**Behavior:**
- Context is reassembled fresh on reprompt (SS 8.1 step 4).
- The new message appears in the recent messages section.
- The Client Worker sees up-to-date context.
- The new draft reflects the current conversation state.

---

## 10. Acceptance Criteria to Task Mapping

### Task T-F05-01: Context assembly -- global sections

Implements SS 2.2 (global sections), SS 4.1 (rows 1-4), SS 4.2 (global caching note).

- [ ] `context-assembly.ts` in `_shared/`: implement `loadWorkspaceConfig()` returning workspace config, vertical config, communication profile.
- [ ] Query: `SELECT * FROM workspaces WHERE id = $1`.
- [ ] Parse `vertical_config` JSONB into typed `VerticalConfig` (custom fields, appointment types, SOP rules).
- [ ] Parse `communication_profile` JSONB into `CommunicationRule[]`. If null or empty, return empty array (no error).
- [ ] Vertical config section budget: ~500 tokens.
- [ ] Communication rules budget: ~500 tokens, capped at 20 rules.
- [ ] Global sections are byte-identical across different clients in the same workspace (verified by test).
- [ ] Unit tests: workspace with full config; workspace with null communication profile; token budget enforcement.

Covers AC: F05-S01 all scenarios.

### Task T-F05-02: Context assembly -- client-scoped sections

Implements SS 2.2 (client sections), SS 4.1 (rows 6-10), SS 4.4 (isolation).

- [ ] `context-assembly.ts`: implement `loadClientProfile()`, `loadCompactSummary()`, `loadRecentMessages()`, `loadActiveBookings()`, `loadOpenFollowUps()`, `loadRecentNotes()`, `loadConversationState()`.
- [ ] Every query includes `WHERE workspace_id = $1 AND client_id = $2`.
- [ ] Client profile: select from `clients` with `deleted_at IS NULL`. Budget ~500 tokens. Trim oldest tags if > 20.
- [ ] Compact summary: select latest from `memories WHERE type = 'compact_summary' ORDER BY version DESC LIMIT 1`. Budget ~2,000 tokens. Truncate oldest sections if oversized. Return null if no memory record (new client).
- [ ] Recent messages: `SELECT * FROM messages WHERE conversation_id = $conv ORDER BY created_at DESC LIMIT 10`, returned in chronological order (reversed). Budget ~3,000 tokens. Include direction, sender_type, content, timestamp.
- [ ] Active bookings: `SELECT * FROM bookings WHERE client_id = $2 AND workspace_id = $1 AND status IN ('confirmed', 'at_risk') ORDER BY start_time ASC LIMIT 5`. Include appointment_type, start_time, status.
- [ ] Open follow-ups: `SELECT * FROM follow_ups WHERE client_id = $2 AND workspace_id = $1 AND status IN ('open', 'pending', 'overdue') ORDER BY due_date ASC NULLS LAST LIMIT 5`.
- [ ] Recent notes: `SELECT * FROM notes WHERE client_id = $2 AND workspace_id = $1 ORDER BY created_at DESC LIMIT 5`.
- [ ] Conversation state: `SELECT state FROM conversations WHERE client_id = $2`. Budget ~100 tokens.
- [ ] Unit tests: full data client; new client (no summary, no items); data-rich client (truncation verified).
- [ ] Integration test: verify no cross-client data leakage by assembling context for two clients in same workspace.

Covers AC: F05-S02 all scenarios.

### Task T-F05-03: Token budget management

Implements SS 4.1 (all budgets), SS 4.3 (token counting).

- [ ] `token-budget.ts` in `_shared/`: implement `estimateTokens()` and `applyTokenBudget()`.
- [ ] Token estimation: `Math.ceil(text.length / 4)` for MVP approximation.
- [ ] `truncateCompactSummary()`: truncate from start if > 2,000 tokens.
- [ ] `truncateKnowledgeChunks()`: include in descending similarity order until ~2,000 token budget exceeded.
- [ ] `truncateClientProfile()`: trim oldest tags if > 20.
- [ ] Active items: cap 5 per category (bookings, follow-ups, notes).
- [ ] Recent messages: hard cap at 10.
- [ ] Inbound message: hard truncation at 2,000 characters.
- [ ] Fixed sections (system prompt, tool definitions) are never truncated.
- [ ] Total assembled context does not exceed ~12,000 tokens for a data-rich client.
- [ ] Total context for a new client is well under 12,000 tokens, no errors.
- [ ] Unit tests: data-rich client -> total within budget; each section respects its budget; new client -> graceful degradation.

Covers AC: F05-S10 all scenarios.

### Task T-F05-04: Knowledge semantic search

Implements SS 2.7, SS 6 (all subsections).

- [ ] `knowledge-search.ts` in `_shared/`: implement `searchKnowledge()`.
- [ ] `embedding.ts` in `_shared/`: implement `generateEmbedding()` using OpenAI `text-embedding-3-small` (1536 dimensions).
- [ ] Database migration: create `search_knowledge_chunks` RPC function (pgvector cosine similarity, workspace-scoped).
- [ ] Pre-retrieval: called from `assembleContext()` with inbound message text as query.
- [ ] Top-K retrieval (default K=5), ranked by cosine similarity.
- [ ] Minimum similarity threshold (default 0.7). Chunks below threshold excluded.
- [ ] Token budget applied: include chunks in descending similarity until ~2,000 tokens exceeded.
- [ ] Each chunk includes source attribution (`source`, `source_ref`).
- [ ] No matches: knowledge section is empty, no error, LLM proceeds.
- [ ] Workspace scoping: `WHERE workspace_id = $1` in the RPC query.
- [ ] On-demand search tool: `executeKnowledgeSearch()` handler with smaller budget (topK=3, tokenBudget=1000).
- [ ] Unit tests: relevant matches returned in order; no matches returns empty; budget enforcement; workspace isolation.
- [ ] Integration test: index test chunks, search, verify correct chunks returned.

Covers AC: F05-S03 all scenarios.

### Task T-F05-05: System prompt composition

Implements SS 2.3.

- [ ] `system-prompt.ts` in `_shared/`: implement `composeSystemPrompt()`.
- [ ] Dynamic composition from workspace config: business name, timezone, business hours, tone profile.
- [ ] Include SOP rules from vertical config as behavior instructions.
- [ ] Include custom field definitions and appointment type definitions.
- [ ] Include communication rules if any exist (empty = omit section).
- [ ] Include intent taxonomy (default set, workspace-configurable override).
- [ ] Include draft generation rules (tone matching, knowledge attribution, no fabrication).
- [ ] Include structured output instructions (intent, confidence, draft text).
- [ ] Calendar disabled note if not connected.
- [ ] System prompt budget: ~1,500 tokens.
- [ ] Unit tests: full workspace config; workspace without calendar; workspace without communication rules.

Covers AC: F05-S01 (system prompt scenarios), F05-S05 (intent taxonomy in prompt).

### Task T-F05-06: Client Worker runtime (LLM call + tool loop)

Implements SS 2.4, SS 5 (all subsections).

- [ ] `agent-runtime.ts` in `_shared/`: implement `invokeClientWorker()`.
- [ ] OpenRouter setup: OpenAI SDK with `baseURL: 'https://openrouter.ai/api/v1'`, model `anthropic/claude-sonnet-4-20250514`, max_tokens 1024.
- [ ] `buildConversationMessages()`: format context into user message with XML delimiters.
- [ ] `buildToolDefinitions()`: convert Zod schemas to OpenAI-compatible tool format. Filter calendar tools if not connected.
- [ ] Tool execution loop: process `tool_calls`, inject params, validate with Zod, execute, collect results.
- [ ] MAX_TOOL_LOOPS = 5. Stop loop on cap, use whatever text content exists.
- [ ] Tool loop exhausted with no text: flag for manual handling.
- [ ] Read tools: return result to LLM for next iteration.
- [ ] Write tools: wrap in ProposedAction, do not execute.
- [ ] Auto-write tools (`create_note`): execute immediately, audit logged.
- [ ] Structured output extraction: intent + confidence from LLM response.
- [ ] Fallback: if LLM does not return structured classification, default to `general_question` / 0.5.
- [ ] Knowledge source collection: from pre-retrieved chunks + tool call results.
- [ ] Unit tests: single LLM call with no tools; LLM with tool calls; tool loop capped at 5; schema validation failure; unknown tool rejected.
- [ ] Integration test: end-to-end LLM call with mocked OpenRouter responses.

Covers AC: F05-S04 all scenarios.

### Task T-F05-07: Intent classification

Implements SS 5.6.

- [ ] Intent taxonomy in system prompt: `booking_inquiry`, `pricing_question`, `general_question`, `follow_up`, `greeting`, `complaint`, `cancellation`, `reschedule`, `out_of_scope`.
- [ ] LLM classifies every inbound message into exactly one primary intent.
- [ ] Multiple intents: most actionable as primary, secondaries noted in draft text.
- [ ] Intent stored on draft record: `drafts.intent_classified`.
- [ ] Intent feeds into escalation logic (F05-S07 / F-06 human-only check).
- [ ] Unit tests: verify intent extraction from mock LLM responses; fallback behavior.

Covers AC: F05-S05 all scenarios.

### Task T-F05-08: Draft save, confidence gate, and escalation

Implements SS 2.9, SS 7 (all subsections).

- [ ] `draft-persistence.ts` in `_shared/`: implement `saveDraft()`.
- [ ] Insert into `drafts`: content, intent_classified, confidence_score, knowledge_sources, workspace_id, conversation_id. Staff_action NULL on creation.
- [ ] Update `conversations.state` to `awaiting_staff_review`.
- [ ] Verify: `drafts` INSERT triggers Supabase Realtime event.
- [ ] Confidence gate: if `confidence < threshold` (default 0.4), skip draft save, flag for manual handling.
- [ ] Intent-level gate: if intent is human-only (from F-06 `isHumanOnlyIntent()`), skip draft save, flag for manual handling.
- [ ] `flagForManualHandling()`: set `conversations.manual_handling_required = true`, write audit event `escalation_flagged`.
- [ ] Escalated conversation: no draft record created. Conversation state `awaiting_staff_review` with `manual_handling_required = true`.
- [ ] Confidence threshold workspace-configurable (stored in workspaces table or defaults).
- [ ] Integration tests: high-confidence draft saved + Realtime fires; low-confidence skips draft, flags conversation; human-only intent skips draft, flags conversation.

Covers AC: F05-S06, F05-S07, F05-S08 all scenarios.

### Task T-F05-09: Staff reprompt and regeneration

Implements SS 8 (all subsections).

- [ ] Reprompt entry point: `process-message` Edge Function accepts `RepromptPayload` type.
- [ ] Rate limit: max 5 reprompts per conversation per hour. Query `drafts` table for recent reprompts. Return 429 if exceeded.
- [ ] Load current draft. Mark `staff_action = 'regenerated'`.
- [ ] Fresh context assembly (captures state changes since original draft).
- [ ] Build reprompt conversation: same context + previous draft as assistant message + staff instruction as user message.
- [ ] New LLM call with full tool capability.
- [ ] Save new draft with `reprompt_of` FK to previous draft and `staff_instruction` text.
- [ ] Sequential reprompts: chain via `reprompt_of`. All previous drafts preserved for audit.
- [ ] Regenerated draft goes through same confidence/escalation checks.
- [ ] Log LLM usage for the reprompt call.
- [ ] Database migration: add `reprompt_of` and `staff_instruction` columns to `drafts` table.
- [ ] Unit tests: single reprompt; sequential reprompts; rate limit enforcement; fresh context verified.
- [ ] Integration test: reprompt produces new draft with correct references.

Covers AC: F05-S09 all scenarios.

### Task T-F05-10: LLM usage logging and pipeline integration

Implements SS 2.10, SS 2.1 (orchestrator).

- [ ] `llm-usage.ts` in `_shared/`: implement `logLLMUsage()`.
- [ ] `llm-pricing.ts` in `_shared/`: implement `calculateCost()` with model pricing constants.
- [ ] Log after every LLM call: tokens_in, tokens_out, latency_ms, cost_usd, model, workspace_id, client_id, edge_function_name.
- [ ] Orchestrator in `process-message/index.ts`: wire together steps 7-13.
- [ ] Idempotency guard: check if draft exists for this message before processing.
- [ ] Advisory lock: `pg_try_advisory_lock(hashtext(session_key))`.
- [ ] Error boundaries: try/catch per step, log errors, respect pgmq retry semantics.
- [ ] DLQ routing: after 3 retries (`read_ct > 3`), move to `inbound_dlq`.
- [ ] pgmq archive on success: `pgmq.archive('inbound_messages', msg_id)`.
- [ ] End-to-end latency target: < 10 seconds for 95th percentile.
- [ ] Integration test: full pipeline from pgmq dequeue to draft save + usage logged.

Covers AC: cross-cutting pipeline requirements, Definition of Done latency target.

### Task T-F05-11: Database migrations

- [ ] Migration: `search_knowledge_chunks` RPC function for pgvector cosine similarity search.
- [ ] Migration: add `reprompt_of UUID REFERENCES drafts(id)` column to `drafts` table.
- [ ] Migration: add `staff_instruction TEXT` column to `drafts` table.
- [ ] Migration: add `idx_drafts_conversation` index on `drafts(conversation_id, created_at DESC)`.
- [ ] Migration: add `manual_handling_required BOOLEAN NOT NULL DEFAULT false` to `conversations` table (if not already added by F-06).
- [ ] Migration: add `confidence_threshold REAL` to `workspaces` table (nullable, defaults handled in application code).
- [ ] All migrations are additive (no destructive changes to existing columns).

Covers: schema requirements across all tasks.

---

## 11. Build Order

```
T-F05-11 (Database migrations)          ── schema must exist first
    |
    v
T-F05-01 (Global context assembly)     ── loads workspace-level data
T-F05-02 (Client-scoped context)        ── loads client-level data
    |          (can be built in parallel)
    v
T-F05-03 (Token budget management)     ── enforces budgets on T-01 + T-02
    |
    v
T-F05-04 (Knowledge semantic search)   ── pgvector search, feeds into context
T-F05-05 (System prompt composition)    ── composes the system prompt
    |          (can be built in parallel)
    v
T-F05-06 (Client Worker runtime)       ── LLM call + tool loop
    |
    v
T-F05-07 (Intent classification)       ── within the Client Worker call
    |          (built alongside T-06)
    v
T-F05-08 (Draft save + escalation)     ── persists draft or flags escalation
    |
    v
T-F05-09 (Staff reprompt)              ── depends on full draft lifecycle
    |
    v
T-F05-10 (Pipeline integration)        ── wires everything together, end-to-end
```

---

## 12. Definition of Done (Feature Level)

- [ ] All 10 user stories pass acceptance criteria in integration tests.
- [ ] Context assembly produces a valid `ReadOnlyContext` for clients with no history, partial data, and full data.
- [ ] Global context sections are identical across different clients in the same workspace.
- [ ] Client-scoped context never includes data from another client (verified by isolation tests).
- [ ] All database queries in context assembly include `WHERE workspace_id = $1 AND client_id = $2`.
- [ ] pgvector semantic search returns relevant knowledge chunks within the ~2,000 token budget.
- [ ] The Client Worker makes exactly one LLM API call (plus tool loop iterations) per inbound message.
- [ ] Tool parameter injection overrides any LLM-provided workspaceId or clientId.
- [ ] Intent classification is present on every generated draft.
- [ ] Knowledge source attribution is present on drafts that used knowledge base content.
- [ ] Low-confidence or human-only messages skip draft generation and flag the conversation.
- [ ] Draft records include all required fields and are never deleted.
- [ ] Staff reprompt produces a new draft with fresh context, preserving the old draft for audit.
- [ ] Reprompt rate limit (5/hour/conversation) is enforced.
- [ ] Total assembled context does not exceed ~12,000 tokens for any client regardless of data volume.
- [ ] End-to-end latency from inbound message to draft-ready notification is under 10 seconds for 95th percentile.
- [ ] LLM usage is logged for every invocation with accurate cost calculation.
