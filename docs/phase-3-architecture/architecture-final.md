# Architecture Specification -- WhatsApp-First AI Client Ops Manager

**Version:** 1.2 (Final, Baileys integration)
**Date:** March 2026
**Status:** Approved architecture -- pragmatic MVP-first
**Companion:** PRD v2.1
**Base:** Solution C (score 4.2/5.0), polished with cherry-picks from A and B, updated to use Baileys (WhatsApp Web protocol) per PRD owner decision.

---

## 0. Design philosophy

This architecture is designed for a solo founder shipping fast. Every decision optimizes for:

1. **Fewer moving parts.** One Supabase project + one Vercel app + one Baileys server (Railway). No Redis, no BullMQ.
2. **Ship in weeks, not months.** Use managed services for everything. Write custom code only for domain logic.
3. **Correct by construction.** Session isolation, approval boundaries, and audit logging are structural -- not bolted on later.
4. **Defer what you can.** Learning loop analysis, multi-staff RBAC, COS LLM calls, and performance dashboards are designed for but not built in MVP.

### What changed from the previous architecture draft

| Previous draft | This proposal | Why |
|---|---|---|
| BullMQ + Redis message queue | `pgmq` extension (Supabase-native) | Eliminates Redis infrastructure. Built-in visibility timeout, dead letter queue, and archive semantics. Less custom SQL than a raw queue table. |
| Fastify separate API server | Next.js API routes + Supabase Edge Functions + Baileys server (Railway) | Next.js for staff app, Edge Functions for AI processing, Baileys server for WhatsApp connectivity. |
| WhatsApp Cloud API (webhooks) | Baileys / WhatsApp Web protocol (QR pairing) | Access existing WhatsApp account. No WABA needed. Full conversation history. Free messaging. Per PRD owner decision. |
| 7 bounded contexts with clean architecture layers | Flat module structure with collocated files | Solo founder. DDD ceremony slows you down. Refactor when the team grows. |
| COS as separate LLM invocation path | Database queries + simple aggregation | For MVP single-operator, "today's view" is a SQL query, not an LLM call. |
| Optimistic locking with version fields | Advisory locks via `pg_advisory_xact_lock` on processing | Simpler. Message ordering handled by queue + single-worker-per-client. |
| Learning optimization fully specified | Signal recording only (Phase 2). Analysis deferred. | Record the data now. Build the analysis when you have enough signals. |
| Direct provider SDK | OpenRouter with OpenAI-compatible SDK | OpenRouter provides model flexibility, unified billing, and works well in Deno Edge Functions. Owner decision. |
| Custom `message_queue` table with `FOR UPDATE SKIP LOCKED` | `pgmq` extension | pgmq provides queue semantics (visibility timeout, DLQ, archive) out of the box. Less custom code, better-tested edge cases. (Cherry-picked from Solution A.) |
| `get_user_workspace_id()` returning single UUID | `auth.workspace_id()` returning single UUID, future-proofed signature | Cleaner API, consistent naming, documented path to multi-workspace. (Cherry-picked from Solution A.) |

---

## 1. System diagram

```
+------------------------------------------------------------------+
|                     RAILWAY (Baileys Server)                       |
|                                                                    |
|  +------------------------------------------------------------+   |
|  | Node.js — @whiskeysockets/baileys v6+                       |   |
|  |                                                              |   |
|  | - Persistent WebSocket to WhatsApp (multi-device protocol)  |   |
|  | - QR code pairing (staff scans during onboarding)           |   |
|  | - Auth state persisted to Supabase (credentials table)      |   |
|  | - On inbound message:                                       |   |
|  |     1. Save raw message to Supabase messages table          |   |
|  |     2. Enqueue to pgmq (inbound_msgs)                      |   |
|  |     3. (Realtime fires: staff sees message immediately)     |   |
|  | - On send request (from Edge Function / API):               |   |
|  |     Send via Baileys socket (no 24h window restriction)     |   |
|  | - Health check endpoint for monitoring                      |   |
|  | - Auto-reconnect on disconnect                              |   |
|  +------------------------------------------------------------+   |
+------------------------------------------------------------------+
        |                                       ^
        | INSERT messages + pgmq enqueue        | HTTP: /send, /status
        v                                       |
+------------------------------+----------------+-----------------+
|                        SUPABASE PROJECT                         |
|                                                                 |
|                             +-------------------------------+   |
|                             | Edge Function:                |   |
|                             | process-message               |   |
|                             |                                |   |
|                             | - Dequeue from pgmq           |   |
|                             | - Phone normalization         |   |
|                             | - Client find-or-create       |   |
|                             | - Context assembly            |   |
|                             | - LLM invocation (1 call)     |   |
|                             | - Tool execution loop         |   |
|                             | - Approval policy eval        |   |
|                             | - Save draft + proposed actions|   |
|                             |   (triggers Realtime: draft)  |   |
|                             | - Log LLM usage to llm_usage  |   |
|                             +-------------------------------+   |
|                              +-------------------------------+   |
|  +--------------------+     | Edge Function:                |   |
|  | Edge Function:     |     | daily-cron                    |   |
|  | approve-action     |     |                                |   |
|  |                    |     | - Compaction (per client)     |   |
|  | - Execute approved |     | - Follow-up surfacing         |   |
|  |   ProposedAction   |     | - Inactivity detection        |   |
|  | - Audit log        |     | - Queue follow-up drafts      |   |
|  +--------------------+     +-------------------------------+   |
|                                                                  |
|  +--------------------+     +-------------------------------+   |
|  | Edge Function:     |     | PostgreSQL (Supabase)         |   |
|  | embed-knowledge    |     |                                |   |
|  |                    |     | - All tables (RLS-protected)  |   |
|  | - Chunk text       |     | - pgvector (knowledge search) |   |
|  | - Generate embeds  |     | - pgmq (message queue)        |   |
|  | - Upsert chunks   |     | - pg_cron (scheduled jobs)    |   |
|  +--------------------+     | - Realtime subscriptions      |   |
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
        | (new messages, drafts, actions)       | (approve, send, CRUD)
        v                                       |
+------------------------------------------------------------------+
|                     VERCEL (Next.js App Router)                   |
|                                                                   |
|  +---------------------------+  +-----------------------------+   |
|  | Staff Web App (React)     |  | API Routes                  |   |
|  |                           |  |                              |   |
|  | - Inbox view              |  | /api/webhooks/stripe        |   |
|  | - Client thread + draft   |  |   (subscription management) |   |
|  | - Today's view            |  |                              |   |
|  | - Client profile          |  +-----------------------------+   |
|  | - Settings                |                                    |
|  | - Approval cards          |                                    |
|  +---------------------------+                                    |
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
   - Verify X-Hub-Signature-256 (HMAC-SHA256) using SubtleCrypto
   - Extract message from webhook payload
   - Deduplicate by wamid (INSERT to message_inbox ON CONFLICT DO NOTHING)
   - Enqueue to pgmq: pgmq.send('inbound_messages', payload)
   - RETURN 200 immediately (< 500ms to avoid Meta retries)
        |
        v
4. Edge Function: process-message (triggered by pg_net async call or pg_cron poll)
   - pgmq.read('inbound_messages', vt := 60, qty := 1)
   - Acquire advisory lock: pg_try_advisory_lock(hashtext(session_key))
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
   ** This INSERT triggers Supabase Realtime -- staff sees
      "new message" notification within ~1 second (BEFORE AI processing).
   ** workspace_id is denormalized on messages for Realtime filtering.
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
   - User message = inbound message text (truncated to 2000 chars max)
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
    - workspace_id denormalized for Realtime filtering
    ** This INSERT triggers Supabase Realtime -- staff sees
       "draft ready" notification (~5-15 seconds after message).
        |
        v
12. Log LLM usage
    - INSERT into llm_usage: tokens_in, tokens_out, latency_ms, model, cost_usd
        |
        v
13. Update conversation state -> 'awaiting_staff_review'
        |
        v
14. Archive pgmq message: pgmq.archive('inbound_messages', msg_id)
```

**Dual notification pattern (cherry-picked from Solution B):** Staff receives two distinct Realtime events per inbound message:
1. **Immediate "message received"** -- triggered by the `messages` INSERT (step 6, before AI processing). Latency: < 1 second from WhatsApp webhook.
2. **"Draft ready"** -- triggered by the `drafts` INSERT (step 11, after AI processing). Latency: 5-15 seconds.

This ensures staff sees incoming messages within seconds, even while the LLM processes. Both events work through Supabase Realtime with no additional infrastructure because `workspace_id` is denormalized on both tables for filtering.

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
     ** Rate limited: max 5 reprompts per conversation per hour
   - Option D: Discard -> record 'discarded', handle manually
        |
        v
3. On send:
   - Check 24-hour conversation window
     - Window open: send freeform message via WhatsApp API
     - Window closed: match to approved template, send template
     - No template: block send, notify staff
   - Store outbound message (workspace_id denormalized)
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

### 3.1 Baileys Server (Railway — persistent Node.js process)

A dedicated Node.js server running `@whiskeysockets/baileys` v6+ that maintains the WhatsApp Web socket connection. This is the only persistent server in the stack.

