# Architecture Specification — WhatsApp-First AI Client Ops Manager

**Version:** 1.0
**Date:** March 2026
**Status:** Architecture proposal — pragmatic MVP-first
**Companion:** PRD v2.1
**Reviewer note:** This document supersedes `adr/architecture.md` with a simplified, MVP-first design. Differences are called out where relevant.

---

## 0. Design philosophy

This architecture is designed for a solo founder shipping fast. Every decision optimizes for:

1. **Fewer moving parts.** One Supabase project + one Vercel app. No Redis, no BullMQ, no separate API server.
2. **Ship in weeks, not months.** Use managed services for everything. Write custom code only for domain logic.
3. **Correct by construction.** Session isolation, approval boundaries, and audit logging are structural -- not bolted on later.
4. **Defer what you can.** Learning loop analysis, multi-staff RBAC, COS LLM calls, and performance dashboards are designed for but not built in MVP.

### What changed from the previous architecture draft

| Previous draft | This proposal | Why |
|---|---|---|
| BullMQ + Redis message queue | Postgres-backed queue in Supabase | Eliminates Redis infrastructure. Supabase Edge Functions + pg_cron + `SKIP LOCKED` gives durable ordered processing. |
| Fastify separate API server | Next.js API routes + Supabase Edge Functions | One deployment target (Vercel). No separate server to manage. |
| 7 bounded contexts with clean architecture layers | Flat module structure with collocated files | Solo founder. DDD ceremony slows you down. Refactor when the team grows. |
| COS as separate LLM invocation path | Database queries + simple aggregation | For MVP single-operator, "today's view" is a SQL query, not an LLM call. |
| Optimistic locking with version fields | Advisory locks via `pg_advisory_xact_lock` on processing | Simpler. Message ordering handled by queue + single-worker-per-client. |
| Learning optimization fully specified | Signal recording only (Phase 2). Analysis deferred. | Record the data now. Build the analysis when you have enough signals. |
| OpenRouter LLM gateway | Direct provider SDK (Anthropic/OpenAI) | One provider is fine for MVP. No abstraction layer needed yet. |

---

## 1. System diagram

```
                            +---------------------------+
                            |     WhatsApp Cloud API    |
                            |     (Meta / WABA)         |
                            +--+---------------------+--+
                               |  webhooks            ^ send messages
                               v                      |
+------------------------------+----------------------+-----------+
|                        SUPABASE PROJECT                         |
|                                                                 |
|  +--------------------+     +-------------------------------+   |
|  | Edge Function:     |     | Edge Function:                |   |
|  | whatsapp-webhook   |     | process-message               |   |
|  |                    |     |                                |   |
|  | - Verify signature |     | - Dequeue from message_queue  |   |
|  | - Deduplicate      |     | - Phone normalization         |   |
|  | - Enqueue to       |     | - Client find-or-create       |   |
|  |   message_queue    |     | - Context assembly            |   |
|  |   (Postgres table) |     | - LLM invocation (1 call)     |   |
|  +--------------------+     | - Tool execution loop         |   |
|                              | - Approval policy eval        |   |
|  +--------------------+     | - Save draft + proposed actions|   |
|  | Edge Function:     |     | - Notify staff (Realtime)     |   |
|  | send-message       |     +-------------------------------+   |
|  |                    |                                         |
|  | - 24h window check |     +-------------------------------+   |
|  | - Template fallback|     | Edge Function:                |   |
|  | - WhatsApp send API|     | daily-cron                    |   |
|  +--------------------+     |                                |   |
|                              | - Compaction (per client)     |   |
|  +--------------------+     | - Follow-up surfacing         |   |
|  | Edge Function:     |     | - Inactivity detection        |   |
|  | approve-action     |     | - Queue follow-up drafts      |   |
|  |                    |     +-------------------------------+   |
|  | - Execute approved |                                         |
|  |   ProposedAction   |     +-------------------------------+   |
|  | - Audit log        |     | PostgreSQL (Supabase)         |   |
|  +--------------------+     |                                |   |
|                              | - All tables (RLS-protected)  |   |
|                              | - pgvector (knowledge search) |   |
|                              | - message_queue table         |   |
|                              | - Realtime subscriptions      |   |
|                              +-------------------------------+   |
|                                                                  |
|  +--------------------+     +-------------------------------+    |
|  | Supabase Auth      |     | Supabase Storage              |    |
|  | - Staff login      |     | - Media files (voice, images) |    |
|  | - JWT tokens       |     | - Document uploads            |    |
|  | - RLS policies     |     +-------------------------------+    |
|  +--------------------+                                          |
+------------------------------------------------------------------+
        |                                       ^
        | Realtime subscriptions                | API calls
        | (new drafts, messages, actions)       | (approve, send, CRUD)
        v                                       |
+------------------------------------------------------------------+
|                     VERCEL (Next.js App Router)                   |
|                                                                   |
|  +---------------------------+  +-----------------------------+   |
|  | Staff Web App (React)     |  | API Routes                  |   |
|  |                           |  |                              |   |
|  | - Inbox view              |  | /api/webhooks/whatsapp      |   |
|  | - Client thread + draft   |  |   (proxy to Edge Function)  |   |
|  | - Today's view            |  |                              |   |
|  | - Client profile          |  | /api/webhooks/stripe        |   |
|  | - Settings                |  |   (subscription management) |   |
|  | - Approval cards          |  |                              |   |
|  +---------------------------+  +-----------------------------+   |
+-------------------------------------------------------------------+
        |
        v
+-------------------+     +-------------------+
| Stripe            |     | Google Calendar    |
| - Subscriptions   |     | - OAuth per        |
| - Billing portal  |     |   workspace        |
+-------------------+     | - Availability     |
                          | - Event CRUD       |
                          +-------------------+

+-------------------+
| LLM Provider      |
| (Claude / OpenAI) |
| - Chat completion |
| - Tool calling    |
| - Embeddings      |
+-------------------+
```

---

## 2. Data flow: message ingestion through to staff app

### 2.1 Inbound message pipeline

```
1. Client sends WhatsApp message
        |
        v
2. Meta Cloud API POSTs to webhook URL
        |
        v
3. Edge Function: whatsapp-webhook
   - Verify X-Hub-Signature-256 (HMAC-SHA256)
   - Extract message from webhook payload
   - Check message_queue for duplicate (wamid)
   - INSERT into message_queue with status = 'pending'
   - RETURN 200 immediately (< 500ms to avoid Meta retries)
        |
        v
4. Edge Function: process-message (triggered by pg_notify or polling)
   - SELECT ... FROM message_queue WHERE status = 'pending'
     ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
   - Parse payload: extract text, media refs, sender phone
   - Normalize phone number to E.164
   - Client find-or-create:
     SELECT client from clients WHERE phone = $1 AND workspace_id = $2
     If not found: INSERT new client record
        |
        v
5. Media pre-processing (if applicable)
   - Voice notes: call Whisper API for transcription
   - Images: download from Meta CDN, store in Supabase Storage
   - Documents: store, mark as staff-visible-only
        |
        v
6. Store raw inbound message in messages table
        |
        v
7. Context assembly (deterministic, no LLM)
   assembleContext(workspaceId, clientId, inboundMessage) -> ReadOnlyContext
   - Load workspace config (timezone, hours, tone, SOP)
   - Load vertical config (custom fields, appointment types)
   - Load communication profile (learned rules, if any)
   - Semantic search knowledge base (pgvector on inbound text)
   - Load client profile + custom field values
   - Load latest compact summary
   - Load recent messages (last 10)
   - Load active bookings
   - Load open follow-ups
   - Load recent notes (last 5)
        |
        v
8. Client Worker invocation (single LLM API call)
   - System prompt composed from workspace config + context
   - User message = inbound message text
   - Tools available: knowledge_search, calendar_query,
     calendar_book, update_client, create_note, create_followup
   - LLM returns: draft text + tool calls
        |
        v
9. Tool execution loop
   - For each tool call from LLM:
     - Inject workspaceId + clientId (LLM cannot override)
     - Validate params against tool schema (Zod)
     - Execute tool
     - If read tool: return result to LLM for next iteration
     - If write tool: wrap in ProposedAction, do NOT execute yet
   - Continue until LLM returns final text response (the draft)
        |
        v
10. Approval policy evaluation
    - For each ProposedAction:
      - Classify tier (auto / review / human_only)
      - Auto: execute immediately, write audit event
      - Review: save as pending, create confirmation request
      - Human-only: flag conversation, skip draft
        |
        v
11. Save draft to drafts table
    - intent_classified, confidence_score, knowledge_sources
    - If low confidence or human-only: mark as escalated
        |
        v
12. Update conversation state -> 'awaiting_staff_review'
        |
        v
13. Notify staff
    - Supabase Realtime: broadcast to workspace channel
    - Staff app receives: new draft ready, unread badge update
    - Push notification (web push via service worker)
        |
        v
14. Update message_queue row: status = 'completed'
```