| Responsibility | Details |
|---|---|
| **WhatsApp connectivity** | Maintain WebSocket connection to WhatsApp per workspace. Auto-reconnect on disconnect. |
| **QR code pairing** | Generate QR codes during onboarding. Stream to staff app via SSE. |
| **Inbound messages** | Receive via Baileys event listener. Save to `messages` table. Enqueue to pgmq. |
| **Outbound messages** | Send via Baileys socket when called by staff app (HTTP POST /send). |
| **Auth state** | Persist Baileys credentials to `baileys_auth` table in Supabase. Restore on restart. |
| **Delivery receipts** | Update `messages.delivery_status` on receipt events. |
| **Health monitoring** | HTTP `/health` endpoint for Railway health checks. |

**Deployment:** Docker on Railway ($5/mo hobby, $20/mo pro). Always-on process. Autorestart on crash.

### 3.2 Supabase Edge Functions

Deno-based serverless functions for AI processing and business logic. WhatsApp connectivity is handled by the Baileys server (3.1), not by Edge Functions.

| Function | Responsibility | Trigger | Latency target |
|---|---|---|---|
| `process-message` | Dequeue from pgmq, run full pipeline (context assembly, LLM call, tool loop, approval eval, save draft, log LLM usage) | pg_net async call from pgmq trigger or pg_cron poll | < 30s total |
| `approve-action` | Execute a staff-approved ProposedAction, write to database, audit log | Called from staff app | < 1s |
| `daily-cron` | Run compaction, surface follow-ups, detect inactivity, queue follow-up drafts | pg_cron (daily per workspace timezone) | < 5 min total |
| `embed-knowledge` | Chunk text, generate embeddings, upsert to knowledge_chunks | Called when knowledge base updated | < 30s per document |

**Note:** Reduced from 6 to 4 Edge Functions. `whatsapp-webhook` and `send-message` are replaced by the Baileys server. The Baileys server handles message ingestion and sending directly.

**Runtime note:** Edge Functions run in Deno. The free tier has a 60-second timeout; Pro tier has 150 seconds. The LLM call is the bottleneck (~5-15 seconds typically). If the function times out, the pgmq visibility timeout (60 seconds) expires and the message becomes available for retry automatically.

### 3.3 Next.js App (Vercel)

The staff-facing web application. Mobile-first responsive. PWA-capable.

| Module | Responsibility |
|---|---|
| **Inbox page** | List conversations sorted by recency/priority. Unread badges. Filter by conversation state. Real-time updates via Supabase Realtime subscription (dual notification: message received + draft ready). |
| **Client thread page** | Conversation history. AI draft review panel (edit, send, reprompt with rate limit). Client snapshot sidebar (profile, bookings, notes, follow-ups, custom fields). Approval cards for pending actions. |
| **Today's view page** | Today's appointments. Pending follow-ups. At-risk bookings. Generated by SQL query, not LLM. |
| **Client profile page** | Full client record. Conversation history. All bookings, notes, follow-ups. Custom field editor. |
| **Settings page** | Knowledge base editor + document upload. Tone profile. SOP editor. Calendar connection (Google OAuth). WhatsApp config. Communication rules (view/toggle). Stripe billing portal link. |
| **Onboarding flow** | Step-by-step: business identity, Instagram scrape trigger, SOP review, tone review, calendar connect. |

### 3.4 Supabase services used

| Service | Usage |
|---|---|
| **PostgreSQL** | All application data. RLS for tenant isolation. pgvector for knowledge search. pgmq for durable message queuing. |
| **Auth** | Staff authentication. JWT tokens. RLS policy enforcement. Magic link or email/password. |
| **Realtime** | Push new messages, drafts, and approval requests to staff app. Workspace-scoped channels. Dual notification pattern. |
| **Storage** | Media files (voice notes, images, documents). Bucket per workspace. |
| **Edge Functions** | AI processing and business logic (see 3.2). |
| **pg_cron** | Schedule daily cron jobs. Trigger `process-message` polling as a safety net for retry. |

### 3.5 External services

| Service | Usage |
|---|---|
| **WhatsApp (via Baileys)** | Inbound messages via WebSocket. Outbound sending via Baileys socket. QR code pairing. No Cloud API, no WABA, no Meta fees. |
| **LLM Provider (Claude or OpenAI)** | Chat completions with tool calling for Client Worker. Embeddings for knowledge search. Whisper for voice transcription (if OpenAI). Summarization for daily compaction. |
| **Google Calendar API** | OAuth per workspace. Availability queries. Event CRUD. |
| **Stripe** | Subscription management. Billing portal. Usage-based pricing (message count). Webhook for subscription status changes. |

### 3.6 Postgres extensions required

| Extension | Purpose | Notes |
|---|---|---|
| `pgvector` | Knowledge chunk embedding search | First-class Supabase support. |
| `pgmq` | Durable message queue for inbound processing | Supabase-native extension. Provides visibility timeout, archive, DLQ. |
| `pg_cron` | Scheduled jobs (daily cron, retry polling) | Built into Supabase. |
| `pg_net` | Async HTTP calls from database to Edge Functions | Used to trigger `process-message` after webhook enqueue. |

---

## 4. Scaling approach

### 4.1 MVP scale (Phase 1-2)

The MVP targets 1-10 workspaces, each with up to ~500 clients and ~100 messages/day per workspace.

At this scale, the architecture is intentionally simple:

- **Single Supabase project** serves all tenants (multi-tenant by RLS).
- **Edge Functions** handle all processing. No long-running servers.
- **pgmq** provides reliable ordered processing without Redis. Visibility timeout handles worker failures automatically.
- **No horizontal scaling needed.** Supabase Pro tier handles this comfortably.

### 4.2 Capacity limits and growth triggers

| Metric | MVP capacity | Trigger threshold | Response |
|---|---|---|---|
| Messages/day (all workspaces) | ~1,000 | > 1,000/day sustained | Move message processing to a dedicated worker (Fly.io or Railway) with BullMQ + Redis. The Edge Function becomes a thin enqueue layer. |
| Workspaces | 1-10 | > 50 | Partition cron by workspace. Run compaction jobs in parallel. Consider read replicas. |
| Clients per workspace | ~500 | > 5,000 | Add composite indexes. Consider read replicas. |
| pgmq throughput | ~1 msg/min avg | > 1,000 msgs/hour sustained | Migrate to dedicated queue infrastructure. |
| LLM costs | ~$0.01-0.03/msg | Exceeds budget | Implement per-workspace message caps. Switch to smaller models for simple intents. Cache knowledge search results. |
| Staff app load time | < 2s | > 3s | Paginate client lists. Lazy-load conversation history. |
| Edge Function concurrency | ~10 concurrent | > 100 concurrent | Supabase Pro tier supports 100. Queue absorbs bursts beyond this. |

### 4.3 What is deferred

- **Horizontal scaling** of message processing (BullMQ + Redis). Not needed until ~1,000 msgs/day.
- **Read replicas** for the staff app. Not needed until ~50 workspaces.
- **Table partitioning** on messages. Not needed until ~500K messages per workspace.
- **CDN for media.** Supabase Storage is sufficient for MVP.
- **Multi-region deployment.** Single region is fine for initial markets.
- **Connection pooling configuration.** Supabase manages this at Pro tier.

---

## 5. Security model

### 5.1 Defense in depth (5 layers)

The security model follows a layered approach. Each layer provides independent protection so that a failure in one layer does not compromise the system.

| Layer | Mechanism | What it protects against |
|---|---|---|
| **Layer 1: Network** | TLS everywhere (Supabase, Vercel, WhatsApp API enforce HTTPS). CORS restricted to staff app origin only. | Network eavesdropping, MITM attacks. |
| **Layer 2: Authentication** | Staff: Supabase Auth (JWT). Webhooks: HMAC-SHA256 signature verification. Edge Functions: service role key (stored as Supabase secret). | Unauthorized access, webhook forgery. |
| **Layer 3: Authorization (RLS)** | Row Level Security on every table. `auth.workspace_id()` SQL helper scopes all staff queries to their workspace. | Cross-tenant data access. |
| **Layer 4: Data isolation** | `workspace_id` column on every tenant data table. Application-level `WHERE workspace_id = $1` in all Edge Function queries. Tool parameter injection overrides LLM-provided IDs. | Data leakage across tenants, LLM prompt injection attempting cross-client access. |
| **Layer 5: Audit** | Immutable `audit_events` table (INSERT only, no UPDATE/DELETE). Every mutation logged with actor, action, timestamp, before/after. LLM usage logged to `llm_usage` table. | Accountability, forensics, cost tracking. |

### 5.2 Authentication

- **Staff login:** Supabase Auth with email/password or magic link. JWT tokens with workspace_id claim.
- **WhatsApp webhook:** Verified by HMAC-SHA256 signature using the app secret and Deno's `SubtleCrypto` API. No auth token -- Meta uses signature verification.
- **Service-to-service:** Edge Functions use the Supabase service role key. This key is stored as a Supabase secret, never exposed to the client.

### 5.3 Encryption

- **In transit:** TLS everywhere. Supabase enforces HTTPS. Vercel enforces HTTPS. WhatsApp API uses HTTPS.
- **At rest:** Supabase encrypts database storage at rest (AES-256). Supabase Storage encrypts files at rest.
- **Sensitive fields:** Google Calendar OAuth tokens and WhatsApp API credentials stored in workspace config are encrypted at the application level before storage. Encryption key stored in Supabase Vault. Decrypted only in Edge Functions at execution time.

### 5.4 API security and rate limiting