### 2.2 Staff review and send flow

```
1. Staff opens client thread in app
   - Sees: conversation history, AI draft, client snapshot sidebar
   - Sees: approval cards for any pending ProposedActions
        |
        v
2. Staff reviews draft
   - Option A: Send as-is -> record staff_action = 'sent_as_is'
   - Option B: Edit inline, then send -> record 'edited_and_sent'
   - Option C: Reprompt ("make it shorter") -> new LLM call with instruction
   - Option D: Discard -> record 'discarded', handle manually
        |
        v
3. On send:
   - Check 24-hour conversation window
     - Window open: send freeform message via WhatsApp API
     - Window closed: match to approved template, send template
     - No template: block send, notify staff
   - Store outbound message
   - Record DraftEditSignal (original draft + final version)
   - Update conversation state -> 'awaiting_client_reply'
        |
        v
4. Staff approves/rejects pending ProposedActions
   - Approve: execute action (create booking, update client, etc.)
   - Reject: mark rejected, audit log
```

---

## 3. Component breakdown

### 3.1 Supabase Edge Functions

Each Edge Function is a Deno-based serverless function deployed to Supabase. They handle all server-side processing.

| Function | Responsibility | Trigger | Latency target |
|---|---|---|---|
| `whatsapp-webhook` | Receive Meta webhooks, verify signature, deduplicate by `wamid`, enqueue to `message_queue` table | HTTP POST from Meta | < 500ms (must return 200 fast) |
| `process-message` | Dequeue message, run full pipeline (context assembly, LLM call, tool loop, approval eval, save draft, notify) | Called by webhook function or pg_cron poll | < 30s total |
| `send-message` | Check 24h window, send via WhatsApp API or template, record outbound message | Called from staff app | < 2s |
| `approve-action` | Execute a staff-approved ProposedAction, write to database, audit log | Called from staff app | < 1s |
| `daily-cron` | Run compaction, surface follow-ups, detect inactivity, queue follow-up drafts | pg_cron (daily per workspace timezone) | < 5 min total |
| `embed-knowledge` | Chunk text, generate embeddings, upsert to knowledge_chunks | Called when knowledge base updated | < 30s per document |

### 3.2 Next.js App (Vercel)

The staff-facing web application. Mobile-first responsive. PWA-capable.

| Module | Responsibility |
|---|---|
| **Inbox page** | List conversations sorted by recency/priority. Unread badges. Filter by conversation state. Real-time updates via Supabase Realtime subscription. |
| **Client thread page** | Conversation history. AI draft review panel (edit, send, reprompt). Client snapshot sidebar (profile, bookings, notes, follow-ups, custom fields). Approval cards for pending actions. |
| **Today's view page** | Today's appointments. Pending follow-ups. At-risk bookings. Generated by SQL query, not LLM. |
| **Client profile page** | Full client record. Conversation history. All bookings, notes, follow-ups. Custom field editor. |
| **Settings page** | Knowledge base editor + document upload. Tone profile. SOP editor. Calendar connection (Google OAuth). WhatsApp config. Communication rules (view/toggle). Stripe billing portal link. |
| **Onboarding flow** | Step-by-step: business identity, Instagram scrape trigger, SOP review, tone review, calendar connect. |

### 3.3 Supabase services used

| Service | Usage |
|---|---|
| **PostgreSQL** | All application data. RLS for tenant isolation. pgvector for knowledge search. `message_queue` table for durable message processing. |
| **Auth** | Staff authentication. JWT tokens. RLS policy enforcement. Magic link or email/password. |
| **Realtime** | Push new messages, drafts, and approval requests to staff app. Workspace-scoped channels. |
| **Storage** | Media files (voice notes, images, documents). Bucket per workspace. |
| **Edge Functions** | All server-side processing (see 3.1). |
| **pg_cron** | Schedule daily cron jobs. Trigger `process-message` polling if using pull-based approach. |

### 3.4 External services

| Service | Usage |
|---|---|
| **WhatsApp Cloud API (Meta)** | Inbound webhooks. Outbound message sending. Template messages. Delivery status webhooks. |
| **LLM Provider (Claude or OpenAI)** | Chat completions with tool calling for Client Worker. Embeddings for knowledge search. Whisper for voice transcription (if OpenAI). Summarization for daily compaction. |
| **Google Calendar API** | OAuth per workspace. Availability queries. Event CRUD. |
| **Stripe** | Subscription management. Billing portal. Usage-based pricing (message count). Webhook for subscription status changes. |

---

## 4. Scaling approach

### 4.1 MVP scale (Phase 1-2)

The MVP targets 1-10 workspaces, each with up to ~500 clients and ~100 messages/day per workspace.

At this scale, the architecture is intentionally simple:

- **Single Supabase project** serves all tenants (multi-tenant by RLS).
- **Edge Functions** handle all processing. No long-running servers.
- **Postgres message queue** with `FOR UPDATE SKIP LOCKED` provides reliable ordered processing without Redis.
- **No horizontal scaling needed.** Supabase Pro tier handles this comfortably.

### 4.2 Growth triggers and responses

| Trigger | Symptom | Response |
|---|---|---|
| > 1000 messages/day across all workspaces | `process-message` queue backs up | Move message processing to a dedicated worker (Fly.io or Railway) with BullMQ + Redis. The Edge Function becomes a thin enqueue layer. |
| > 50 workspaces | Daily cron takes too long | Partition cron by workspace. Run compaction jobs in parallel per workspace. |
| > 5000 clients per workspace | Context assembly queries slow down | Add composite indexes. Consider read replicas. |
| LLM costs exceed budget | Cost tracking shows overspend | Implement per-workspace message caps. Switch to smaller models for simple intents. Cache knowledge search results. |
| Staff app feels slow | Page load > 3s | Add CDN caching for static assets (Vercel handles this). Paginate client lists. Lazy-load conversation history. |

### 4.3 What is deferred

- **Horizontal scaling** of message processing (BullMQ + Redis). Not needed until ~1000 msgs/day.
- **Read replicas** for the staff app. Not needed until ~50 workspaces.
- **CDN for media**. Supabase Storage is sufficient for MVP.
- **Multi-region deployment**. Single region is fine for initial markets.

---

## 5. Security model

### 5.1 Data isolation (multi-tenant)

Every table that stores tenant data includes a `workspace_id` column. Row Level Security (RLS) policies enforce that authenticated users can only access rows belonging to their workspace.

```sql
-- Example RLS policy on clients table
CREATE POLICY "Users can only access clients in their workspace"
  ON clients
  FOR ALL
  USING (
    workspace_id = (
      SELECT workspace_id FROM staff
      WHERE id = auth.uid()
    )
  );
```

RLS is enforced at the database level. Even if application code has a bug that omits a `WHERE workspace_id = $1` clause, the database rejects the query. This is defense-in-depth.

**Every table** gets an RLS policy. No exceptions. The RLS policy pattern is:
- Staff can access rows where `workspace_id` matches their workspace.
- Service role (Edge Functions) bypasses RLS but always includes `workspace_id` in queries by convention. Edge Functions use the service role key only for operations that cross workspace boundaries (e.g., daily cron iterating over all workspaces).

### 5.2 Authentication

- **Staff login:** Supabase Auth with email/password or magic link. JWT tokens with workspace_id claim.
- **WhatsApp webhook:** Verified by HMAC-SHA256 signature using the app secret. No auth token -- Meta uses signature verification.
- **Service-to-service:** Edge Functions use the Supabase service role key. This key is stored as a Supabase secret, never exposed to the client.

### 5.3 Encryption

- **In transit:** TLS everywhere. Supabase enforces HTTPS. Vercel enforces HTTPS. WhatsApp API uses HTTPS.
- **At rest:** Supabase encrypts database storage at rest (AES-256). Supabase Storage encrypts files at rest.
- **Sensitive fields:** Google Calendar OAuth tokens and WhatsApp API credentials stored in workspace config are encrypted at the application level before storage using Supabase Vault (or a `encrypt_secret()` database function wrapping `pgcrypto`).

### 5.4 API security

- **Rate limiting:** Supabase Edge Functions have built-in rate limiting. Additional application-level rate limiting: max 20 inbound messages/minute per sender phone (to prevent spam/abuse).
- **Input validation:** All inputs validated with Zod schemas before processing. Tool call parameters validated before execution.
- **CORS:** Staff app origin only. No wildcard.

### 5.5 LLM security

- **Tool parameter injection:** `workspaceId` and `clientId` are injected by the runtime into every tool call. The LLM cannot override these values. If the LLM outputs a tool call with a `workspaceId` or `clientId` parameter, it is silently overwritten.
- **No PII in logs:** LLM request/response logging (for debugging) strips client phone numbers and message content. Only metadata (token counts, tool names, latency) is logged to external services.
- **Prompt injection defense:** The system prompt clearly delineates client message content. Client messages are wrapped in explicit delimiters. The trust model means even if injection succeeds, all mutations require staff approval.

### 5.6 Compliance

- **WhatsApp Business API compliance:** Opt-in tracking. 24-hour window enforcement. Template messages for out-of-window. No unsolicited messaging.
- **Data retention:** Messages retained indefinitely (required for client context). Soft deletes for GDPR-style deletion requests (mark `deleted_at`, exclude from queries).
- **Audit trail:** Every mutation logged with actor, action, timestamp, before/after state. Immutable audit_events table (INSERT only, no UPDATE/DELETE).

---

## 6. AI / LLM integration pattern

### 6.1 Single agent with tools

One LLM invocation per inbound client message. The agent receives assembled context and a fixed set of tools. It returns a draft reply and zero or more tool calls (proposed actions).

This is not a multi-agent system. There is no "scheduling agent" or "knowledge agent." Scheduling and knowledge retrieval are tools that the single agent calls.

```
                    Context Assembly
                    (pure function, no LLM)
                           |
                           v
                +---------------------+
                |    System Prompt    |
                | (workspace config   |
                |  + tone + SOP +     |
                |  communication      |
                |  rules)             |
                +---------------------+
                           |
                           v
+--------+    +------------------------+    +-----------+
| Client |    |    LLM API Call        |    |  Tools    |
| Context|--->|    (single invocation) |--->| (called   |
| (read- |    |                        |    |  in loop) |
|  only) |    |  - Classifies intent   |    |           |
+--------+    |  - Searches knowledge  |    | knowledge |
              |  - Checks calendar     |    | calendar  |
              |  - Drafts reply        |    | client    |
              |  - Proposes actions    |    | note      |
              +------------------------+    | followup  |
                           |                +-----------+
                           v
              +------------------------+
              | Output:                |
              | - Draft text           |
              | - ProposedAction[]     |
              | - Intent classified    |
              | - Confidence score     |
              +------------------------+
                           |
                           v
              +------------------------+
              | Approval Policy        |
              | Evaluation             |
              | (deterministic code)   |
              +------------------------+
```

### 6.2 Context assembly

Context assembly is a **pure function**: `assembleContext(workspaceId, clientId, inboundMessage) -> ReadOnlyContext`. It runs before the LLM is invoked. The LLM cannot influence what data it receives.

```typescript
type ReadOnlyContext = {
  // Session identity
  sessionKey: string;  // workspace:{id}:client:{id}

  // GLOBAL — same for every client in this workspace
  workspace: {
    businessName: string;
    timezone: string;
    businessHours: Record<string, { open: string; close: string }>;
    toneProfile: string;
  };
  verticalConfig: {
    customFields: CustomFieldDef[];
    appointmentTypes: AppointmentTypeDef[];
    sopRules: string[];
  };
  communicationRules: CommunicationRule[];  // learned from edit loop (empty initially)
  knowledgeChunks: string[];  // top-K semantic search results

  // CLIENT-SCOPED — isolation boundary, unique per client
  client: {
    id: string;
    name: string;
    phone: string;
    lifecycleStatus: string;
    tags: string[];
    preferences: Record<string, unknown>;  // includes vertical custom fields
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

  // The message being processed
  inboundMessage: {
    content: string;
    mediaType: string | null;
    mediaTranscription: string | null;
    timestamp: string;
  };
};
```

**Token budget (approximately 12,000 tokens per invocation):**

| Section | Source | Budget | Truncation |
|---|---|---|---|
| System prompt + tone | Static template + workspace config | ~1,500 | None (fixed) |
| Tool definitions | Static | ~800 | None |
| Vertical config / SOP | Workspace config | ~500 | None |
| Communication rules | Learned rules | ~500 | Omit if empty |
| Knowledge chunks | pgvector search | ~2,000 | Top-K by score |
| Client profile | Client record | ~500 | Trim old tags |
| Compact summary | Memory table | ~2,000 | Truncate oldest |
| Active items | Bookings + follow-ups + notes | ~1,000 | Cap 5 per category |
| Conversation state | State enum | ~100 | None |
| Recent messages | Last 10 messages | ~3,000 | Hard cap 10 |

Global sections can be cached across invocations within the same workspace (they change rarely). Client sections are assembled fresh per invocation.

### 6.3 Tool inventory

| Tool | Authority | LLM provides | Runtime injects | Returns |
|---|---|---|---|---|
| `knowledge_search` | read | `query: string` | `workspaceId` | Relevant chunks with source |
| `calendar_query` | read | `dateRange, appointmentType` | `workspaceId` | Available time slots |
| `calendar_book` | propose_write | `slotId, appointmentType, notes` | `workspaceId, clientId` | `ProposedAction<BookingCreate>` |
| `update_client` | propose_write | `changes: FieldChanges` | `workspaceId, clientId` | `ProposedAction<ClientUpdate>` |
| `create_note` | auto_write | `content, type` | `workspaceId, clientId, source: 'ai'` | `noteId` (saved immediately) |
| `create_followup` | propose_write | `description, dueDate?` | `workspaceId, clientId` | `ProposedAction<FollowUpCreate>` |

**Tools the agent does NOT have:** anything that queries across clients, reads another client's data, sends messages directly, or modifies workspace settings.

### 6.4 Tool parameter injection (critical safety mechanism)

```typescript
function executeToolCall(
  call: LLMToolCall,
  session: { workspaceId: string; clientId: string }
): Promise<ToolResult> {
  const tool = TOOL_REGISTRY[call.name];
  if (!tool) throw new Error(`Unknown tool: ${call.name}`);

  // Runtime-injected params OVERWRITE anything the LLM provided
  const params = {
    ...call.arguments,
    workspaceId: session.workspaceId,
    clientId: session.clientId,
  };

  // Validate against Zod schema
  const validated = tool.schema.parse(params);
  return tool.execute(validated);
}
```

### 6.5 Approval boundary

Every tool with `propose_write` authority returns a `ProposedAction` instead of executing. The approval policy evaluator classifies each action:

| Tier | Actions | Behavior |
|---|---|---|
| **auto** | Update `last_contacted_at`, save AI-extracted note, attach low-risk tags | Execute immediately. Audit logged. |
| **review** | Change client name, create booking, modify lifecycle status, log promises, draft replies, create follow-ups | Staff sees confirmation card. Applied only after approval. |
| **human_only** | Refunds, pricing changes, policy exceptions, complaints | Flag for manual handling. No draft generated. |

```typescript
type ProposedAction = {
  id: string;
  workspaceId: string;
  clientId: string;
  actionType: 'client_update' | 'booking_create' | 'followup_create' | 'message_send';
  summary: string;        // human-readable description for staff
  tier: 'auto' | 'review' | 'human_only';
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};
```

MVP trust model is fixed (hardcoded tier assignments). All draft replies require staff review. No auto-send.

### 6.6 LLM provider strategy