| Endpoint / Action | Rate limit | Mechanism |
|---|---|---|
| WhatsApp webhook | No limit (Meta-controlled) | Dedup by wamid |
| Staff app API | 100 requests/minute per user | Vercel Edge Middleware |
| Draft reprompt / regeneration | 5 per conversation per hour | Application logic: query `drafts` table for recent reprompts. Reject with 429 if limit exceeded. |
| Inbound messages per sender | 20 per minute per phone | Application logic in webhook handler. Prevents spam/abuse. |

- **Input validation:** All inputs validated with Zod schemas before processing. Tool call parameters validated before execution.
- **CORS:** Staff app origin only. No wildcard.

### 5.5 LLM security

| Threat | Mitigation |
|---|---|
| LLM outputs a tool call with a different client's ID | **Tool parameter injection:** `workspaceId` and `clientId` are injected by the runtime from the session key. LLM-provided values are silently overwritten. |
| LLM hallucinates a tool that does not exist | **Tool registry:** tool name validated against allowed set. Unknown tools rejected. |
| LLM generates harmful content in draft | **All drafts require staff review.** Staff can edit or discard. No auto-send in MVP. |
| Prompt injection via client message | Client messages placed in user turn, not system prompt. System prompt is static template + workspace config. Client data clearly delimited. |
| Token budget exceeded by long client message | **Hard truncation** of client messages to 2000 chars. Knowledge search results capped at top-K. |
| LLM cost abuse (repeated reprompting) | **Rate limit: 5 reprompts per conversation per hour.** Tracked in drafts table. Enforced in application logic. |

### 5.6 Compliance

- **WhatsApp Business API compliance:** Opt-in tracking. 24-hour window enforcement. Template messages for out-of-window. No unsolicited messaging.
- **Data retention:** Messages retained for 365 days, then archived. Audit events retained indefinitely. LLM usage logs retained indefinitely.
- **Data deletion:** Soft deletes for GDPR-style deletion requests (mark `deleted_at`, exclude from queries). GDPR data export: SQL query scoped by `workspace_id` + `client_id`.
- **PII in logs:** LLM request/response logging (for debugging) strips client phone numbers and message content. Only metadata (token counts, tool names, latency) is logged to external services or `llm_usage`.

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
                           |
                           v
              +------------------------+
              | Log LLM Usage         |
              | (llm_usage table)     |
              +------------------------+
```

### 6.2 Context assembly

Context assembly is a **pure function**: `assembleContext(workspaceId, clientId, inboundMessage) -> ReadOnlyContext`. It runs before the LLM is invoked. The LLM cannot influence what data it receives.

**Sprint 2 implementation decision:** `ReadOnlyContext` is split into two sub-types — `GlobalContext` and `MessageContext` — to make the cacheable boundary explicit.

```typescript
// GlobalContext — workspace-level, same for every client in this workspace.
// Safe to cache per workspace; changes only when workspace config changes.
type GlobalContext = {
  identity: BusinessIdentity;    // businessName, vertical, description, toneProfile
  agent: AgentConfig;            // sopRules, intentTaxonomy, customFields, appointmentTypes
  tools: ToolsConfig;            // calendarConnected, knowledgeBaseEnabled
  businessContext: BusinessContext; // timezone, businessHours, scheduledReminder (enabled, daysBefore)
  memory: AgentMemory;           // communicationRules (learned from edit loop)
  heartbeat: AgentHeartbeat;     // workspaceId, status
};

// MessageContext — per-client, per-message. Assembled fresh on every invocation.
type MessageContext = {
  sessionKey: string;            // 'workspace:{id}:client:{id}'
  knowledgeChunks: KnowledgeChunk[];  // top-K semantic search results
  client: ClientProfile;
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
};