MVP uses a single provider (Claude or OpenAI) via their TypeScript SDK directly. No abstraction layer.

| Use case | Model | Why |
|---|---|---|
| Client Worker (drafting + tools) | Claude Sonnet or GPT-4o | Best tool-calling reliability + quality |
| Embeddings | `text-embedding-3-small` (OpenAI) or Supabase built-in | Cost-effective for knowledge search |
| Voice transcription | Whisper API | Best accuracy for short voice notes |
| Daily compaction (summarization) | Claude Haiku or GPT-4o-mini | Cheap, summarization is straightforward |

Cost estimate per message: ~$0.01-0.03 (12K input tokens + ~500 output tokens at Sonnet/4o pricing).

---

## 7. Multi-tenant / workspace isolation strategy

### 7.1 Isolation model: shared database, RLS-enforced

All tenants share one Supabase project and one PostgreSQL database. Isolation is enforced by:

1. **Row Level Security (RLS)** on every table. Staff users can only read/write rows where `workspace_id` matches their workspace.
2. **Application-level scoping.** Every query in Edge Functions includes `WHERE workspace_id = $1`.
3. **Supabase Realtime channels** scoped by workspace. Staff only subscribes to `workspace:{their_workspace_id}`.
4. **Storage buckets** organized by workspace. RLS-like policies on storage.

### 7.2 Why shared, not per-tenant projects

| Approach | Pros | Cons |
|---|---|---|
| Shared (chosen) | One deployment. One migration. One cron. Simple billing. | Noisy neighbor risk. Single point of failure. |
| Per-tenant Supabase projects | Full isolation. Independent scaling. | Operational nightmare for solo founder. N deployments. N migrations. N monitoring setups. |

For MVP (1-10 workspaces), shared is the obvious choice. If a single tenant requires dedicated infrastructure (enterprise deal, data residency), deploy a separate Supabase project for that tenant only.

### 7.3 RLS policy template

Every table follows this pattern:

```sql
-- Enable RLS
ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;

-- Staff access: only their workspace
CREATE POLICY "staff_workspace_isolation" ON {table_name}
  FOR ALL
  USING (workspace_id = get_user_workspace_id(auth.uid()))
  WITH CHECK (workspace_id = get_user_workspace_id(auth.uid()));

-- Service role: full access (used by Edge Functions)
-- (Service role bypasses RLS by default in Supabase)
```

The `get_user_workspace_id()` function is a SQL function that looks up the workspace for the authenticated user. It is called once per query and cached for the transaction.

### 7.4 Session isolation (LLM context)

The LLM context window is scoped to a single client within a single workspace. Cross-client data never enters the context. This is enforced by:

1. **Query scoping:** Context assembly queries always include `WHERE workspace_id = $1 AND client_id = $2`.
2. **Tool scoping:** `workspaceId` and `clientId` injected by runtime, not controllable by LLM.
3. **Audit logging:** Every context assembly and tool call logged with session key for traceability.

---

## 8. Message pipeline

### 8.1 Webhook reliability

WhatsApp Cloud API delivers webhooks with at-least-once semantics. The pipeline must handle:

**Deduplication:** Every WhatsApp message has a unique `wamid`. Before enqueuing, the webhook handler checks if this `wamid` already exists in `message_queue`. If it does, return 200 and skip.

```sql
-- Unique constraint prevents duplicate processing
CREATE UNIQUE INDEX idx_message_queue_wamid ON message_queue(wamid);

-- Insert with conflict handling
INSERT INTO message_queue (wamid, workspace_id, payload, status, created_at)
VALUES ($1, $2, $3, 'pending', now())
ON CONFLICT (wamid) DO NOTHING
RETURNING id;
```

**Ordering:** Messages from the same client are processed in order. The `process-message` function uses `FOR UPDATE SKIP LOCKED` to claim one message at a time. For same-client ordering, the queue table includes `client_phone` and messages are processed sequentially per client using `pg_advisory_xact_lock(hashtext(client_phone))`.

```sql
-- Claim next pending message, with per-client serialization
WITH next_msg AS (
  SELECT id, payload, workspace_id
  FROM message_queue
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
SELECT * FROM next_msg;

-- Then in the processing function:
SELECT pg_advisory_xact_lock(hashtext(client_phone));
-- This ensures only one message per client processes at a time
```

**Retries:** If `process-message` fails (LLM timeout, database error), the message stays in `pending` status (or is updated to `retry` with a retry count). A pg_cron job runs every minute to reprocess failed messages with exponential backoff (max 3 retries).

```sql
-- Retry logic
UPDATE message_queue
SET status = 'retry',
    retry_count = retry_count + 1,
    next_retry_at = now() + (interval '1 minute' * power(2, retry_count))
WHERE id = $1;
```

**Dead letter:** After 3 retries, messages are moved to `status = 'dead_letter'`. Staff is notified that a message could not be processed. They handle it manually.

### 8.2 Message queue table

```sql
CREATE TABLE message_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wamid TEXT UNIQUE NOT NULL,           -- WhatsApp message ID (deduplication)
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_phone TEXT NOT NULL,           -- for per-client ordering
  payload JSONB NOT NULL,               -- raw webhook payload
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, retry, dead_letter
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'retry', 'dead_letter'))
);

CREATE INDEX idx_mq_pending ON message_queue(created_at)
  WHERE status IN ('pending', 'retry');
```

### 8.3 Processing trigger mechanism

Two options for triggering `process-message` after a webhook enqueues a message:

**Option A: Synchronous chaining (MVP choice).** The `whatsapp-webhook` Edge Function enqueues the message, then directly invokes the `process-message` Edge Function via an internal Supabase function call. Simple. No polling delay. If the processing function times out (Edge Functions have a 60s limit on free tier, 150s on Pro), the message remains in the queue for retry via pg_cron.

**Option B: pg_cron polling.** A pg_cron job runs every 10 seconds, checks for pending messages, and invokes `process-message`. Higher latency but more resilient. Used as a fallback/retry mechanism regardless.

MVP uses Option A (synchronous) with Option B (pg_cron every 30 seconds) as a safety net for retries and any messages that fall through.

### 8.4 Edge Function timeout handling

Supabase Edge Functions have execution time limits. The `process-message` function must complete within this window. The LLM call is the bottleneck (~5-15 seconds typically).

If the function times out:
1. The message remains `pending` in the queue (the status update to `completed` never committed).
2. The pg_cron retry picks it up and reprocesses.
3. Context assembly is idempotent, so reprocessing is safe.
4. If the LLM was called but the response wasn't saved, the worst case is a duplicate LLM call (wasted cost, not data corruption).

### 8.5 Delivery status webhooks

Meta sends delivery status updates (sent, delivered, read, failed) as separate webhook events. These are processed by the same `whatsapp-webhook` Edge Function but routed to a simpler handler that updates the `messages.delivery_status` field. No LLM processing needed.

---

## 9. Database schema

### 9.1 Core tables

```sql
-- ============================================================
-- WORKSPACES
-- ============================================================
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  vertical_type TEXT NOT NULL,            -- 'bespoke_tailor', 'salon', etc.
  timezone TEXT NOT NULL DEFAULT 'UTC',   -- IANA timezone
  business_hours JSONB,                    -- { "monday": { "open": "09:00", "close": "18:00" }, ... }
  tone_profile TEXT,                       -- brand voice instructions for AI
  vertical_config JSONB,                   -- VerticalConfig (custom fields, appointment types, SOP rules)
  communication_profile JSONB,            -- learned communication rules (populated by learning loop)
  whatsapp_phone_number_id TEXT,          -- Meta Cloud API phone number ID
  whatsapp_access_token TEXT,             -- encrypted via pgcrypto
  whatsapp_webhook_secret TEXT,           -- encrypted
  calendar_config JSONB,                   -- { provider, tokens, calendarId } — encrypted tokens
  instagram_handle TEXT,
  onboarding_status TEXT NOT NULL DEFAULT 'pending',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'trialing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- STAFF (users / operators)
-- ============================================================
CREATE TABLE staff (
  id UUID PRIMARY KEY REFERENCES auth.users(id),   -- links to Supabase Auth
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',               -- 'owner', 'operator'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CLIENTS (end customers who message on WhatsApp)
-- ============================================================
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  full_name TEXT,
  phone TEXT NOT NULL,                              -- normalized E.164
  email TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'open',
  tags TEXT[] DEFAULT '{}',
  preferences JSONB DEFAULT '{}',                   -- vertical custom field values
  summary TEXT,                                      -- latest compact summary
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,                           -- soft delete (merge)
  UNIQUE(workspace_id, phone)                       -- one client per phone per workspace
);

CREATE INDEX idx_clients_workspace ON clients(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_clients_phone ON clients(workspace_id, phone) WHERE deleted_at IS NULL;

-- ============================================================
-- CONVERSATIONS
-- ============================================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  state TEXT NOT NULL DEFAULT 'idle',
  last_message_at TIMESTAMPTZ,
  last_client_message_at TIMESTAMPTZ,               -- for 24h window tracking
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(client_id)                                  -- one active conversation per client
);

CREATE INDEX idx_conversations_workspace ON conversations(workspace_id);
CREATE INDEX idx_conversations_state ON conversations(workspace_id, state);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  direction TEXT NOT NULL,                            -- 'inbound', 'outbound'
  content TEXT,
  media_type TEXT,                                    -- 'image', 'voice_note', 'document', etc.
  media_url TEXT,                                     -- Supabase Storage path
  media_transcription TEXT,                           -- voice note transcription
  sender_type TEXT NOT NULL,                          -- 'client', 'staff', 'system'
  delivery_status TEXT DEFAULT 'sent',                -- 'sent', 'delivered', 'read', 'failed'
  wamid TEXT,                                         -- WhatsApp message ID
  draft_id UUID,                                      -- FK to drafts (for outbound from draft)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_wamid ON messages(wamid) WHERE wamid IS NOT NULL;

-- ============================================================
-- DRAFTS
-- ============================================================
CREATE TABLE drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  content TEXT NOT NULL,
  intent_classified TEXT,
  confidence_score REAL,
  knowledge_sources TEXT[],
  staff_action TEXT,                                  -- 'sent_as_is', 'edited_and_sent', 'regenerated', 'discarded'
  edited_content TEXT,                                -- final text if staff edited
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES staff(id)
);

-- ============================================================
-- BOOKINGS
-- ============================================================
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  appointment_type TEXT NOT NULL,                     -- key from vertical_config
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  calendar_event_id TEXT,                             -- Google Calendar event ID
  status TEXT NOT NULL DEFAULT 'confirmed',           -- 'confirmed', 'at_risk', 'cancelled', 'completed', 'no_show'
  confirmation_status TEXT DEFAULT 'pending',          -- 'pending', 'confirmed', 'unconfirmed'
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_client ON bookings(client_id);
CREATE INDEX idx_bookings_workspace_time ON bookings(workspace_id, start_time);

-- ============================================================
-- NOTES
-- ============================================================
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL,                               -- 'staff_manual', 'ai_extracted', 'conversation_update'
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_client ON notes(client_id, created_at DESC);

-- ============================================================
-- FOLLOW-UPS
-- ============================================================
CREATE TABLE follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL DEFAULT 'follow_up',             -- 'follow_up', 'promise', 'reminder'
  content TEXT NOT NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open',                -- 'open', 'completed', 'pending', 'overdue'
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_followups_client ON follow_ups(client_id);
CREATE INDEX idx_followups_workspace_status ON follow_ups(workspace_id, status)
  WHERE status IN ('open', 'pending', 'overdue');

-- ============================================================
-- MEMORY (compaction records)
-- ============================================================
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL,                                 -- 'compact_summary', 'daily_log'
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  period_date DATE,                                   -- date this memory covers
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_client_type ON memories(client_id, type, version DESC);

-- ============================================================
-- KNOWLEDGE CHUNKS (pgvector)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL,                               -- 'instagram_scrape', 'manual_upload', 'settings_editor'
  source_ref TEXT,                                    -- URL or filename
  embedding vector(1536),                             -- OpenAI text-embedding-3-small dimensions
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_workspace ON knowledge_chunks(workspace_id);
CREATE INDEX idx_knowledge_embedding ON knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- PROPOSED ACTIONS (approval boundary)
-- ============================================================
CREATE TABLE proposed_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  conversation_id UUID REFERENCES conversations(id),
  action_type TEXT NOT NULL,                          -- 'client_update', 'booking_create', 'followup_create'
  summary TEXT NOT NULL,                              -- human-readable for staff
  tier TEXT NOT NULL,                                 -- 'auto', 'review', 'human_only'
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',             -- 'pending', 'approved', 'rejected', 'expired'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES staff(id)
);

CREATE INDEX idx_proposed_actions_pending ON proposed_actions(workspace_id, status)
  WHERE status = 'pending';

-- ============================================================
-- AUDIT EVENTS (immutable log)
-- ============================================================
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  actor_type TEXT NOT NULL,                           -- 'ai', 'staff', 'system'
  actor_id UUID,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No UPDATE or DELETE policy on audit_events
CREATE INDEX idx_audit_workspace ON audit_events(workspace_id, created_at DESC);

-- ============================================================
-- DRAFT EDIT SIGNALS (learning loop — Phase 2 recording only)
-- ============================================================
CREATE TABLE draft_edit_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  draft_id UUID NOT NULL REFERENCES drafts(id),
  staff_action TEXT NOT NULL,                         -- 'sent_as_is', 'edited_and_sent', 'regenerated', 'discarded'
  original_draft TEXT NOT NULL,
  final_version TEXT,
  intent_classified TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MESSAGE TEMPLATES (WhatsApp pre-approved templates)
-- ============================================================
CREATE TABLE message_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  category TEXT NOT NULL,                             -- 'confirmation', 'reminder', 'follow_up', 'general'
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  whatsapp_template_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',               -- 'draft', 'submitted', 'approved', 'rejected'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 9.2 RLS policies (applied to all tables)

```sql
-- Helper function: get workspace_id for authenticated user
CREATE OR REPLACE FUNCTION get_user_workspace_id(user_id UUID)
RETURNS UUID AS $$
  SELECT workspace_id FROM staff WHERE id = user_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Apply RLS to every table (example for clients)
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON clients
  FOR ALL USING (workspace_id = get_user_workspace_id(auth.uid()))
  WITH CHECK (workspace_id = get_user_workspace_id(auth.uid()));

-- Repeat for: conversations, messages, drafts, bookings, notes,
-- follow_ups, memories, knowledge_chunks, proposed_actions,
-- draft_edit_signals, message_templates

-- Special: audit_events is INSERT-only for service role
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff_read_own_workspace" ON audit_events
  FOR SELECT USING (workspace_id = get_user_workspace_id(auth.uid()));
-- No INSERT/UPDATE/DELETE policy for staff — only service role writes audit events
```

---

## 10. Conversation state machine

```
                     +--------+
            +------->|  idle  |<-------+
            |        +---+----+        |
            |            | inbound     | staff resolves /
            |            | message     | booking confirmed
            |            v             |
            |   +--------------------+ |
            |   | awaiting_staff_    | |
            +---| review             |-+
       staff    +----+---------------+
       discards      | staff sends reply
                     v
            +--------------------+
            | awaiting_client_   |
            | reply              |
            +----+----------+---+
                 |           | timeout (24h)
                 |           v
                 |   +------------------+
                 |   | follow_up_       |
                 |   | pending          |----> daily cron queues
                 |   +------------------+      follow-up draft
                 |
                 | client replies with booking intent
                 v
            +--------------------+
            | booking_in_        |
            | progress           |
            +----+----------+---+
                 |           | timeout (24h)
                 |           v
                 |   +------------------+
                 |   | follow_up_       |
                 |   | pending          |
                 |   +------------------+
                 |
                 | booking confirmed
                 v
            +--------+
            |  idle  |
            +--------+
```

State transitions are validated by deterministic code, not by the LLM:

```typescript
const TRANSITIONS: Record<string, Record<string, string>> = {
  idle: {
    inbound_message: 'awaiting_staff_review',
  },
  awaiting_staff_review: {
    staff_sends: 'awaiting_client_reply',
    staff_discards: 'idle',
  },
  awaiting_client_reply: {
    inbound_message: 'awaiting_staff_review',
    timeout_24h: 'follow_up_pending',
  },
  follow_up_pending: {
    followup_draft_ready: 'awaiting_staff_review',
    staff_resolves: 'idle',
  },
  booking_in_progress: {
    inbound_message: 'awaiting_staff_review',
    booking_confirmed: 'idle',
    timeout_24h: 'follow_up_pending',
  },
};