// ReadOnlyContext is the union passed to the LLM call.
type ReadOnlyContext = GlobalContext & MessageContext;
```

**Agent system prompt files** are Markdown templates stored at `src/app/api/workspaces/agent/`:
- `IDENTITY.md` — business identity and tone
- `AGENT.md` — SOP rules, intent taxonomy
- `TOOLS.md` — tool descriptions and availability
- `BUSINESS.md` — timezone, business hours, scheduled reminder config
- `MEMORY.md` — learned communication rules
- `HEARTBEAT.md` — workspace heartbeat/status
- `OUTPUT.md` — output format instructions

The `global-context/` folder at project root contains individual builder modules that populate `GlobalContext` from the database.

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

`GlobalContext` sections can be cached across invocations within the same workspace (they change rarely). `MessageContext` sections are assembled fresh per invocation.

### 6.3 Tool inventory

| Tool | Authority | LLM provides | Runtime injects | Returns |
|---|---|---|---|---|
| `knowledge_search` | read | `query: string` | `workspaceId` | Relevant chunks with source |
| `calendar_query` | read | `dateRange, appointmentType` | `workspaceId` | Available time slots |
| `calendar_book` | propose_write | `appointmentType, startTime, notes` | `workspaceId, clientId` | `ProposedAction<BookingCreate>` |
| `update_client` | propose_write | `changes: FieldChanges` | `workspaceId, clientId` | `ProposedAction<ClientUpdate>` |
| `create_note` | auto_write | `content, type` | `workspaceId, clientId, source: 'ai'` | `noteId` (saved immediately) |
| `create_followup` | propose_write | `description, dueDate?` | `workspaceId, clientId` | `ProposedAction<FollowUpCreate>` |

**Tools the agent does NOT have:** anything that queries across clients, reads another client's data, sends messages directly, or modifies workspace settings.

**Dynamic tool availability:** If Google Calendar is not connected for a workspace, the `calendar_query` and `calendar_book` tools are excluded from the tool registry for that workspace's Client Worker invocations. The system prompt tells the LLM: "Calendar is not connected. Do not offer to check availability or book appointments."

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
| **auto** | (none in MVP — reserved for future cron job actions such as scheduled reminders) | Execute immediately. Audit logged. |
| **review** | `booking_create`, `client_update`, `followup_create`, `message_send`, `note_create`, `tag_attach`, `last_contacted_update` — **all actions go through staff review in MVP** | Staff sees confirmation card. Applied only after approval. |
| **human_only** | Refunds, pricing changes, policy exceptions, complaints | Flag for manual handling. No draft generated. |

**Sprint 2 decision:** The auto tier is intentionally empty for MVP. All agent-proposed writes require staff confirmation. The auto tier is reserved for future cron-triggered actions (e.g., scheduled appointment reminders) that do not involve reactive client messages.

**Approve-action execution order:** On approval, the `approve-action` Edge Function executes the domain action **first**, then marks status as `approved` only on success. If execution fails, the `ProposedAction` stays `pending` and staff can retry. On rejection, status is updated immediately.

**Proposed-actions rollback safety:** If the `proposed_actions` INSERT fails after a draft has been saved, the draft is deleted (rolled back). This preserves idempotency — a retry will not find an existing draft and will reprocess the message correctly.

```typescript
type ProposedAction = {
  id: string;
  workspaceId: string;
  clientId: string;
  actionType: 'client_update' | 'booking_create' | 'followup_create' | 'message_send'
            | 'note_create' | 'tag_attach' | 'last_contacted_update';
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

**Sprint 2 decision:** All LLM calls (drafting, compaction, embeddings) route through **OpenRouter** using the OpenAI-compatible SDK. No direct Anthropic or OpenAI SDK. Models are configured via environment variables — no model IDs hardcoded.

```typescript
// All LLM calls use this client (Deno Edge Functions)
import OpenAI from 'https://esm.sh/openai@4';

const client = new OpenAI({
  apiKey: Deno.env.get('OPENROUTER_API_KEY')!,
  baseURL: 'https://openrouter.ai/api/v1',
});

// Model env vars — switch models without code changes
const PRO_MODEL = Deno.env.get('PRO_MODEL')!;        // e.g. 'anthropic/claude-sonnet-4-20250514'
const FLASH_MODEL = Deno.env.get('FLASH_MODEL')!;    // e.g. 'anthropic/claude-haiku-4-5-20251001'
const SMALL_MODEL = Deno.env.get('SMALL_MODEL')!;    // lightweight tasks
const EMBEDDING_MODEL = Deno.env.get('EMBEDDING_MODEL')!; // e.g. 'text-embedding-3-small'
```

| Use case | Env var | Why |
|---|---|---|
| Client Worker (drafting + tools) | `PRO_MODEL` | Best tool-calling reliability + quality |
| Daily compaction (summarization) | `FLASH_MODEL` | Cheap, summarization is straightforward |
| Lightweight tasks | `SMALL_MODEL` | Cost optimization |
| Embeddings | `EMBEDDING_MODEL` | Routed through OpenRouter (not direct OpenAI) |
| Voice transcription | Whisper API (future) | Best accuracy for short voice notes |

**Rationale for OpenRouter:** Unified billing, model flexibility without code changes, works well in Deno Edge Functions. Switching providers is a one-line env var change, not a code change.

Cost estimate per message: ~$0.01-0.03 (12K input tokens + ~500 output tokens at Sonnet/4o pricing).

### 6.7 LLM cost tracking

Every LLM invocation logs usage to the `llm_usage` table (see Section 9.1). This provides cost visibility from day one without requiring external observability tools.

```typescript
// After every LLM API call
async function logLLMUsage(
  supabase: SupabaseClient,
  params: {
    workspaceId: string;
    clientId: string | null;
    edgeFunctionName: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    costUsd: number;    // calculated from model pricing
  }
): Promise<void> {
  await supabase.from('llm_usage').insert(params);
}
```

This covers: Client Worker drafting calls, daily compaction summarization, knowledge embedding generation, and voice transcription. The data enables cost-per-workspace reporting and identifies cost optimization opportunities (e.g., switching simple intents to cheaper models).

---

## 7. Multi-tenant / workspace isolation strategy

### 7.1 Isolation model: shared database, RLS-enforced

All tenants share one Supabase project and one PostgreSQL database. Isolation is enforced by:

1. **Row Level Security (RLS)** on every table. Staff users can only read/write rows where `workspace_id` matches their workspace.
2. **Application-level scoping.** Every query in Edge Functions includes `WHERE workspace_id = $1`.
3. **Supabase Realtime channels** scoped by workspace. Staff only subscribes to `workspace:{their_workspace_id}`. Filtering uses the denormalized `workspace_id` column on messages, drafts, and notes.
4. **Storage buckets** organized by workspace. RLS-like policies on storage.

### 7.2 Why shared, not per-tenant projects

| Approach | Pros | Cons |
|---|---|---|
| Shared (chosen) | One deployment. One migration. One cron. Simple billing. | Noisy neighbor risk. Single point of failure. |
| Per-tenant Supabase projects | Full isolation. Independent scaling. | Operational nightmare for solo founder. N deployments. N migrations. N monitoring setups. |

For MVP (1-10 workspaces), shared is the obvious choice. If a single tenant requires dedicated infrastructure (enterprise deal, data residency), deploy a separate Supabase project for that tenant only.

### 7.3 RLS policy implementation

Every table follows this pattern using the `auth.workspace_id()` SQL helper function:

```sql
-- Helper function: get workspace_id for authenticated user
-- Returns a single UUID for MVP (single workspace per staff).
-- Signature is designed so the migration to multi-workspace (returning UUID[])
-- requires updating this one function + RLS policies, not application code.
CREATE OR REPLACE FUNCTION auth.workspace_id()
RETURNS UUID AS $$
  SELECT workspace_id FROM staff WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Apply RLS to every table (example for clients)
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_isolation" ON clients
  FOR ALL
  USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- Repeat for: conversations, messages, drafts, bookings, notes,
-- follow_ups, memories, knowledge_chunks, proposed_actions,
-- draft_edit_signals, message_templates, llm_usage

-- Special: audit_events is read-only for staff
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff_read_own_workspace" ON audit_events
  FOR SELECT USING (workspace_id = auth.workspace_id());
-- No INSERT/UPDATE/DELETE policy for staff -- only service role writes audit events
```

**Multi-workspace migration path:** When multi-staff support is needed (post-MVP), change `auth.workspace_id()` to `auth.workspace_ids()` returning `UUID[]`, and update RLS policies from `= auth.workspace_id()` to `= ANY(auth.workspace_ids())`. The helper function isolates this change to one function + RLS policy updates. Application code that uses `auth.workspace_id()` does not need to change because Edge Functions use the service role (bypassing RLS) with application-level `WHERE workspace_id = $1`.

### 7.4 Session isolation (LLM context)

The LLM context window is scoped to a single client within a single workspace. Cross-client data never enters the context. This is enforced by:

1. **Query scoping:** Context assembly queries always include `WHERE workspace_id = $1 AND client_id = $2`.
2. **Tool scoping:** `workspaceId` and `clientId` injected by runtime, not controllable by LLM.
3. **Audit logging:** Every context assembly and tool call logged with session key for traceability.

---

## 8. Message pipeline

### 8.1 Webhook reliability

WhatsApp Cloud API delivers webhooks with at-least-once semantics. The pipeline must handle:

**Deduplication:** Every WhatsApp message has a unique `wamid`. Before enqueuing, the webhook handler checks if this `wamid` already exists in `message_inbox` (a deduplication table). If it does, return 200 and skip.

```sql
-- Deduplication table (thin, just for idempotency check)
CREATE TABLE message_inbox (
  wamid TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert with conflict handling
INSERT INTO message_inbox (wamid, workspace_id)
VALUES ($1, $2)
ON CONFLICT (wamid) DO NOTHING
RETURNING wamid;
-- If RETURNING is empty, this is a duplicate -- skip
```

**Ordering:** Messages from the same client are processed in order. The `process-message` function acquires an advisory lock per client session: `pg_try_advisory_lock(hashtext(session_key))`. Only one worker processes messages for a given client at a time. If the lock cannot be acquired, the message stays in pgmq and becomes visible again after the visibility timeout.

**Retries:** pgmq tracks read count (`read_ct`) automatically. If `process-message` fails (LLM timeout, database error), the message becomes visible again after the visibility timeout (60 seconds). The worker checks `read_ct` on dequeue -- after 3 failed attempts, the message is moved to the dead letter queue.

**Dead letter:** After 3 retries, messages are moved to the DLQ via `pgmq.send('inbound_dlq', msg_payload)`. The message is only deleted from the main queue **after** the DLQ write succeeds, preserving durability. `inbound_dlq` is a pgmq queue (not a regular table). Staff is notified that a message could not be processed. They handle it manually.

### 8.2 pgmq queue setup

```sql
-- Enable the pgmq extension
CREATE EXTENSION IF NOT EXISTS pgmq;

-- Create the inbound message queue
SELECT pgmq.create('inbound_messages');

-- Create dead letter queue for failed messages
SELECT pgmq.create('inbound_dlq');

-- Enqueue (from webhook handler)
SELECT pgmq.send(
  'inbound_messages',
  jsonb_build_object(
    'wamid', $1,
    'workspace_id', $2,
    'phone_number', $3,
    'message_body', $4,
    'media_type', $5,
    'media_id', $6,
    'whatsapp_timestamp', $7
  )
);

-- Dequeue (from process-message, with 60s visibility timeout)
SELECT * FROM pgmq.read('inbound_messages', 60, 1);

-- Archive after successful processing
SELECT pgmq.archive('inbound_messages', $msg_id);

-- Move to DLQ after max retries (in process-message worker)
-- if msg.read_ct > 3:
-- Write to DLQ FIRST, only delete from main queue after DLQ write succeeds
SELECT pgmq.send('inbound_dlq', $msg_payload);
SELECT pgmq.archive('inbound_messages', $msg_id);
```

**Per-client serialization:** pgmq does not natively support per-key ordering. The worker handles this with an advisory lock:

```sql
-- Acquire advisory lock for this client before processing
-- session_key = 'workspace:{id}:client:{phone}'
SELECT pg_try_advisory_lock(hashtext($session_key));
-- If returns false, skip this message (another worker has this client).
-- The message becomes visible again after pgmq visibility timeout.
```

### 8.3 Processing trigger mechanism

The webhook must return 200 to Meta within 5 seconds. LLM processing takes 10-25 seconds. These are fully decoupled:

1. **Primary: pg_net async call.** After enqueuing to pgmq, the webhook handler uses Supabase's `pg_net` extension to make an async HTTP call to the `process-message` Edge Function. This returns immediately (non-blocking).
2. **Safety net: pg_cron polling.** A pg_cron job runs every 30 seconds, checks pgmq for pending messages, and invokes `process-message` if any are found. This catches any messages that fall through (e.g., if pg_net call fails).

```sql
-- pg_cron safety net (runs every 30 seconds)
-- Note: Supabase pg_cron minimum is 1 minute for job scheduling.
-- Use a 1-minute interval with the job itself checking for pending messages.
SELECT cron.schedule(
  'process-pending-messages',
  '* * * * *',  -- every minute
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/process-message',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := '{}'::jsonb
  )
  WHERE EXISTS (
    SELECT 1 FROM pgmq.read('inbound_messages', 0, 1)
  );
  $$
);
```

### 8.4 Edge Function timeout handling

If the function times out:
1. The pgmq message's visibility timeout (60s) expires, making the message visible again.
2. The pg_cron retry picks it up and reprocesses.
3. Context assembly is idempotent, so reprocessing is safe.
4. The worker checks if a draft already exists for this **specific inbound message** (idempotency guard). Idempotency is per-message, not per-conversation: `drafts.source_message_id` (UUID FK to `messages`) tracks which inbound message triggered each draft. Multiple client messages received before staff review each produce their own draft. If a draft with the same `source_message_id` already exists, skip processing.
5. If the LLM was called but the response was not saved, the worst case is a duplicate LLM call (wasted cost, not data corruption).

### 8.5 Delivery status webhooks

Meta sends delivery status updates (sent, delivered, read, failed) as separate webhook events. These are processed by the same `whatsapp-webhook` Edge Function but routed to a simpler handler that updates the `messages.delivery_status` field. No LLM processing needed.

---

## 9. Database schema

### 9.1 Core tables

```sql
-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS pgmq;       -- message queue
-- pg_cron and pg_net are enabled via Supabase dashboard

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
  whatsapp_access_token TEXT,             -- encrypted via Supabase Vault
  whatsapp_webhook_secret TEXT,           -- encrypted via Supabase Vault
  calendar_config JSONB,                   -- { provider, tokens, calendarId } -- encrypted tokens
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
-- workspace_id is denormalized for Supabase Realtime filtering
-- (Realtime filters work on a table's own columns, cannot JOIN)
-- ============================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),  -- denormalized for Realtime
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
CREATE INDEX idx_messages_workspace ON messages(workspace_id, direction, created_at DESC);

-- ============================================================
-- DRAFTS
-- workspace_id is denormalized for Supabase Realtime filtering
-- ============================================================
CREATE TABLE drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),  -- denormalized for Realtime
  source_message_id UUID REFERENCES messages(id),        -- inbound message that triggered this draft (idempotency key)
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

-- Idempotency index: one draft per inbound message
CREATE UNIQUE INDEX idx_drafts_source_message ON drafts(source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE INDEX idx_drafts_workspace ON drafts(workspace_id, created_at DESC);

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
-- workspace_id is denormalized for Supabase Realtime filtering
-- ============================================================
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),  -- denormalized for Realtime
  client_id UUID NOT NULL REFERENCES clients(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL,                               -- 'staff_manual', 'ai_extracted', 'conversation_update'
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_client ON notes(client_id, created_at DESC);
CREATE INDEX idx_notes_workspace ON notes(workspace_id, created_at DESC);

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
-- DRAFT EDIT SIGNALS (learning loop -- Phase 2 recording only)
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

-- ============================================================
-- MESSAGE INBOX (deduplication table for webhook idempotency)
-- ============================================================
CREATE TABLE message_inbox (
  wamid TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- LLM USAGE (cost tracking -- cherry-picked from Solution A)
-- ============================================================
CREATE TABLE llm_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID,                                     -- NULL for non-client calls (compaction, embedding)
  edge_function_name TEXT NOT NULL,                   -- 'process-message', 'daily-cron', 'embed-knowledge'
  model TEXT NOT NULL,                                -- 'claude-sonnet-4-20250514', 'gpt-4o', etc.
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  cost_usd NUMERIC(10,6) NOT NULL,                   -- calculated from model pricing
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_usage_workspace ON llm_usage(workspace_id, created_at DESC);
CREATE INDEX idx_llm_usage_daily ON llm_usage(workspace_id, created_at::date);

-- ============================================================
-- PGMQ QUEUES
-- ============================================================
SELECT pgmq.create('inbound_messages');
SELECT pgmq.create('inbound_dlq');
```

### 9.2 RLS policies (applied to all tables)

```sql
-- Helper function: get workspace_id for authenticated user
-- Placed in auth schema for clean namespace (cherry-picked from Solution A).
-- Returns single UUID for MVP. See Section 7.3 for multi-workspace migration path.
CREATE OR REPLACE FUNCTION auth.workspace_id()
RETURNS UUID AS $$
  SELECT workspace_id FROM staff WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- Enable RLS on all tenant tables
-- ============================================================
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposed_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_edit_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS policies (standard pattern for all workspace-scoped tables)
-- ============================================================

-- WORKSPACES: user can see their own workspace
CREATE POLICY "workspace_isolation" ON workspaces
  FOR ALL USING (id = auth.workspace_id())
  WITH CHECK (id = auth.workspace_id());

-- STAFF: user can see staff in their workspace
CREATE POLICY "workspace_isolation" ON staff
  FOR SELECT USING (workspace_id = auth.workspace_id());

-- CLIENTS
CREATE POLICY "workspace_isolation" ON clients
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- CONVERSATIONS
CREATE POLICY "workspace_isolation" ON conversations
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- MESSAGES
CREATE POLICY "workspace_isolation" ON messages
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- DRAFTS
CREATE POLICY "workspace_isolation" ON drafts
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- BOOKINGS
CREATE POLICY "workspace_isolation" ON bookings
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- NOTES
CREATE POLICY "workspace_isolation" ON notes
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- FOLLOW-UPS
CREATE POLICY "workspace_isolation" ON follow_ups
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- MEMORIES
CREATE POLICY "workspace_isolation" ON memories
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- KNOWLEDGE CHUNKS
CREATE POLICY "workspace_isolation" ON knowledge_chunks
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- PROPOSED ACTIONS
CREATE POLICY "workspace_isolation" ON proposed_actions
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- AUDIT EVENTS (read-only for staff, service role writes)
CREATE POLICY "staff_read_own_workspace" ON audit_events
  FOR SELECT USING (workspace_id = auth.workspace_id());

-- DRAFT EDIT SIGNALS
CREATE POLICY "workspace_isolation" ON draft_edit_signals
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- MESSAGE TEMPLATES
CREATE POLICY "workspace_isolation" ON message_templates
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());

-- LLM USAGE (read-only for staff)
CREATE POLICY "staff_read_own_workspace" ON llm_usage
  FOR SELECT USING (workspace_id = auth.workspace_id());
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
6. Log LLM usage to `llm_usage` table.

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
|  - API routes (Stripe webhook)    |
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
|  - pgmq extension                 |
|  - pg_cron extension              |
|  - pg_net extension               |
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
| LLM call latency and cost | `llm_usage` table: query by workspace, date range, model. Dashboard page (future) or SQL query. |
| Message queue health | pg_cron job that alerts if pgmq depth > 50 or oldest message age > 5 minutes |
| Application errors | Vercel function logs |
| Uptime | Supabase built-in health checks |
| Cost per workspace | `SELECT workspace_id, SUM(cost_usd) FROM llm_usage GROUP BY workspace_id` |

Defer: Langfuse, Sentry, or external monitoring. Add when you have paying customers. The `llm_usage` table provides sufficient cost visibility for MVP.

---

## 13. Codebase structure (MVP)

```
/
+-- supabase/
|   +-- migrations/
|   |   +-- 001_initial_schema.sql      # tables, indexes, extensions
|   |   +-- 002_rls_policies.sql        # auth.workspace_id() + all RLS policies
|   |   +-- 003_functions_and_queues.sql # pgmq queue creation, pg_cron jobs
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
|   |       +-- llm-usage.ts            # logLLMUsage() helper
|   |       +-- webhook-verify.ts       # HMAC verification (SubtleCrypto)
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
|       +-- use-realtime.ts            # Supabase Realtime subscription (dual notification)
|       +-- use-conversations.ts
|       +-- use-client.ts
|
+-- package.json
+-- tsconfig.json
+-- next.config.ts
```

Key principle: **no shared code between Edge Functions and Next.js app.** The Edge Functions (Deno runtime) and Next.js app (Node.js runtime) have separate dependency trees. Types can be duplicated or generated from the database schema via `supabase gen types typescript`. This avoids cross-runtime compatibility issues entirely.

---

## 14. Realtime subscription pattern

The staff app subscribes to workspace-scoped database changes via Supabase Realtime. The `workspace_id` denormalization on `messages`, `drafts`, and `notes` enables efficient filtering without JOINs.

```typescript
// Staff app: React hook for dual notification pattern
"use client";

import { useEffect } from "react";
import { createBrowserClient } from "@supabase/ssr";

export function useRealtimeInbox(workspaceId: string) {
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    const channel = supabase
      .channel(`workspace:${workspaceId}`)
      // Notification 1: New inbound message (immediate awareness, < 1s)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          if (payload.new.direction === "inbound") {
            handleNewInboundMessage(payload.new);  // Show "new message" badge
          }
        }
      )
      // Notification 2: AI draft ready (after processing, 5-15s)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "drafts",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          handleNewDraft(payload.new);  // Show "draft ready" notification
        }
      )
      // Proposed action updates
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "proposed_actions",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          handleActionUpdate(payload);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [workspaceId]);
}
```

---

## 15. Stripe integration

### 15.1 Subscription model

| Plan | Features | Limits |
|---|---|---|
| Free / Trial | Full features, 14-day trial | 100 AI-processed messages |
| Pro | Full features | 1,000 messages/month, 1 workspace |
| Growth | Full features + priority support | 5,000 messages/month, unlimited workspaces |

### 15.2 Implementation

- **Checkout:** Stripe Checkout Session created from settings page. Redirect to Stripe-hosted checkout.
- **Billing portal:** Stripe Customer Portal for plan changes, payment method updates, invoices.
- **Webhook:** `POST /api/webhooks/stripe` handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Updates `workspaces.subscription_status`.
- **Usage tracking:** Increment a counter in the workspace record for each AI-processed message. Check against plan limit before processing. If over limit, queue message but skip LLM call, notify staff.
- **Cost visibility:** `llm_usage` table enables per-workspace cost analysis for pricing decisions.
- **Metering (future):** Report usage to Stripe for usage-based billing. Deferred for MVP (flat plans).

---

## 16. WhatsApp integration details

### 16.1 Protocol: Baileys (WhatsApp Web, not Cloud API)

**Decision:** Use `@whiskeysockets/baileys` v6+ (multi-device WhatsApp Web protocol) instead of WhatsApp Cloud API.

| Aspect | Baileys (chosen) | Cloud API (rejected) |
|---|---|---|
| Setup | Staff scans QR code | Register WABA with Meta |
| Cost | Free (no per-conversation fees) | Meta per-conversation pricing |
| History | Access existing conversations | Starts fresh |
| 24h window | No restriction (Web protocol) | 24h window, then templates only |
| Templates | Not needed | Required for out-of-window |
| Reliability | Unofficial protocol, can break | Official API with SLA |
| Hosting | Persistent server required | Serverless (webhooks) |
| Ban risk | Possible (low with responsible use) | Zero |

**Why Baileys for B2B:** Clients already have WhatsApp accounts with existing client conversations. No WABA registration. Free messaging. Instant onboarding (scan QR code). These advantages outweigh the reliability risk for B2B deployments where we control the usage pattern.

### 16.2 Baileys server (Railway)

A persistent Node.js server running on Railway that maintains the WebSocket connection to WhatsApp.

**Responsibilities:**
- Maintain Baileys socket connection (auto-reconnect on disconnect)
- Handle QR code pairing during onboarding
- Persist auth state (credentials) to Supabase `baileys_auth` table
- On inbound message: save to `messages` table + enqueue to pgmq
- On send request: send via Baileys socket
- Expose HTTP API for the rest of the system

**Server structure:**
```
baileys-server/
  src/
    index.ts              # Express server + Baileys socket init
    socket-manager.ts     # Per-workspace socket lifecycle
    message-handler.ts    # Inbound message → Supabase + pgmq
    send-handler.ts       # HTTP endpoint → Baileys send
    auth-store.ts         # Supabase-backed auth state persistence
    qr-handler.ts         # QR code generation for onboarding
    health.ts             # Health check endpoint
  package.json
  Dockerfile