function transitionState(current: string, event: string): string {
  const next = TRANSITIONS[current]?.[event];
  if (!next) throw new Error(`Invalid transition: ${current} + ${event}`);
  return next;
}
```

---

## 11. Daily cron operations

The daily cron runs per workspace, timed to each workspace's timezone (e.g., 6 AM local time). It is a Supabase Edge Function triggered by pg_cron.

### 11.1 Compaction

For each client with message activity since the last compaction:

1. Check that all pending note extractions are complete (flush-before-compact).
2. Load existing compact summary + messages since last compaction.
3. LLM call (cheap model: Haiku or GPT-4o-mini) to generate updated compact summary.
4. Write new `memories` record (type: `compact_summary`, version N+1).
5. Update `clients.summary` with latest text.

### 11.2 Follow-up surfacing

Query all follow-ups with `status = 'open'` and `due_date <= today`. Update status to `overdue`. For each overdue follow-up, queue a `process-message` invocation (with a synthetic "follow-up needed" trigger) so the Client Worker generates a follow-up draft with full per-client context.

### 11.3 Inactivity detection

Query clients where `last_contacted_at < now() - interval '30 days'` and `lifecycle_status != 'inactive'`. Update to `inactive`.

### 11.4 Booking confirmation

Query bookings where `start_time` is within the next 24-48 hours and `confirmation_status = 'pending'`. Queue follow-up drafts for staff to send confirmation messages.

### 11.5 MVP: no COS LLM call

The previous architecture specified a COS (Chief of Staff) as a separate LLM invocation for cross-client operations. For MVP, this is unnecessary. The daily cron surfaces items via SQL queries and displays them in the "Today's View" page. The Client Worker handles follow-up draft generation with per-client context.

The COS can be added later if staff needs natural language queries across clients ("who needs follow-up today?" answered by LLM rather than a fixed query).

---

## 12. Deployment architecture

### 12.1 Infrastructure

```
+-----------------------------------+
|          Vercel                    |
|                                    |
|  Next.js App (App Router)         |
|  - Staff web app (React/RSC)      |
|  - API routes (webhook proxy)     |
|  - Static assets + CDN            |
|                                    |
|  Environment variables:            |
|  - NEXT_PUBLIC_SUPABASE_URL       |
|  - NEXT_PUBLIC_SUPABASE_ANON_KEY  |
|  - SUPABASE_SERVICE_ROLE_KEY      |
|  - STRIPE_SECRET_KEY              |
|  - STRIPE_WEBHOOK_SECRET          |
+-----------------------------------+
              |
              v
+-----------------------------------+
|         Supabase Project          |
|                                    |
|  PostgreSQL                        |
|  - Application tables (RLS)       |
|  - pgvector extension             |
|  - pg_cron extension              |
|  - message_queue table            |
|                                    |
|  Edge Functions (Deno)             |
|  - whatsapp-webhook               |
|  - process-message                 |
|  - send-message                    |
|  - approve-action                  |
|  - daily-cron                      |
|  - embed-knowledge                 |
|                                    |
|  Auth                              |
|  Storage                           |
|  Realtime                          |
|                                    |
|  Secrets:                          |
|  - LLM_API_KEY                     |
|  - GOOGLE_CALENDAR_CLIENT_SECRET   |
|  - WHATSAPP_APP_SECRET             |
+-----------------------------------+
```

### 12.2 Deployment workflow

1. **Database migrations:** Managed via Supabase CLI (`supabase db push` or migration files). Run before deploying code.
2. **Edge Functions:** Deployed via `supabase functions deploy`. Each function is a separate deployment unit.
3. **Next.js app:** Deployed to Vercel via Git push. Auto-deploys on merge to `main`.
4. **Environment variables:** Set in Vercel dashboard (for Next.js) and Supabase dashboard (for Edge Functions).

### 12.3 Development environment

- **Local Supabase:** `supabase start` runs a local Postgres + Auth + Storage + Edge Functions.
- **WhatsApp sandbox:** Meta provides a test phone number for development. Use ngrok or Vercel preview deployments for webhook URL.
- **LLM:** Direct API calls to Claude/OpenAI. No local model needed.

### 12.4 Monitoring (MVP)

| What | How |
|---|---|
| Edge Function errors | Supabase dashboard logs |
| LLM call latency and cost | Log to `audit_events` table with metadata: `{ tokens_in, tokens_out, latency_ms, cost_usd }` |
| Message queue health | pg_cron job that alerts if `pending` messages > 50 or oldest pending > 5 minutes |
| Application errors | Vercel function logs |
| Uptime | Supabase built-in health checks |

Defer: Langfuse, Sentry, or external monitoring. Add when you have paying customers.

---

## 13. Codebase structure (MVP)

```
/
+-- supabase/
|   +-- migrations/
|   |   +-- 001_initial_schema.sql
|   |   +-- 002_rls_policies.sql
|   |   +-- 003_functions.sql
|   +-- functions/
|   |   +-- whatsapp-webhook/
|   |   |   +-- index.ts
|   |   +-- process-message/
|   |   |   +-- index.ts
|   |   +-- send-message/
|   |   |   +-- index.ts
|   |   +-- approve-action/
|   |   |   +-- index.ts
|   |   +-- daily-cron/
|   |   |   +-- index.ts
|   |   +-- embed-knowledge/
|   |   |   +-- index.ts
|   |   +-- _shared/
|   |       +-- context-assembly.ts     # assembleContext() pure function
|   |       +-- agent-runtime.ts        # LLM call + tool loop
|   |       +-- tool-registry.ts        # tool definitions + schemas
|   |       +-- tool-executor.ts        # param injection + execution
|   |       +-- approval-policy.ts      # tier classification
|   |       +-- phone-utils.ts          # E.164 normalization
|   |       +-- whatsapp-client.ts      # Meta Cloud API client
|   |       +-- llm-client.ts           # LLM provider SDK wrapper
|   |       +-- types.ts               # shared TypeScript types
|   |       +-- db.ts                  # Supabase client factory
|   +-- seed.sql                       # test data
|   +-- config.toml
|
+-- src/                               # Next.js app
|   +-- app/
|   |   +-- layout.tsx
|   |   +-- page.tsx                   # redirect to /inbox
|   |   +-- (auth)/
|   |   |   +-- login/page.tsx
|   |   +-- (dashboard)/
|   |   |   +-- layout.tsx             # sidebar, nav, auth guard
|   |   |   +-- inbox/
|   |   |   |   +-- page.tsx           # conversation list
|   |   |   |   +-- [conversationId]/
|   |   |   |       +-- page.tsx       # client thread + draft review
|   |   |   +-- today/
|   |   |   |   +-- page.tsx           # today's view
|   |   |   +-- clients/
|   |   |   |   +-- page.tsx           # client list
|   |   |   |   +-- [clientId]/
|   |   |   |       +-- page.tsx       # client profile
|   |   |   +-- settings/
|   |   |       +-- page.tsx           # workspace settings
|   |   |       +-- knowledge/page.tsx
|   |   |       +-- tone/page.tsx
|   |   |       +-- calendar/page.tsx
|   |   |       +-- billing/page.tsx
|   |   +-- api/
|   |       +-- webhooks/
|   |           +-- stripe/route.ts    # Stripe webhook handler
|   +-- components/
|   |   +-- inbox/
|   |   +-- thread/
|   |   +-- draft/
|   |   +-- client/
|   |   +-- today/
|   |   +-- settings/
|   |   +-- ui/                        # shared UI components
|   +-- lib/
|   |   +-- supabase/
|   |   |   +-- client.ts             # browser Supabase client
|   |   |   +-- server.ts             # server-side Supabase client
|   |   |   +-- middleware.ts          # auth middleware
|   |   +-- stripe.ts
|   |   +-- types.ts                   # database types (generated)
|   +-- hooks/
|       +-- use-realtime.ts            # Supabase Realtime subscription
|       +-- use-conversations.ts
|       +-- use-client.ts
|
+-- package.json
+-- tsconfig.json
+-- next.config.ts
```

Key principle: **no shared code between Edge Functions and Next.js app.** The Edge Functions (Deno runtime) and Next.js app (Node.js runtime) have separate dependency trees. Types can be duplicated or generated from the database schema. This avoids cross-runtime compatibility issues.

---

## 14. Stripe integration

### 14.1 Subscription model

| Plan | Features | Limits |
|---|---|---|
| Free / Trial | Full features, 14-day trial | 100 AI-processed messages |
| Pro | Full features | 1,000 messages/month, 1 workspace |
| Growth | Full features + priority support | 5,000 messages/month, unlimited workspaces |

### 14.2 Implementation

- **Checkout:** Stripe Checkout Session created from settings page. Redirect to Stripe-hosted checkout.
- **Billing portal:** Stripe Customer Portal for plan changes, payment method updates, invoices.
- **Webhook:** `POST /api/webhooks/stripe` handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Updates `workspaces.subscription_status`.
- **Usage tracking:** Increment a counter in the workspace record for each AI-processed message. Check against plan limit before processing. If over limit, queue message but skip LLM call, notify staff.
- **Metering (future):** Report usage to Stripe for usage-based billing. Deferred for MVP (flat plans).

---

## 15. WhatsApp integration details

### 15.1 24-hour conversation window

When staff sends a message, the system checks `conversations.last_client_message_at`. If more than 24 hours have passed since the last client-initiated message, the conversation window is closed.

- **Window open:** Send freeform message via WhatsApp Cloud API.
- **Window closed:** Must use a pre-approved template message. The system matches the draft content to an available template. If no template matches, the send is blocked and staff is notified.

### 15.2 Template management

Templates are registered with Meta via the WhatsApp Business Manager. The `message_templates` table tracks local copies with their approval status. MVP ships with 3-5 templates:

1. `appointment_reminder` -- "Hi {name}, this is a reminder for your {appointment_type} on {date} at {time}."
2. `follow_up` -- "Hi {name}, just checking in. {custom_message}"
3. `booking_confirmation` -- "Hi {name}, your {appointment_type} is confirmed for {date} at {time}."

### 15.3 Webhook verification

```typescript
function verifyWebhookSignature(
  body: string,
  signature: string,
  appSecret: string
): boolean {
  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(body)
    .digest('hex');
  return `sha256=${expected}` === signature;
}
```

### 15.4 Media handling

| Media type | Processing | Storage |
|---|---|---|
| Voice notes | Transcribed via Whisper before context assembly. Transcription stored in `messages.media_transcription`. | Supabase Storage |
| Images | Downloaded from Meta CDN. Stored. Passed to multimodal LLM in Client Worker call. | Supabase Storage |
| Documents (PDF, etc.) | Stored. Displayed to staff. Not processed by AI. | Supabase Storage |
| Location, contacts, stickers | Stored as metadata. Agent generates acknowledgment. | Database (JSONB in messages) |

---

## 16. Verification questions and answers

### Q1: Can the Postgres-backed message queue handle the required throughput without Redis/BullMQ?

**Answer:** Yes, for MVP scale. `FOR UPDATE SKIP LOCKED` is a well-established pattern for Postgres-backed queues. At 100 messages/day per workspace and 10 workspaces, that is about 1,000 messages/day or roughly 1 message per minute on average. Postgres handles this trivially. The advisory lock pattern (`pg_advisory_xact_lock`) ensures per-client ordering. If throughput exceeds ~1,000 messages per hour sustained, migrate to a dedicated queue (BullMQ + Redis). This is a straightforward refactor because the queue interface is encapsulated in the `process-message` function.

### Q2: Will Supabase Edge Functions hit timeout limits during LLM processing?

**Answer:** This is the primary risk. Supabase Edge Functions have a 60-second timeout on the free tier and 150 seconds on Pro. A typical Client Worker invocation includes: context assembly (~200ms for DB queries) + LLM call (~5-15 seconds for Sonnet/4o with tool calling, possibly 2-3 tool calls at ~3s each) + result saving (~100ms). Total: ~10-25 seconds in the normal case. This fits within the 60-second limit. However, if the LLM call is slow (cold start, high load), it could approach the limit. Mitigation: set a 45-second timeout on the LLM call itself. If it times out, save the message for retry with a note about the timeout. The retry cron picks it up. If Edge Function timeouts become a persistent problem, move `process-message` to a Vercel serverless function (which has a 300-second timeout on Pro) or a dedicated server.

### Q3: Does the "synchronous chaining" of webhook to process-message create reliability issues?

**Answer:** Yes, there is a subtle issue. If `whatsapp-webhook` calls `process-message` synchronously and `process-message` takes 20 seconds, the webhook function is also occupied for 20 seconds. If Meta sends another webhook during this time, it may queue or timeout. **Revised approach:** The webhook function should NOT synchronously call `process-message`. Instead, it should enqueue and return 200 immediately. Processing is triggered by pg_cron polling every 5 seconds OR by using Supabase's `pg_net` extension to make an async HTTP call to the `process-message` Edge Function. This decouples webhook acknowledgment from processing. This was corrected in section 8.3.

### Q4: How does the system handle a workspace with no Google Calendar connected?

**Answer:** The PRD specifies progressive enhancement (section 15.3). If no calendar is connected: the `calendar_query` and `calendar_book` tools are excluded from the tool registry for that workspace's Client Worker invocations. The LLM is told in its system prompt: "Calendar is not connected. Do not offer to check availability or book appointments. Instead, suggest the client coordinates scheduling directly with staff." When the workspace owner connects Google Calendar later, the tools become available in subsequent invocations. No code change needed -- tool availability is determined at context assembly time based on workspace config.

### Q5: Is the separation of Edge Functions (Deno) and Next.js (Node.js) a problem for shared types?

**Answer:** It requires discipline but is manageable. Options: (a) Generate TypeScript types from the Supabase schema using `supabase gen types typescript` and use these in both codebases. (b) Define types manually in both `supabase/functions/_shared/types.ts` and `src/lib/types.ts` and keep them in sync. (c) Use a shared `types` package in a monorepo with TypeScript-only types (no runtime dependencies). For MVP, option (a) is recommended -- auto-generate from the database schema. The generated types file can be committed and imported by both Edge Functions and the Next.js app. If a type needs to exist that does not map to a database table, define it in both places with a comment referencing the canonical definition.

---

## 17. Revisions from verification

Based on the verification questions above, the following changes were made to the architecture:

1. **Section 8.3 (Processing trigger) revised:** Changed from synchronous chaining to async invocation. The webhook function enqueues and returns immediately. Processing is triggered by `pg_net` async HTTP call to the processing Edge Function, with pg_cron polling as a safety net. This prevents the webhook function from being blocked during LLM processing.

2. **Section 6.3 (Tool inventory) clarified:** Added note that tool availability is dynamic per workspace. If Google Calendar is not connected, calendar tools are excluded from the tool registry for that workspace's invocations.

3. **Section 12.4 (Monitoring) added:** Added LLM cost tracking to `audit_events` metadata. This is cheap to implement (just log token counts) and critical for cost management.

4. **Section 15 (WhatsApp) expanded:** Added media handling details that were implied but not explicit.

5. **Section 3.1 (Edge Functions) added timeout guidance:** Noted the 60s/150s timeout limits and the mitigation strategy.

---

## 18. Architecture decision records (ADRs)

### ADR-1: Postgres queue over BullMQ + Redis

**Context:** The previous architecture specified BullMQ + Redis for message queuing. This adds Redis as infrastructure to manage.
**Decision:** Use a Postgres `message_queue` table with `FOR UPDATE SKIP LOCKED` for MVP.
**Why:** Eliminates Redis as a dependency. Postgres is already in the stack. The throughput requirement (~1 msg/min) is trivial for Postgres. Durable by default (it is just a table).
**Tradeoff:** Less sophisticated than BullMQ (no built-in delayed jobs, no priority queues, no worker groups). These features are not needed for MVP.
**Reversal trigger:** Sustained throughput > 1,000 messages/hour or need for delayed/scheduled message processing beyond what pg_cron provides.

### ADR-2: Next.js + Edge Functions over separate API server

**Context:** The previous architecture specified Fastify as a separate API server.
**Decision:** Use Next.js API routes (for Stripe webhooks and staff app API) and Supabase Edge Functions (for WhatsApp processing and server-side logic).
**Why:** One deployment target (Vercel). No separate server to deploy, monitor, or scale. Edge Functions handle the latency-sensitive webhook processing. Next.js handles the staff app and Stripe integration.
**Tradeoff:** Edge Functions run in Deno (not Node.js). Some npm packages may not be available. The team must maintain two TypeScript environments.
**Reversal trigger:** Edge Function limitations become blocking (timeout, package availability, debugging).

### ADR-3: Flat module structure over DDD bounded contexts

**Context:** The previous architecture specified 7 bounded contexts with domain/application/infrastructure layers.
**Decision:** Use a flat module structure. Shared code in `_shared/` for Edge Functions. Standard Next.js app directory for the web app.
**Why:** Solo founder. DDD ceremony adds cognitive overhead without proportional benefit at this team size. The domain is small enough that a flat structure remains navigable.
**Tradeoff:** Harder to enforce module boundaries. Risk of spaghetti as codebase grows.
**Reversal trigger:** Team grows to 3+ engineers and module boundaries need explicit enforcement.

### ADR-4: No COS LLM call for MVP

**Context:** The previous architecture specified a COS (Chief of Staff) as a separate LLM invocation for cross-client operations.
**Decision:** The daily cron surfaces follow-ups, overdue items, and at-risk bookings via SQL queries. The "Today's View" is a database query, not an LLM call. Follow-up drafts are generated by the Client Worker (same path as normal message processing).
**Why:** For a single-operator MVP, the staff knows their clients. A ranked list from a database query is sufficient. The COS LLM call adds cost and complexity without clear value at this scale.
**Tradeoff:** No natural language "who needs follow-up today?" interface. Staff uses the Today's View page instead.
**Reversal trigger:** Staff requests conversational cross-client queries, or the number of clients per workspace exceeds what a human can scan in a list.

### ADR-5: Direct LLM SDK over abstraction layer

**Context:** The previous architecture specified OpenRouter as an LLM gateway for model flexibility.
**Decision:** Use the LLM provider's TypeScript SDK directly (e.g., `@anthropic-ai/sdk` or `openai`).
**Why:** Fewer dependencies. No abstraction layer to maintain. MVP uses one model. Switching models later is a small refactor of the `llm-client.ts` module.
**Tradeoff:** Switching LLM providers requires code changes to the client module.
**Reversal trigger:** Need to run multiple models simultaneously or implement automatic fallback between providers.

### ADR-6: Async webhook processing via pg_net

**Context:** The webhook must return 200 to Meta within 5 seconds. LLM processing takes 10-25 seconds.
**Decision:** The webhook function enqueues the message and returns 200 immediately. It then triggers processing asynchronously using Supabase's `pg_net` extension (async HTTP call to the processing Edge Function). pg_cron polls every 30 seconds as a safety net.
**Why:** Decouples webhook acknowledgment from processing. Prevents webhook timeouts. Handles bursts gracefully.
**Tradeoff:** Slightly more complex than synchronous processing. Small latency increase (~5 seconds from pg_cron in worst case).

---

## 19. What this architecture does NOT cover (deferred)

| Capability | Why deferred | When to build |
|---|---|---|
| Multi-staff accounts and RBAC | MVP is single operator per workspace | When a workspace needs 2+ staff |
| Learning loop analysis (Phase 4) | Need signal data first | After 500+ draft edit signals collected |
| COS LLM invocation | SQL queries sufficient for MVP | When staff requests cross-client NL queries |
| Multi-channel (Instagram, SMS) | WhatsApp is the primary channel | After WhatsApp flow is proven |
| Notion sync | Optional export, not critical | When a customer requests it |
| Performance dashboard | Need operational data first | After 30+ days of operation |
| Auto-send (conditional) | Trust model requires all drafts staff-reviewed in MVP | After measuring draft acceptance > 90% |
| Read replicas | Single Supabase instance handles MVP scale | When query latency exceeds targets |
| External monitoring (Sentry, Langfuse) | Supabase/Vercel logs sufficient for MVP | When debugging becomes painful |
| GDPR consent management | Legal requirements vary by market | Before EU launch |

---

## 20. Implementation phases

### Phase 1: Core messaging + onboarding (Weeks 1-3)

- Supabase project setup, schema migration, RLS policies
- WhatsApp webhook handler (receive, deduplicate, enqueue)
- Phone normalization + client find-or-create
- Message storage and conversation tracking
- Basic staff app: inbox, conversation thread (no AI yet)
- Supabase Auth + staff login
- Push notifications (web push)
- Stripe checkout + subscription management
- Onboarding flow (business identity, Instagram scrape, SOP generation)

### Phase 2: AI drafting + booking (Weeks 4-6)

- Context assembly function
- Client Worker runtime (LLM + tool loop)
- Tool implementations (knowledge_search, calendar_query, calendar_book, update_client, create_note, create_followup)
- Approval boundary + confirmation cards
- Draft review UX (edit, send, reprompt)
- Knowledge base embedding (pgvector)
- Google Calendar integration (OAuth, availability, event creation)
- Draft edit signal recording (learning loop Phase 2)
- Voice note transcription
- Audit logging

### Phase 3: Operational memory + follow-ups (Weeks 7-8)

- Daily compaction cron
- Follow-up surfacing and overdue detection
- Today's View page
- Inactivity detection
- Booking confirmation flow
- Async note categorization
- Conversation state machine timeouts

### Phase 4: Refinement (Weeks 9+)

- Learning loop analysis (diff classification, recurrence, rule promotion)
- Communication rules in context assembly
- Settings page for learned rules
- Performance metrics (draft acceptance rate, booking conversion)
- COS operations (if needed)

---

## Appendix A: Key type definitions

```typescript
// Tool authority levels
type ToolAuthority = 'read' | 'auto_write' | 'propose_write';