```

**HTTP API:**
| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Health check (Railway monitoring) |
| `/qr/:workspaceId` | GET | Get current QR code for pairing (SSE stream) |
| `/send` | POST | Send message via Baileys socket |
| `/status/:workspaceId` | GET | Connection status (connected/disconnected/qr_pending) |
| `/reconnect/:workspaceId` | POST | Force reconnect |

**Baileys server authentication:** All requests to the Baileys server (from Edge Functions or Next.js) must include the `x-api-secret` header matching `BAILEYS_API_SECRET` env var. Non-2xx responses from the server fail the `message_send` action and set `messages.delivery_status = 'failed'`. Staff sees the error on the confirmation card.

**Auth state persistence:**
```sql
CREATE TABLE baileys_auth (
  workspace_id  uuid NOT NULL REFERENCES workspaces(workspace_id),
  key           text NOT NULL,
  value         jsonb NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
```

Baileys auth state is stored in Supabase (not local files). This means the server can restart, redeploy, or scale without losing the WhatsApp connection — it re-authenticates from the stored credentials.

### 16.3 Message flow (Baileys → pgmq → process-message)

```
WhatsApp (client sends message)
    │
    │ WebSocket event
    v
Baileys Server (Railway)
    │
    ├─ 1. Extract message (id, from, content, media, timestamp)
    ├─ 2. Normalize phone number (E.164)
    ├─ 3. Resolve workspace from connected socket
    ├─ 4. Deduplicate by message ID (INSERT ... ON CONFLICT DO NOTHING)
    ├─ 5. Save raw message to `messages` table (staff sees it via Realtime)
    ├─ 6. Enqueue to pgmq (inbound_msgs queue)
    └─ 7. pg_net trigger fires → process-message Edge Function
              │
              └─ (same pipeline as before: context assembly → LLM → draft → approval)
```

**No webhook verification needed** — the Baileys server receives messages via its own authenticated WebSocket connection, not via HTTP webhooks. Authentication is the QR code pairing itself.

### 16.4 QR code pairing flow (onboarding)

```
Staff opens /onboarding/whatsapp-connect
    │
    ├─ 1. Next.js page calls Baileys server: GET /qr/:workspaceId
    ├─ 2. Baileys server initializes socket for this workspace
    ├─ 3. Baileys emits QR code → SSE stream to browser
    ├─ 4. Staff scans QR code with their WhatsApp phone
    ├─ 5. Baileys receives pairing confirmation
    ├─ 6. Auth credentials saved to `baileys_auth` table
    ├─ 7. Connection status updated: "connected"
    └─ 8. Staff sees "WhatsApp connected" in onboarding wizard
```

**Re-authentication:** If the server restarts, it loads credentials from `baileys_auth` and reconnects automatically (no QR scan needed unless credentials are invalidated by WhatsApp).

### 16.5 No 24-hour window restriction

Unlike Cloud API, Baileys (WhatsApp Web protocol) has **no 24-hour conversation window**. Staff can send messages to any client at any time, just like using the WhatsApp app. No template messages needed.

The `message_templates` table is retained for canned responses (staff convenience) but not for WhatsApp compliance.

### 16.6 Media handling

| Media type | Processing | Storage |
|---|---|---|
| Voice notes | Downloaded from WhatsApp via Baileys. Transcribed via Whisper before context assembly. Transcription stored in `messages.media_transcription`. LLM usage logged. | Supabase Storage |
| Images | Downloaded via Baileys `downloadMediaMessage()`. Stored. Passed to multimodal LLM in Client Worker call. | Supabase Storage |
| Documents (PDF, etc.) | Downloaded via Baileys. Stored. Displayed to staff. Not processed by AI. | Supabase Storage |
| Location, contacts, stickers | Stored as metadata. Agent generates acknowledgment. | Database (JSONB in messages) |

### 16.7 Reliability and monitoring

| Risk | Mitigation |
|---|---|
| WhatsApp disconnects | Auto-reconnect with exponential backoff. Health endpoint reports status. Staff sees "disconnected" badge. |
| Server crash/restart | Auth state in Supabase. Server reconnects from stored credentials on startup. pgmq messages safe in Postgres. |
| Meta protocol change | Monitor Baileys GitHub releases. Pin to stable version. Cloud API is the fallback if Baileys becomes unsustainable. |
| Account ban | Use responsibly: no spam, no bulk messaging, respect rate limits. B2B usage pattern (1:1 with known clients) is low risk. |
| Railway downtime | Messages are lost during downtime (WhatsApp delivers to phone, not to server). Staff can see messages on their phone and respond manually. When server recovers, new messages flow normally. |

### 16.8 Sending messages (outbound)

When staff approves a draft or sends a message:

```
Staff clicks Send in Next.js app
    │
    ├─ 1. Next.js Server Action / API route
    ├─ 2. Save outbound message to `messages` table
    ├─ 3. Record learning signal (draft edit tracking)
    ├─ 4. HTTP POST to Baileys server: /send
    │     { workspaceId, to: clientPhone, content, mediaUrl? }
    ├─ 5. Baileys server sends via socket
    ├─ 6. Baileys receives delivery receipt
    └─ 7. Update message.delivery_status (sent → delivered → read)
```

---

## 17. Verification questions and answers

### Q1: Can pgmq handle the required throughput without Redis/BullMQ?

**Answer:** Yes, for MVP scale. pgmq is a Postgres-native extension that provides durable, exactly-once message queue semantics. At 100 messages/day per workspace and 10 workspaces, that is about 1,000 messages/day or roughly 1 message per minute on average. pgmq handles thousands of messages per second within Postgres -- this is trivial. The advisory lock pattern (`pg_try_advisory_lock`) ensures per-client ordering. If throughput exceeds ~1,000 messages per hour sustained, migrate to a dedicated queue (BullMQ + Redis). This is a straightforward refactor because the queue interface is encapsulated in the `process-message` function.

### Q2: Will Supabase Edge Functions hit timeout limits during LLM processing?

**Answer:** This is the primary risk. Supabase Edge Functions have a 60-second timeout on the free tier and 150 seconds on Pro. A typical Client Worker invocation includes: context assembly (~200ms for DB queries) + LLM call (~5-15 seconds for Sonnet/4o with tool calling, possibly 2-3 tool calls at ~3s each) + result saving (~100ms). Total: ~10-25 seconds in the normal case. This fits within the 60-second limit. However, if the LLM call is slow (cold start, high load), it could approach the limit. Mitigation: set a 45-second timeout on the LLM call itself. If it times out, the pgmq visibility timeout expires (60s) and the message becomes available for retry. The retry picks it up automatically. If Edge Function timeouts become a persistent problem, move `process-message` to a Vercel serverless function (300-second timeout on Pro) or a dedicated server.

### Q3: Does the webhook-to-processing decoupling work reliably?

**Answer:** Yes. The webhook enqueues to pgmq and returns 200 immediately (< 500ms). Processing is triggered asynchronously via pg_net. If the pg_net call fails, the pg_cron safety net (every 1 minute) picks up pending messages. If the worker crashes mid-processing, the pgmq visibility timeout (60s) makes the message visible again for retry. After 3 failures (`read_ct > 3`), the message moves to the DLQ. This provides at-least-once processing with automatic retry and dead letter handling -- all within Postgres, no external infrastructure.

### Q4: How does the system handle a workspace with no Google Calendar connected?

**Answer:** The PRD specifies progressive enhancement (section 15.3). If no calendar is connected: the `calendar_query` and `calendar_book` tools are excluded from the tool registry for that workspace's Client Worker invocations. The LLM is told in its system prompt: "Calendar is not connected. Do not offer to check availability or book appointments. Instead, suggest the client coordinates scheduling directly with staff." When the workspace owner connects Google Calendar later, the tools become available in subsequent invocations. No code change needed -- tool availability is determined at context assembly time based on workspace config.

### Q5: Is the separation of Edge Functions (Deno) and Next.js (Node.js) a problem for shared types?

**Answer:** It requires discipline but is manageable. Recommended approach: Generate TypeScript types from the Supabase schema using `supabase gen types typescript` and use these in both codebases. The generated types file can be committed and imported by both Edge Functions and the Next.js app. If a type needs to exist that does not map to a database table, define it in both places with a comment referencing the canonical definition. No monorepo or shared packages needed.

---

## 18. Revisions from verification

Based on the verification questions above, the following changes were made to the architecture:

1. **Section 8.3 (Processing trigger) revised:** Changed from synchronous chaining to async invocation via pg_net, with pg_cron polling as a safety net. This prevents the webhook function from being blocked during LLM processing.

2. **Section 6.3 (Tool inventory) clarified:** Added note that tool availability is dynamic per workspace. If Google Calendar is not connected, calendar tools are excluded.

3. **LLM cost tracking added:** `llm_usage` table provides cost visibility from day one. Every LLM call (drafting, compaction, embedding, transcription) logs tokens, latency, and calculated cost.

4. **Webhook verification fixed:** Replaced Node.js `crypto.createHmac` with Deno-compatible `SubtleCrypto` API (Section 16.3). The original code would not work in Supabase Edge Functions.

5. **pgmq adopted:** Replaced the custom `message_queue` table with Supabase's native pgmq extension. Provides built-in visibility timeout, retry semantics, dead letter queue, and archive.

6. **`auth.workspace_id()` helper adopted:** Replaced `get_user_workspace_id()` with `auth.workspace_id()` in the `auth` schema for cleaner namespace. Documented multi-workspace migration path.

7. **Reprompt rate limiting added:** 5 reprompts per conversation per hour, enforced in application logic.

8. **Dual notification pattern documented:** Explicitly specified the two-phase Realtime notification (message received + draft ready) with workspace_id denormalization for efficient filtering.

9. **Schema denormalization added:** `workspace_id` denormalized onto `messages`, `drafts`, and `notes` for Supabase Realtime filtering. These tables need workspace-scoped Realtime subscriptions.

---

## 19. Sprint 2 implementation decisions (March 2026)

These decisions were locked during Sprint 2 implementation and amend the original architecture above.

1. **OpenRouter for all LLM calls (including embeddings):** All LLM and embedding calls route through OpenRouter using the OpenAI-compatible SDK. No direct Anthropic or OpenAI SDK. Model IDs come from env vars (`PRO_MODEL`, `FLASH_MODEL`, `SMALL_MODEL`, `EMBEDDING_MODEL`). See Section 6.6.

2. **GlobalContext / MessageContext split:** `ReadOnlyContext` is explicitly split into `GlobalContext` (workspace-level, cacheable) and `MessageContext` (per-client, per-message). Markdown agent prompt templates live at `src/app/api/workspaces/agent/`. Builder modules live in `global-context/`. See Section 6.2.

3. **All MVP actions are review tier:** The `auto` tier is empty in MVP. All agent-proposed writes (including `note_create`, `tag_attach`, `last_contacted_update`) go through staff review. Auto tier is reserved for future cron job actions. See Section 6.5.

4. **Booking tool captures `appointmentType + startTime`, not `slotId`:** The `calendar_book` tool receives `appointment_type` and `start_time` from the LLM. The executor looks up `durationMinutes` from `workspaces.vertical_config.appointmentTypes[]` and computes `end_time = start_time + durationMinutes` (default 60 min). No `slot_id` FK required.

5. **Idempotency is per-message, not per-conversation:** `drafts.source_message_id` (UUID FK to `messages`) is the idempotency key. A unique index enforces one draft per inbound message. Multiple messages before staff review each get their own draft. See Section 8.4.

6. **DLQ write order:** DLQ write (`pgmq.send('inbound_dlq', ...)`) happens before archiving the main queue message. Only delete from main queue after DLQ write succeeds. See Section 8.2.

7. **Baileys `x-api-secret` authentication:** All requests to the Baileys server include `x-api-secret` header from `BAILEYS_API_SECRET` env var. Non-2xx responses fail the send action and set `messages.delivery_status = 'failed'`. See Section 16.2.

8. **Approve-action: execute before marking approved:** On approval, the domain action executes first; `status = 'approved'` is set only on success. On failure, status stays `pending` for retry. On rejection, status updates immediately. See Section 6.5.

9. **Draft rollback on proposed_actions failure:** If inserting `proposed_actions` fails after a draft is saved, the draft is deleted. This preserves idempotency — the idempotency check will not find a draft and the message will be reprocessed on retry. See Section 6.5.

10. **Proactive operations planned for Sprint 3:** Four pg_cron jobs: heartbeat (2h), appointment reminder (daily 9am), follow-up trigger (hourly, per-client 72h timer), memory compaction (daily 3am). Spec at `docs/phase-4-feature-design/feature-specs/proactive-operations-cron.md`.

---

## 19. Architecture decision records (ADRs)

### ADR-1: pgmq over custom Postgres queue table

**Context:** The original Solution C specified a custom `message_queue` table with `FOR UPDATE SKIP LOCKED`. Solution A uses pgmq, a Postgres-native extension provided by Supabase.
**Decision:** Use pgmq for message queuing.
**Why:** pgmq provides queue semantics (visibility timeout, dead letter, archive, read count tracking) out of the box. Less custom SQL to write and maintain. Better-tested edge cases around concurrent access and failure modes. It is a Supabase-native extension -- no external infrastructure.
**Tradeoff:** Slightly less control over queue table structure. Requires understanding pgmq's API.
**Reversal trigger:** pgmq limitations become blocking, or sustained throughput > 1,000 msgs/hour requires BullMQ + Redis.

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

### ADR-5: OpenRouter with OpenAI-compatible SDK

**Context:** The original architecture specified direct provider SDK (Anthropic). Owner decision amended to use OpenRouter.
**Decision:** Use OpenRouter with OpenAI-compatible SDK (`baseURL: 'https://openrouter.ai/api/v1'`). Models configured via environment variables:
- `PRO_MODEL` — drafting, tool-calling (default: `anthropic/claude-sonnet-4-20250514`)
- `FLASH_MODEL` — compaction, cheap tasks (default: `anthropic/claude-haiku-4-5-20251001`)
- `SMALL_MODEL` — lightweight tasks
- `EMBEDDING_MODEL` — embeddings (default: `text-embedding-3-small`)

**Why:** OpenRouter provides model flexibility, unified billing, and the OpenAI-compatible SDK works well in Deno Edge Functions. Env vars allow model switching without code changes.
**Tradeoff:** Additional hop through OpenRouter. Minor latency increase.
**Reversal trigger:** OpenRouter latency or reliability becomes unacceptable.

### ADR-6: Async webhook processing via pg_net

**Context:** The webhook must return 200 to Meta within 5 seconds. LLM processing takes 10-25 seconds.
**Decision:** The webhook function enqueues to pgmq and returns 200 immediately. It then triggers processing asynchronously using Supabase's `pg_net` extension (async HTTP call to the processing Edge Function). pg_cron polls every 1 minute as a safety net for retries and missed messages.
**Why:** Decouples webhook acknowledgment from processing. Prevents webhook timeouts. Handles bursts gracefully. pgmq visibility timeout handles worker failures automatically.
**Tradeoff:** Slightly more complex than synchronous processing. Small latency increase in worst case (up to 1 minute if pg_net call fails and pg_cron must pick up).

### ADR-7: LLM usage logging to dedicated table

**Context:** Judges identified that Solution C lacked explicit LLM cost tracking. Solution A logged to `audit_events` metadata. A dedicated table is cleaner.
**Decision:** Create a `llm_usage` table for every LLM invocation (drafting, compaction, embedding, transcription). Log tokens_in, tokens_out, latency_ms, model, and calculated cost_usd.
**Why:** Cost visibility from day one. Enables per-workspace cost analysis for pricing decisions. Identifies optimization opportunities (e.g., cheaper models for simple intents). Separates cost data from audit trail for cleaner queries.
**Tradeoff:** Additional INSERT per LLM call (~1ms overhead).
**Reversal trigger:** None -- this should always be present. May migrate to Langfuse for advanced observability post-MVP.

### ADR-8: Reprompt rate limiting

**Context:** Judges identified that without reprompt limits, a user could run up LLM costs by repeatedly regenerating drafts. Solution A specified 5 per day per conversation.
**Decision:** Rate limit draft reprompts to 5 per conversation per hour.
**Why:** Prevents accidental or abusive LLM cost overruns. Per-hour (not per-day) allows continued use after a reasonable cooldown.
**Tradeoff:** Staff who legitimately need more than 5 reprompts per hour must wait. This is acceptable for MVP.
**Reversal trigger:** If staff feedback indicates the limit is too restrictive, increase or make it configurable per workspace.

---

## 20. What this architecture does NOT cover (deferred)

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
| External monitoring (Sentry, Langfuse) | Supabase/Vercel logs + llm_usage table sufficient for MVP | When debugging becomes painful or team grows |
| GDPR consent management | Legal requirements vary by market | Before EU launch |
| Circuit breaker patterns | Simple retry + pgmq visibility timeout sufficient for MVP | When external API failures become frequent |
| Web Push notifications | Supabase Realtime sufficient for MVP (staff app must be open) | When staff requests background notifications |

---

## 21. Implementation phases

### Phase 1: Core messaging + onboarding (Weeks 1-3)

- Supabase project setup, schema migration, RLS policies, pgmq queue creation
- WhatsApp webhook handler (receive, verify with SubtleCrypto, deduplicate, enqueue to pgmq)
- Phone normalization + client find-or-create
- Message storage and conversation tracking (workspace_id denormalized)
- Basic staff app: inbox, conversation thread (no AI yet)
- Supabase Realtime: dual notification pattern (message received + draft ready)
- Supabase Auth + staff login
- Stripe checkout + subscription management
- Onboarding flow (business identity, Instagram scrape, SOP generation)

### Phase 2: AI drafting + booking (Weeks 4-6)

- Context assembly function
- Client Worker runtime (LLM + tool loop)
- Tool implementations (knowledge_search, calendar_query, calendar_book, update_client, create_note, create_followup)
- Approval boundary + confirmation cards
- Draft review UX (edit, send, reprompt with rate limiting)
- Knowledge base embedding (pgvector)
- Google Calendar integration (OAuth, availability, event creation)
- Draft edit signal recording (learning loop Phase 2)
- Voice note transcription
- LLM usage logging to `llm_usage` table
- Audit logging

### Phase 3: Operational memory + follow-ups (Weeks 7-8)

- Daily compaction cron (with LLM usage logging)
- Follow-up surfacing and overdue detection
- Today's View page (SQL-based, no COS LLM)
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
- External monitoring integration (Langfuse, Sentry)

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

// LLM Usage record
type LLMUsageRecord = {
  workspaceId: string;
  clientId: string | null;
  edgeFunctionName: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number;
};
```

---

## Appendix B: Webhook payload handling

The WhatsApp Cloud API sends different payload structures for different event types. The webhook handler must route accordingly:

```typescript
// Simplified webhook routing (Deno Edge Function)
async function handleWebhook(payload: WhatsAppWebhookPayload) {
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.value.messages) {
        // Inbound message -- deduplicate and enqueue to pgmq
        for (const message of change.value.messages) {
          await deduplicateAndEnqueue(message, change.value.metadata);
        }
      }
      if (change.value.statuses) {
        // Delivery status update -- update message record
        for (const status of change.value.statuses) {
          await updateDeliveryStatus(status);
        }
      }
    }
  }
}
```

---

## Appendix C: Changelog -- what was polished and why

This document is based on Solution C (scored 4.2/5.0), the winning pragmatic MVP-first architecture. The following targeted improvements were applied based on judge feedback from three independent reviewers, cherry-picking the best elements from Solutions A and B without adding complexity that contradicts the MVP-first philosophy.

### Changes applied

| # | Change | Source | Why | Impact on complexity |
|---|---|---|---|---|
| 1 | **Replaced custom `message_queue` table with pgmq extension** | Solution A, all 3 judges | pgmq provides visibility timeout, dead letter queue, archive, and retry count tracking out of the box. Solution C's original approach (`FOR UPDATE SKIP LOCKED` on a custom table) required writing and maintaining queue semantics manually. pgmq is a Supabase-native extension -- zero additional infrastructure. | **Reduced** (less custom SQL) |
| 2 | **Renamed `get_user_workspace_id()` to `auth.workspace_id()`** | Solution A, Judges 2 and 3 | Cleaner namespace (`auth` schema). Consistent naming convention. The function signature is designed so that the migration to multi-workspace (`auth.workspace_ids()` returning `UUID[]`) only requires changing this one function + RLS policies. Solution C's original function worked but used a parameter-based API (`get_user_workspace_id(auth.uid())`) rather than a zero-argument helper. | **Neutral** (same logic, better name) |
| 3 | **Added reprompt rate limiting: 5 per conversation per hour** | Solution A (Section 5.4), Judge 1 | Without limits, a user could run up LLM costs by repeatedly regenerating drafts. This is an operational risk that all three judges flagged. Implementation is ~10 lines of application logic (query recent drafts with `staff_action = 'regenerated'` in the last hour). | **Minimal** (~10 lines of code) |
| 4 | **Added `llm_usage` table for LLM cost logging** | Solution A (cost tracking), Judges 1 and 3 | Solution C's original approach logged LLM metadata to `audit_events.metadata`. A dedicated table is cleaner for cost queries (cost per workspace, cost per day, cost per model). Enables pricing decisions and cost optimization. Implementation is one INSERT per LLM call (~5 lines). | **Minimal** (one new table, one INSERT per LLM call) |
| 5 | **Added dual notification pattern** | Solution B (Section 8.2), all 3 judges | Staff sees "message received" within ~1 second (Realtime fires on `messages` INSERT) and "draft ready" within ~15 seconds (fires on `drafts` INSERT). Solution C implicitly had this behavior (both tables trigger Realtime) but did not name it or ensure the staff app subscribes to both events. Explicit specification prevents a bug where the developer only subscribes to draft events and misses the immediate notification. | **Minimal** (documentation + one additional Realtime subscription in the React hook) |
| 6 | **Denormalized `workspace_id` onto `messages`, `drafts`, and `notes`** | Solution B (Section 8.1), Judge 2 | Supabase Realtime filters work on a table's own columns -- they cannot JOIN through `conversation_id -> client_id -> workspace_id`. Without denormalization, the Realtime subscription cannot filter by workspace, meaning every staff user would receive notifications for all workspaces. Solution C's original schema already had `workspace_id` on `messages` and `drafts` but not on `notes` and did not explain the reasoning. | **Minimal** (one column addition to `notes`, plus comments explaining the denormalization) |
| 7 | **Fixed webhook verification to use Deno-compatible SubtleCrypto** | Judge 1 (Section 2.5) | Solution C's original webhook verification code used `crypto.createHmac` (Node.js API), which does not exist in the Deno runtime used by Supabase Edge Functions. Replaced with `SubtleCrypto` which is available in both Deno and browser environments. | **Neutral** (fix, not addition) |
| 8 | **Added 5-layer security model documentation** | Solution A (Section 5.1), Judges 2 and 3 | Solution C's security was functionally correct but not formally structured. The 5-layer model (Network, Authentication, Authorization, Data Isolation, Audit) makes the security posture auditable without changing any implementation. | **Neutral** (documentation only) |
| 9 | **Added LLM threat mitigation table** | Solution A (Section 5.4), Judge 1 | Solution C addressed tool parameter injection and prompt injection defense but did not address: token budget abuse (long client messages), hallucinated tools, and repeated reprompting. Added explicit mitigations for each. | **Minimal** (hard truncation at 2000 chars + rate limit already added) |
| 10 | **Added explicit RLS policies for all tables** | Solution A (Section 5.2), Judge 3 | Solution C said "repeat for all tables" but did not list them. The polished version explicitly enables RLS and creates policies for all 16 tables. This prevents an implementation miss where a developer forgets to add RLS to a new table. | **Neutral** (documentation completeness) |
| 11 | **Added Realtime subscription code example** | Solution B (Section 8.2) | Solution C described Realtime subscriptions but did not provide implementation code. The React hook example from Solution B demonstrates the dual notification pattern concretely and can be copy-pasted into the staff app. | **Neutral** (example code) |
| 12 | **Added compliance and data retention section** | Judges 2 and 3 | Solution C lacked explicit data retention policy, GDPR handling, and PII logging rules. Added: 365-day message retention, indefinite audit retention, soft deletes for GDPR, and PII stripping from external logs. | **Neutral** (documentation) |
| 13 | **Added capacity limits table** | Solution A (Section 7.3), Judge 3 | Solution C had growth triggers but no explicit capacity numbers. Added concrete limits (pgmq throughput, Edge Function concurrency, clients per workspace) with monitoring thresholds. | **Neutral** (documentation) |
| 14 | **Added `message_inbox` deduplication table** | Architectural improvement | Solution C used a unique index on the message queue for deduplication. With pgmq, the queue table structure is managed by the extension. A thin `message_inbox` table with `wamid` as primary key provides the deduplication check independently of the queue implementation. | **Minimal** (one thin table) |

### What was NOT adopted

| Rejected element | Source | Why rejected |
|---|---|---|
| Turborepo monorepo with `packages/shared/` | Solution A | Cross-runtime (Deno + Node.js) shared packages add tooling complexity. `supabase gen types typescript` provides type sharing without monorepo overhead. |
| 9 Edge Functions (cos-worker, learning-worker, media-processor, onboarding-worker) | Solution A | Phase 3-4 features. Building infrastructure for deferred features violates the MVP-first principle. |
| 23 ordered migration files | Solution A | 3 migration files are sufficient for MVP. More files add deployment ceremony. |
| CQRS by deployment boundary | Solution B | The natural Supabase architecture (Edge Functions write, Next.js reads) already provides this separation without naming it a pattern or adding an event log table. |
| Custom queue tables (inbound_queue, outbound_queue) | Solution B | pgmq provides better semantics with less custom code. |
| Event log table | Solution B | Write amplification without MVP consumer. Audit events table is sufficient for debugging. |
| Langfuse integration | Solution A | Deferred until paying customers exist. `llm_usage` table provides sufficient cost visibility for MVP. |
| Circuit breaker patterns (cockatiel library) | Solution A | Simple retry + pgmq visibility timeout handles Edge Function and LLM API failures adequately for MVP. |
| `auth.workspace_ids()` returning UUID[] | Solution A | Over-engineering for MVP (single operator per workspace). The `auth.workspace_id()` function has a documented migration path to the array version. |
| Full learning loop implementation (classification, recurrence, promotion) | Solution A | Phase 4 feature. Signal recording is in place. Analysis deferred until sufficient data collected. |
| Web Push notification Edge Function | Solution B | Supabase Realtime is sufficient for MVP. Staff app must be open to receive notifications. Web Push can be added when background notifications are needed. |