// Tool definition
type ToolDefinition = {
  name: string;
  description: string;
  authority: ToolAuthority;
  schema: ZodSchema;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
};

// Tool result
type ToolResult =
  | { type: 'data'; data: unknown }           // read tools
  | { type: 'written'; id: string }           // auto_write tools
  | { type: 'proposed'; action: ProposedAction }; // propose_write tools

// Conversation events
type ConversationEvent =
  | 'inbound_message'
  | 'staff_sends'
  | 'staff_discards'
  | 'timeout_24h'
  | 'followup_draft_ready'
  | 'staff_resolves'
  | 'booking_confirmed';

// Vertical configuration
type VerticalConfig = {
  customFields: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'date' | 'boolean' | 'enum';
    enumValues?: string[];
    required: boolean;
    group?: string;
  }>;
  appointmentTypes: Array<{
    key: string;
    label: string;
    durationMinutes: number;
    bufferMinutes: number;
    prerequisite?: string;
  }>;
  lifecycleStages?: Array<{
    key: string;
    label: string;
    description: string;
  }>;
  sopRules?: string[];
};

// Client Worker output
type ClientWorkerResult = {
  draft: {
    content: string;
    intentClassified: string;
    confidenceScore: number;
    knowledgeSources: string[];
  } | null;  // null if human_only escalation
  proposedActions: ProposedAction[];
  toolCallLog: Array<{
    toolName: string;
    params: Record<string, unknown>;
    result: unknown;
    durationMs: number;
  }>;
  tokenUsage: {
    input: number;
    output: number;
    totalCostUsd: number;
  };
};
```

---

## Appendix B: Webhook payload handling

The WhatsApp Cloud API sends different payload structures for different event types. The webhook handler must route accordingly:

```typescript
// Simplified webhook routing
function handleWebhook(payload: WhatsAppWebhookPayload) {
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.value.messages) {
        // Inbound message — enqueue for AI processing
        for (const message of change.value.messages) {
          enqueueMessage(message, change.value.metadata);
        }
      }
      if (change.value.statuses) {
        // Delivery status update — update message record
        for (const status of change.value.statuses) {
          updateDeliveryStatus(status);
        }
      }
    }
  }
}
```
