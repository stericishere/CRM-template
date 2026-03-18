# Architecture B: Event-Driven Serverless-First Specification

**System:** WhatsApp-First AI Client Ops Manager
**Nature:** Alternative architecture — prioritizes zero-infrastructure serverless, Supabase-native primitives, and event-driven CQRS over the worker-process model in Architecture A
**Status:** Architecture proposal — ready for comparison review
**Companion documents:** PRD v2.1, Architecture A (adr/architecture.md)

---

## 0. How this differs from Architecture A

Architecture A builds a traditional worker-process system: BullMQ + Redis for message queuing, Fastify as the server framework, long-running workers that dequeue and process. That design is proven and robust, but it introduces infrastructure outside the Supabase + Vercel constraint set, requires persistent server processes that conflict with serverless deployment, and adds Redis as a separate stateful dependency.

This architecture makes a different bet: **PostgreSQL is the only stateful component. Everything else is a stateless function invoked by events.**

| Decision | Architecture A | Architecture B (this document) |
|---|---|---|
| Message queue | BullMQ + Redis | Supabase Database Queues (pgmq) |
| Server framework | Fastify (separate backend) | Next.js App Router (Vercel) + Supabase Edge Functions |
| Worker model | Long-running Node processes pulling from Redis | Edge Functions triggered by database events, fire-and-forget |
| Webhook handler | Fastify route | Supabase Edge Function (Deno, <50ms cold start) |
| Real-time updates | Not specified | Supabase Realtime (Postgres changes → staff app via WebSocket) |
| Read/write separation | None (same process handles both) | CQRS: Edge Functions handle writes, Next.js serves reads |
| Infrastructure count | Supabase + Redis + Node server | Supabase + Vercel (two managed services, zero self-hosted) |
| Deployment model | Requires compute server (Railway/Render/EC2) | Fully serverless (Vercel + Supabase Edge Functions) |

**What we keep from Architecture A (these are load-bearing, not negotiable):**
- Single agent with tools, not multi-agent
- Context assembly as deterministic pure function
- Session isolation by construction (workspace_id + client_id scoping)
- Structured records over conversational memory
- Approval boundary before all mutations
- Daily compaction on schedule
- Three-tier trust model (auto / review / human-only)
- ProposedAction contract
- Tool parameter injection (LLM cannot override workspaceId/clientId)

---

## 1. Architectural principles

### 1.1 Core rule

**The agent may think, retrieve, draft, and propose. Only deterministic application services may commit writes.**

Unchanged from Architecture A. This is the single load-bearing constraint.

### 1.2 Guiding decisions specific to Architecture B

| Principle | Implementation |
|---|---|
| PostgreSQL is the only state | No Redis, no filesystem, no external message broker. Supabase Postgres holds queues, events, data, and vectors. |
| Functions, not processes | Every computation runs as a stateless function (Edge Function or Vercel serverless). No long-running workers. |
| Events, not polling | Database changes emit events via `pg_notify` / Supabase Realtime. Functions react; nothing polls. |
| CQRS by deployment boundary | Writes flow through Edge Functions (close to Supabase, low latency to DB). Reads flow through Next.js (optimized for staff app rendering). |
| Edge-first webhook handling | WhatsApp webhooks hit Supabase Edge Functions directly (Deno runtime, <50ms cold start, global edge deployment). |
| Two managed services, zero ops | Supabase (database, auth, realtime, edge functions, storage, cron) + Vercel (Next.js). No Docker, no Kubernetes, no Redis to monitor. |

### 1.3 What this architecture is not

This is not a traditional microservices system. There are no separate services with their own databases. There is one PostgreSQL database, and stateless functions operate on it. The "services" are logical modules within the codebase, not deployed units.

This is also not a "functions-only" architecture that avoids all state. PostgreSQL is deeply stateful, and we lean into that. The functions are stateless; the database is not.

---

## 2. System topology

### 2.1 System diagram

```
                          ┌─────────────────────────────────────────────┐
                          │              VERCEL (Next.js)               │
                          │                                             │
                          │  ┌──────────────────────────────────────┐   │
                          │  │         Staff Web App (RSC)          │   │
                          │  │  - Inbox, Client Thread, Today View  │   │
                          │  │  - Draft Review & Edit               │   │
                          │  │  - Settings, Knowledge Editor        │   │
                          │  └──────────┬───────────────────────────┘   │
                          │             │ Server Actions (mutations)    │
                          │  ┌──────────▼───────────────────────────┐   │
                          │  │      Next.js API Routes / Actions     │   │
                          │  │  - Staff auth (Supabase session)      │   │
                          │  │  - Approve/reject proposed actions    │   │
                          │  │  - Send message (triggers outbound)   │   │
                          │  │  - Save note, manual updates          │   │
                          │  └──────────┬───────────────────────────┘   │
                          │             │                               │
                          └─────────────┼───────────────────────────────┘
                                        │ Supabase client (RLS-enforced)
                                        │
  ┌─────────────────────────────────────┼───────────────────────────────────────┐
  │                              SUPABASE                                       │
  │                                     │                                       │
  │  ┌──────────────────────────────────▼──────────────────────────────────┐    │
  │  │                     PostgreSQL (single instance)                    │    │
  │  │                                                                     │    │
  │  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐             │    │
  │  │  │  Core Tables │  │  Event Queue  │  │  pgvector     │             │    │
  │  │  │  (workspace, │  │  (pgmq-based) │  │  (knowledge   │             │    │
  │  │  │   client,    │  │              │  │   embeddings)  │             │    │
  │  │  │   message,   │  │  inbound_q   │  │               │             │    │
  │  │  │   draft,     │  │  processing_q│  └───────────────┘             │    │
  │  │  │   booking,   │  │  outbound_q  │                                │    │
  │  │  │   etc.)      │  │  cron_q      │  ┌───────────────┐             │    │
  │  │  └──────────────┘  └──────────────┘  │  Event Log     │             │    │
  │  │                                       │  (append-only) │             │    │
  │  │  ┌───────────────────┐               └───────────────┘             │    │
  │  │  │  RLS Policies      │                                             │    │
  │  │  │  (tenant isolation) │                                            │    │
  │  │  └───────────────────┘                                              │    │
  │  └─────────────────────────────────────────────────────────────────────┘    │
  │         │              │                │                                    │
  │         │ pg_notify    │ DB webhooks    │ Cron triggers                     │
  │         ▼              ▼                ▼                                    │
  │  ┌─────────────────────────────────────────────────────────────────────┐    │
  │  │                     Edge Functions (Deno)                           │    │
  │  │                                                                     │    │
  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐     │    │
  │  │  │  whatsapp-    │  │  process-     │  │  daily-cron          │     │    │
  │  │  │  webhook      │  │  message      │  │  (compaction,        │     │    │
  │  │  │              │  │              │  │   follow-ups, COS)   │     │    │
  │  │  │  - Verify     │  │  - Context   │  └──────────────────────┘     │    │
  │  │  │  - Dedup      │  │    assembly  │                               │    │
  │  │  │  - Enqueue    │  │  - LLM call  │  ┌──────────────────────┐     │    │
  │  │  │              │  │  - Draft save │  │  execute-action       │     │    │
  │  │  └──────────────┘  │  - Approval   │  │  (after staff         │     │    │
  │  │                     │    eval       │  │   confirms)           │     │    │
  │  │                     └──────────────┘  └──────────────────────┘     │    │
  │  └─────────────────────────────────────────────────────────────────────┘    │
  │                                                                             │
  │  ┌─────────────────────────────────────────────────────────────────────┐    │
  │  │                     Supabase Realtime                               │    │
  │  │  - Broadcasts draft_ready, message_received, action_executed        │    │
  │  │  - Staff app subscribes per workspace channel                       │    │
  │  └─────────────────────────────────────────────────────────────────────┘    │
  │                                                                             │
  │  ┌─────────────────┐  ┌──────────────────┐                                │
  │  │  Supabase Auth   │  │  Supabase Storage │                               │
  │  │  (staff login)   │  │  (media files)     │                               │
  │  └─────────────────┘  └──────────────────┘                                │
  │                                                                             │
  └─────────────────────────────────────────────────────────────────────────────┘
                     │                              │
                     ▼                              ▼
          ┌──────────────────┐           ┌──────────────────┐
          │ WhatsApp Cloud   │           │ Google Calendar   │
          │ API (Meta)       │           │ API               │
          └──────────────────┘           └──────────────────┘
                     │                              │
                     ▼                              │
          ┌──────────────────┐                      │
          │ LLM Provider     │◄─────────────────────┘
          │ (Claude/OpenAI)  │  (called from Edge Functions)
          └──────────────────┘

          ┌──────────────────┐
          │ Stripe           │
          │ (subscriptions)  │
          └──────────────────┘
```

### 2.2 CQRS boundary

The system splits into two execution paths:

**Write path (Edge Functions):**
- WhatsApp webhook ingestion
- Message processing + LLM invocation
- Action execution (after staff approval)
- Daily cron operations (compaction, follow-ups)
- All database writes

**Read path (Next.js on Vercel):**
- Staff app rendering (React Server Components)
- Client profile loading
- Conversation history display
- Today's view aggregation
- Settings pages
- Reads use Supabase client with RLS — queries go directly to Postgres

**Why this split matters:**
- Edge Functions run close to the Supabase database (same region). Write-heavy operations like message processing benefit from low-latency DB access.
- Next.js on Vercel handles the interactive staff app. Server Components pre-render views. Client components subscribe to Realtime for live updates.
- Neither path needs to know about the other. They communicate through the database.

### 2.3 Event flow

```
                    Event Source                  Event                    Consumer
                    ────────────                  ─────                    ────────

WhatsApp Cloud API ──webhook POST──►  whatsapp-webhook EF ──INSERT──►  inbound_queue table
                                                                              │
                                                                    pg_notify('new_message')
                                                                              │
                                                                              ▼
                                                                   process-message EF
                                                                     (context assembly
                                                                      + LLM invocation
                                                                      + draft creation)
                                                                              │
                                                                    INSERT draft row
                                                                    INSERT proposed_actions
                                                                              │
                                                                   Supabase Realtime
                                                                   broadcasts change
                                                                              │
                                                                              ▼
                                                                   Staff app receives
                                                                   live notification
                                                                              │
                                                                   Staff reviews draft
                                                                   Staff approves action
                                                                              │
                                                                    Next.js Server Action
                                                                    calls Supabase RPC
                                                                              │
                                                                              ▼
                                                                   execute-action EF
                                                                   (booking, client update,
                                                                    send message via WA API)
```

---

## 3. Message pipeline

### 3.1 Webhook ingestion (Edge Function: `whatsapp-webhook`)

This is the system's entry point. It must be fast (<200ms), idempotent, and reliable.

```typescript
// supabase/functions/whatsapp-webhook/index.ts

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req: Request) => {
  // 1. Verify webhook signature (Meta sends X-Hub-Signature-256)
  const signature = req.headers.get("x-hub-signature-256");
  const body = await req.text();
  if (!verifyWebhookSignature(body, signature)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = JSON.parse(body);

  // 2. Handle verification challenge (GET requests from Meta)
  if (req.method === "GET") {
    return handleVerificationChallenge(req);
  }

  // 3. Extract messages from webhook payload
  const messages = extractMessages(payload);
  if (messages.length === 0) {
    return new Response("OK", { status: 200 }); // Status updates, not messages
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // Service role for queue writes
  );

  // 4. Idempotent enqueue: use WhatsApp message ID as dedup key
  for (const msg of messages) {
    const { error } = await supabase.rpc("enqueue_inbound_message", {
      p_wa_message_id: msg.id,           // WhatsApp's message ID (dedup key)
      p_from_phone: msg.from,
      p_timestamp: msg.timestamp,
      p_type: msg.type,
      p_body: msg.text?.body ?? null,
      p_media_id: msg.image?.id ?? msg.audio?.id ?? null,
      p_raw_payload: JSON.stringify(msg),
    });

    if (error?.code === "23505") {
      // Unique constraint violation = duplicate, already enqueued
      continue;
    }
  }

  // 5. Return 200 immediately — processing happens async
  return new Response("OK", { status: 200 });
});
```

**Key design decisions:**
- The webhook function does NOT process messages. It only validates and enqueues. This keeps response time under 200ms, which is critical because Meta will retry if webhooks are slow.
- Deduplication uses WhatsApp's message ID as a unique constraint on the queue table. Duplicate webhooks (Meta retries) are silently ignored.
- Service role key is used because this is a system-level operation, not a user-scoped one.

### 3.2 Queue table (PostgreSQL-based)

Instead of Redis + BullMQ, we use a PostgreSQL table as a durable queue with advisory locks for concurrency control.

```sql
-- Inbound message queue
CREATE TABLE inbound_queue (
  id          BIGSERIAL PRIMARY KEY,
  wa_message_id TEXT UNIQUE NOT NULL,         -- Dedup key from WhatsApp
  business_phone_id TEXT NOT NULL,            -- Meta phone_number_id (maps to workspace)
  from_phone  TEXT NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL,
  msg_type    TEXT NOT NULL,                  -- text, image, audio, etc.
  body        TEXT,
  media_id    TEXT,
  raw_payload JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed, dead_letter
  attempts    INT NOT NULL DEFAULT 0,
  locked_by   TEXT,                           -- Edge Function instance ID
  locked_at   TIMESTAMPTZ,
  error_message TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_inbound_queue_status ON inbound_queue(status) WHERE status = 'pending';
CREATE INDEX idx_inbound_queue_from_phone ON inbound_queue(from_phone);

-- Enqueue function with dedup
CREATE OR REPLACE FUNCTION enqueue_inbound_message(
  p_wa_message_id TEXT,
  p_from_phone TEXT,
  p_timestamp TIMESTAMPTZ,
  p_type TEXT,
  p_body TEXT,
  p_media_id TEXT,
  p_raw_payload JSONB
) RETURNS VOID AS $$
BEGIN
  INSERT INTO inbound_queue (wa_message_id, from_phone, timestamp, msg_type, body, media_id, raw_payload)
  VALUES (p_wa_message_id, p_from_phone, p_timestamp, p_type, p_body, p_media_id, p_raw_payload)
  ON CONFLICT (wa_message_id) DO NOTHING;

  -- Notify the processor that a new message is available
  PERFORM pg_notify('new_inbound_message', p_wa_message_id);
END;
$$ LANGUAGE plpgsql;

-- Dequeue function with per-client serialization
CREATE OR REPLACE FUNCTION dequeue_inbound_message(p_worker_id TEXT)
RETURNS TABLE (
  queue_id BIGINT,
  wa_message_id TEXT,
  from_phone TEXT,
  timestamp TIMESTAMPTZ,
  msg_type TEXT,
  body TEXT,
  media_id TEXT,
  raw_payload JSONB
) AS $$
DECLARE
  v_record RECORD;
BEGIN
  -- Select the oldest pending message where no other message
  -- from the same phone is currently being processed.
  -- This enforces per-client serial processing without Redis queue groups.
  SELECT iq.* INTO v_record
  FROM inbound_queue iq
  WHERE iq.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM inbound_queue iq2
      WHERE iq2.from_phone = iq.from_phone
        AND iq2.status = 'processing'
    )
  ORDER BY iq.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_record IS NULL THEN
    RETURN;
  END IF;

  -- Lock the message
  UPDATE inbound_queue
  SET status = 'processing',
      locked_by = p_worker_id,
      locked_at = NOW(),
      attempts = attempts + 1
  WHERE id = v_record.id;

  queue_id := v_record.id;
  wa_message_id := v_record.wa_message_id;
  from_phone := v_record.from_phone;
  timestamp := v_record.timestamp;
  msg_type := v_record.msg_type;
  body := v_record.body;
  media_id := v_record.media_id;
  raw_payload := v_record.raw_payload;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
```

**Per-client serialization without Redis:** The `dequeue_inbound_message` function uses a subquery to skip messages whose sender already has a message in `processing` state. This achieves the same guarantee as BullMQ's queue groups — two messages from the same client are never processed concurrently — using only PostgreSQL.

**Retry handling:** A separate cron resets messages stuck in `processing` for more than 5 minutes (indicating a crashed Edge Function). After 3 failed attempts, messages move to `dead_letter` status for manual review.

```sql
-- Cron: Reset stuck messages (runs every minute via pg_cron)
CREATE OR REPLACE FUNCTION reset_stuck_messages() RETURNS VOID AS $$
BEGIN
  -- Messages stuck in processing for > 5 minutes
  UPDATE inbound_queue
  SET status = CASE
    WHEN attempts >= 3 THEN 'dead_letter'
    ELSE 'pending'
  END,
  locked_by = NULL,
  locked_at = NULL,
  error_message = CASE
    WHEN attempts >= 3 THEN 'Exceeded max attempts'
    ELSE error_message
  END
  WHERE status = 'processing'
    AND locked_at < NOW() - INTERVAL '5 minutes';
END;
$$ LANGUAGE plpgsql;

-- Schedule via pg_cron (Supabase enables this)
SELECT cron.schedule('reset-stuck-messages', '* * * * *', 'SELECT reset_stuck_messages()');
```

### 3.3 Message processing (Edge Function: `process-message`)

This is the core pipeline. It is triggered by `pg_notify` via a Supabase Database Webhook, or can be invoked directly.

```typescript
// supabase/functions/process-message/index.ts

serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const workerId = crypto.randomUUID();

  // 1. Dequeue next available message (per-client serialized)
  const { data: messages } = await supabase.rpc("dequeue_inbound_message", {
    p_worker_id: workerId,
  });

  if (!messages?.length) {
    return new Response("No messages", { status: 200 });
  }

  const msg = messages[0];

  try {
    // 2. Resolve workspace from WhatsApp business phone_number_id
    // Meta webhook payload includes the business phone_number_id (which WABA number received the message).
    // We store phone_number_id in workspace.whatsapp_config during onboarding.
    // This lookup maps the business number to the workspace, not the sender's number.
    const workspace = await resolveWorkspace(supabase, msg.business_phone_id);
    if (!workspace) {
      throw new Error(`No workspace mapping for business phone ID: ${msg.business_phone_id}`);
    }

    // 3. Normalize phone number + find or create client
    const normalizedPhone = normalizeE164(msg.from_phone);
    const client = await findOrCreateClient(supabase, workspace.workspace_id, normalizedPhone);

    // 4. Store the raw message (triggers immediate Realtime notification to staff)
    // workspace_id is denormalized here for Supabase Realtime filtering (see §8.1)
    const messageRecord = await storeMessage(supabase, {
      conversationId: client.conversation_id,
      workspaceId: workspace.workspace_id,  // Denormalized for Realtime
      direction: "inbound",
      content: msg.body,
      mediaType: msg.msg_type !== "text" ? msg.msg_type : null,
      mediaId: msg.media_id,
      senderType: "client",
      timestamp: msg.timestamp,
    });

    // 5. Media pre-processing (before context assembly)
    let processedContent = msg.body;
    if (msg.msg_type === "audio") {
      processedContent = await transcribeVoiceNote(msg.media_id, workspace);
      await supabase.from("messages").update({
        media_transcription: processedContent,
      }).eq("message_id", messageRecord.message_id);
    }

    // 6. Context assembly (deterministic, no LLM)
    const context = await assembleClientContext(
      supabase,
      workspace.workspace_id,
      client.client_id,
      { content: processedContent, type: msg.msg_type, timestamp: msg.timestamp }
    );

    // 7. Client Worker invocation (single LLM call)
    const workerResult = await invokeClientWorker(context);

    // 8. Save draft
    const draft = await saveDraft(supabase, {
      conversationId: client.conversation_id,
      content: workerResult.draftReply,
      intentClassified: workerResult.intent,
      confidenceScore: workerResult.confidence,
      knowledgeSourcesUsed: workerResult.knowledgeSources,
    });

    // 9. Process proposed actions through approval boundary
    for (const action of workerResult.proposedActions) {
      const tier = evaluateApprovalPolicy(action);

      if (tier === "auto") {
        await executeAction(supabase, action, workspace.workspace_id, client.client_id);
        await logAuditEvent(supabase, { ...action, tier, status: "auto_executed" });
      } else if (tier === "review") {
        await createProposedAction(supabase, {
          ...action,
          tier,
          sessionKey: `workspace:${workspace.workspace_id}:client:${client.client_id}`,
          status: "pending",
        });
      }
      // tier === "human_only" → conversation flagged, no draft
    }

    // 10. Update conversation state
    await supabase.from("conversations").update({
      state: workerResult.confidence > 0.3 ? "awaiting_staff_review" : "escalated",
      last_message_at: msg.timestamp,
      last_client_message_at: msg.timestamp,
      version: client.conversation_version + 1,
    }).eq("conversation_id", client.conversation_id)
      .eq("version", client.conversation_version); // Optimistic lock

    // 11. Mark queue entry as completed
    await supabase.from("inbound_queue").update({
      status: "completed",
      completed_at: new Date().toISOString(),
    }).eq("id", msg.queue_id);

    // Realtime broadcast happens automatically via Supabase Realtime
    // when draft and proposed_action rows are inserted.

    return new Response("Processed", { status: 200 });
  } catch (error) {
    // Mark as failed, will be retried by the stuck-message cron
    await supabase.from("inbound_queue").update({
      status: "failed",
      error_message: error.message,
    }).eq("id", msg.queue_id);

    return new Response("Error", { status: 500 });
  }
});
```

### 3.4 Triggering the processor

The process-message Edge Function needs to be invoked when new messages arrive. Two complementary mechanisms:

**Mechanism 1: Supabase Database Webhook (primary)**
Configure a Supabase Database Webhook that triggers the `process-message` Edge Function on INSERT to `inbound_queue`. This is a built-in Supabase feature — no custom infrastructure.

**Mechanism 2: pg_cron polling (fallback)**
A pg_cron job runs every 5 seconds and invokes the Edge Function if pending messages exist. This catches any messages missed by the webhook (e.g., during Edge Function cold starts or transient failures).

```sql
-- Fallback: poll for pending messages every 5 seconds
SELECT cron.schedule(
  'poll-inbound-queue',
  '5 seconds',
  $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM inbound_queue WHERE status = 'pending')
    THEN net.http_post(
      url := current_setting('app.supabase_functions_url') || '/process-message',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      ),
      body := '{}'::jsonb
    )
  END;
  $$
);
```

**Why two mechanisms?** Database webhooks provide near-instant triggering (<100ms) but are not guaranteed delivery. The pg_cron fallback ensures no message sits unprocessed for more than 5 seconds. Together, they provide reliability without a persistent process.

### 3.5 Outbound message flow

When staff approves a draft and sends a message:

```
Staff clicks Send in Next.js app
        │
        ▼
Next.js Server Action
  - Validates staff session (Supabase Auth)
  - Reads draft content (edited or original)
  - Writes to outbound_queue table
  - Updates draft record (staff_action, edited_content)
  - Records DraftEditSignal (learning loop)
        │
        ▼
Supabase Database Webhook → send-message Edge Function
  - Reads outbound_queue entry
  - Checks WhatsApp 24-hour window
  - Sends via WhatsApp Cloud API (freeform or template)
  - Updates delivery_status
  - Logs audit event
  - Updates conversation state → awaiting_client_reply
```

---

## 4. Session isolation model

Identical to Architecture A in intent. The isolation boundary is `workspace_id + client_id`, enforced at three levels: query scoping, tool parameter injection, and audit logging.

### 4.1 Context assembly

```typescript
// Deterministic pure function — no LLM, no side effects
async function assembleClientContext(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string,
  inboundMessage: InboundMessage
): Promise<ClientSessionContext> {

  // ── GLOBAL (workspace-level, cached across client workers) ──

  // These queries are workspace-scoped only. They return the same data
  // regardless of which client triggered the invocation.
  const [workspace, verticalConfig, commProfile] = await Promise.all([
    supabase.from("workspaces").select("*").eq("workspace_id", workspaceId).single(),
    supabase.from("workspaces").select("vertical_config").eq("workspace_id", workspaceId).single(),
    supabase.from("communication_rules").select("*")
      .eq("workspace_id", workspaceId)
      .eq("active", true),
  ]);

  // Knowledge search: semantic search on the inbound message
  // Only searches this workspace's knowledge chunks (RLS + explicit filter)
  const knowledgeChunks = await supabase.rpc("search_knowledge", {
    p_workspace_id: workspaceId,
    p_query_embedding: await embedText(inboundMessage.content),
    p_match_count: 5,
    p_match_threshold: 0.7,
  });

  // ── CLIENT-SCOPED (isolation boundary — only this client's data) ──

  // Every query below includes WHERE workspace_id = $1 AND client_id = $2.
  // There is no query path that returns another client's data.
  const [
    client,
    conversation,
    recentMessages,
    activeBookings,
    activeFollowUps,
    recentNotes,
    compactSummary,
  ] = await Promise.all([
    supabase.from("clients").select("*")
      .eq("workspace_id", workspaceId).eq("client_id", clientId).single(),
    supabase.from("conversations").select("*")
      .eq("client_id", clientId).single(),
    supabase.from("messages").select("*")
      .eq("conversation_id", /* resolved from client */)
      .order("timestamp", { ascending: false }).limit(10),
    supabase.from("bookings").select("*")
      .eq("workspace_id", workspaceId).eq("client_id", clientId)
      .in("status", ["confirmed", "at_risk"]),
    supabase.from("followups").select("*")
      .eq("client_id", clientId)
      .in("status", ["open", "pending"]),
    supabase.from("notes").select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false }).limit(5),
    supabase.from("memory").select("content")
      .eq("client_id", clientId).eq("type", "compact_summary")
      .order("version", { ascending: false }).limit(1),
  ]);

  return {
    sessionKey: `workspace:${workspaceId}:client:${clientId}`,

    // Global
    workspace: workspace.data,
    verticalConfig: verticalConfig.data?.vertical_config,
    communicationRules: commProfile.data ?? [],
    knowledgeChunks: knowledgeChunks.data ?? [],

    // Client-scoped
    client: client.data,
    conversationState: conversation.data?.state,
    conversationVersion: conversation.data?.version,
    compactSummary: compactSummary.data?.[0]?.content ?? null,
    recentMessages: recentMessages.data ?? [],
    activeBookings: activeBookings.data ?? [],
    activeFollowUps: activeFollowUps.data ?? [],
    recentNotes: recentNotes.data ?? [],

    // The message being processed
    inboundMessage,
  };
}
```

### 4.2 Token budget

Same as Architecture A. Fixed order, explicit allocation:

| # | Section | Scope | Budget | Truncation |
|---|---|---|---|---|
| 1 | System prompt + tone | Global | ~1,500 | Fixed |
| 2 | Tool definitions | Global | ~800 | Fixed |
| 3 | Vertical config / SOP | Global | ~500 | Fixed per workspace |
| 4 | Learned communication rules | Global | ~500 | Omit if empty |
| 5 | Knowledge chunks | Global | ~2,000 | Top-K by relevance |
| 6 | Client profile + custom fields | Client | ~500 | Omit least-recent tags |
| 7 | Compact summary | Client | ~2,000 | Truncate oldest sections |
| 8 | Active bookings + follow-ups + notes | Client | ~1,000 | Cap at 5 per category |
| 9 | Conversation state | Client | ~100 | Fixed |
| 10 | Recent messages (~10) | Client | ~3,000 | Hard cap at 10 |
| 11 | Inbound message | Client | Variable | None |

**Total: ~12,000 tokens.** Well within any modern model's context window.

### 4.3 Isolation enforcement

**Level 1: RLS (Row Level Security) — database-enforced.**
Unlike Architecture A which relies solely on application-level WHERE clauses, we add RLS policies as a second enforcement layer. Even if application code has a bug, Postgres itself prevents cross-workspace data access.

```sql
-- RLS policy on clients table
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

-- Staff can only see clients in their workspace
CREATE POLICY clients_workspace_isolation ON clients
  FOR ALL
  USING (
    workspace_id IN (
      SELECT workspace_id FROM staff WHERE staff_id = auth.uid()
    )
  );

-- Service role bypasses RLS (used by Edge Functions)
-- Edge Functions use service role but always include explicit workspace_id filters.
-- RLS is the safety net, not the primary mechanism.
```

**Level 2: Query scoping.** Every database query in context assembly includes `WHERE workspace_id = $1 AND client_id = $2`. This is the primary isolation mechanism in Edge Functions.

**Level 3: Tool parameter injection.** Same as Architecture A — `workspaceId` and `clientId` are injected by the runtime, not passed by the LLM.

**Level 4: Audit logging.** Every context assembly, tool call, and action is logged with the session key.

---

## 5. Client Worker specification

Identical to Architecture A in contract. One LLM call with tools. The key difference is execution context: Architecture A runs this in a long-lived Node worker; we run it inside a Supabase Edge Function with a 150-second timeout (Supabase's limit for Edge Functions with service role).

### 5.1 Tool inventory

| Tool | Authority | Input (from LLM) | Fixed params (runtime-injected) | Output |
|---|---|---|---|---|
| `knowledge_search` | read | `query: string` | `workspaceId` | Relevant chunks with source attribution |
| `calendar_query` | read | `dateRange, appointmentType` | `workspaceId, calendarConfig` | Available time slots |
| `calendar_book` | propose_write | `slotId, appointmentType, notes` | `workspaceId, clientId` | `ProposedAction<BookingCreate>` |
| `update_client_record` | propose_write | `changes: FieldChanges` | `workspaceId, clientId` | `ProposedAction<ClientUpdate>` |
| `create_note` | auto_write | `content: string, type: NoteType` | `workspaceId, clientId, source: "ai_extracted"` | `NoteId` (saved immediately, audit logged) |
| `create_followup` | propose_write | `description, dueDate?` | `workspaceId, clientId` | `ProposedAction<FollowUpCreate>` |

### 5.2 LLM invocation pattern

```typescript
async function invokeClientWorker(
  context: ClientSessionContext
): Promise<ClientWorkerResult> {
  const systemPrompt = buildSystemPrompt(context);
  const tools = buildToolDefinitions(context);

  // Single LLM call with tool use
  let messages = [
    { role: "system", content: systemPrompt },
    ...formatConversationHistory(context.recentMessages),
    { role: "user", content: formatInboundMessage(context.inboundMessage) },
  ];

  const proposedActions: ProposedAction[] = [];
  let draftReply: string | null = null;

  // Tool-use loop: LLM may call tools, we execute and feed results back
  while (true) {
    const response = await llmGateway.chat({
      model: selectModel(context),
      messages,
      tools,
      max_tokens: 2000,
    });

    // Process tool calls
    if (response.tool_calls?.length) {
      for (const call of response.tool_calls) {
        const result = await executeToolCall(call, context);
        if (result.proposedAction) {
          proposedActions.push(result.proposedAction);
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.output) });
      }
      messages.push({ role: "assistant", content: response.content, tool_calls: response.tool_calls });
      continue;
    }

    // No tool calls — this is the final response (the draft)
    draftReply = response.content;
    break;
  }

  return {
    draftReply,
    proposedActions,
    intent: extractIntent(draftReply, messages),
    confidence: extractConfidence(draftReply, messages),
    knowledgeSources: extractKnowledgeSources(proposedActions),
  };
}
```

### 5.3 Edge Function timeout handling

Supabase Edge Functions have a 150-second timeout (on Pro plan). LLM calls typically take 3-15 seconds. The full pipeline (context assembly + LLM + tool loop + DB writes) must complete within this window.

**Mitigation for slow LLM responses:**
- Set LLM timeout at 60 seconds per call
- Maximum 3 tool-use loop iterations (configurable)
- If the Edge Function is about to timeout (check elapsed time), save partial results and mark the message for retry with a `partial_processing` flag
- The retry attempt loads the partial state and continues from where it left off

---

## 6. COS operations

### 6.1 Daily cron via Supabase pg_cron

Architecture A uses BullMQ scheduled jobs. We use Supabase's built-in pg_cron extension to trigger Edge Functions.

```sql
-- Daily cron: triggers at 6 AM in each workspace's timezone
-- Implementation: a master cron runs hourly, checks which workspaces
-- are at their configured cron hour, and invokes the Edge Function for each.

SELECT cron.schedule(
  'daily-ops-dispatcher',
  '0 * * * *',  -- Every hour, on the hour
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_functions_url') || '/daily-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('trigger_hour', EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC'))
  );
  $$
);
```

### 6.2 Daily cron Edge Function

```typescript
// supabase/functions/daily-cron/index.ts

serve(async (req: Request) => {
  const { trigger_hour } = await req.json();
  const supabase = createClient(/* ... service role ... */);

  // Find workspaces whose local time matches their configured cron hour (default: 6 AM)
  const { data: workspaces } = await supabase.rpc("get_workspaces_for_cron", {
    p_utc_hour: trigger_hour,
  });

  for (const ws of workspaces ?? []) {
    // Each workspace gets its own processing — fan out to separate invocations
    // to avoid one workspace's processing blocking another.
    await supabase.functions.invoke("daily-workspace-ops", {
      body: { workspace_id: ws.workspace_id },
    });
  }

  return new Response("OK", { status: 200 });
});
```

### 6.3 Per-workspace daily operations

The `daily-workspace-ops` Edge Function handles:

1. **Memory compaction** — For each client with activity since last compaction, generate updated compact summary.
2. **Follow-up surfacing** — Query overdue follow-ups, stale conversations, unconfirmed bookings.
3. **COS invocation** — Single LLM call with structured workspace-level data (not client conversational data). Produces ranked action list.
4. **Follow-up draft dispatch** — For each client needing follow-up, invoke the `process-message` Edge Function with a synthetic "follow-up" trigger (not a real WhatsApp message).
5. **Inactivity detection** — Mark clients as inactive after 30 days without contact.

---

## 7. Data model

### 7.1 Core schema

The schema is identical to Architecture A's PRD-defined schema (PRD section 12). We keep the same tables: workspace, staff, client, conversation, message, draft, booking, note, followup, memory, knowledge_chunk, message_template, audit_event, learning_signal, communication_rule.

### 7.2 Additional tables for event-driven pipeline

```sql
-- Inbound message queue (defined in section 3.2 above)
-- This replaces BullMQ/Redis entirely.

-- Outbound message queue
CREATE TABLE outbound_queue (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(conversation_id),
  workspace_id    UUID NOT NULL REFERENCES workspaces(workspace_id),
  content         TEXT NOT NULL,
  template_id     UUID REFERENCES message_templates(template_id),
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, sent, delivered, read, failed
  wa_message_id   TEXT,                             -- WhatsApp API response ID
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ
);

-- Proposed actions queue (replaces in-memory ProposedAction processing)
CREATE TABLE proposed_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(workspace_id),
  client_id       UUID NOT NULL REFERENCES clients(client_id),
  session_key     TEXT NOT NULL,
  action_type     TEXT NOT NULL,  -- client_update, booking_create, booking_reschedule, followup_create, message_send, note_create
  summary         TEXT NOT NULL,  -- Human-readable for staff
  tier            TEXT NOT NULL,  -- auto, review, human_only
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, rejected, expired, executed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID REFERENCES staff(staff_id),
  executed_at     TIMESTAMPTZ
);

CREATE INDEX idx_proposed_actions_pending ON proposed_actions(workspace_id, status) WHERE status = 'pending';

-- Event log (append-only, for CQRS read model rebuilding and debugging)
CREATE TABLE event_log (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL,
  event_type      TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       UUID,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partition by month for efficient querying and cleanup
CREATE INDEX idx_event_log_workspace_type ON event_log(workspace_id, event_type, created_at DESC);
```

### 7.3 RLS policies

Every table has RLS enabled. Policies enforce workspace isolation for staff access. Service role (used by Edge Functions) bypasses RLS but always includes explicit workspace_id filters in application code.

```sql
-- Example: Messages table RLS
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_workspace_isolation ON messages
  FOR ALL
  USING (
    conversation_id IN (
      SELECT c.conversation_id
      FROM conversations c
      JOIN clients cl ON c.client_id = cl.client_id
      WHERE cl.workspace_id IN (
        SELECT workspace_id FROM staff WHERE staff_id = auth.uid()
      )
    )
  );

-- Optimized: use a security definer function to avoid repeated subqueries
CREATE OR REPLACE FUNCTION auth_workspace_id()
RETURNS UUID AS $$
  SELECT workspace_id FROM staff WHERE staff_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Simpler RLS using the helper function
CREATE POLICY clients_isolation ON clients
  FOR ALL
  USING (workspace_id = auth_workspace_id());

CREATE POLICY bookings_isolation ON bookings
  FOR ALL
  USING (workspace_id = auth_workspace_id());

CREATE POLICY knowledge_isolation ON knowledge_chunks
  FOR ALL
  USING (workspace_id = auth_workspace_id());
```

### 7.4 pgvector for knowledge search

```sql
-- Enable the extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Knowledge search function
CREATE OR REPLACE FUNCTION search_knowledge(
  p_workspace_id UUID,
  p_query_embedding vector(1536),
  p_match_count INT DEFAULT 5,
  p_match_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  chunk_id UUID,
  content TEXT,
  source TEXT,
  source_ref TEXT,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.chunk_id,
    kc.content,
    kc.source,
    kc.source_ref,
    1 - (kc.embedding <=> p_query_embedding) AS similarity
  FROM knowledge_chunks kc
  WHERE kc.workspace_id = p_workspace_id
    AND 1 - (kc.embedding <=> p_query_embedding) > p_match_threshold
  ORDER BY kc.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$ LANGUAGE plpgsql;
```

---

## 8. Real-time updates to staff app

### 8.1 Schema denormalization for Realtime

Supabase Realtime filters work on a table's own columns. The PRD schema does not include `workspace_id` on `drafts` or `messages` (they relate through `conversation_id` -> `client_id` -> `workspace_id`). To enable efficient Realtime filtering without JOINs, we add `workspace_id` as a denormalized column on tables that need Realtime subscriptions:

```sql
-- Add workspace_id to drafts and messages for Realtime filtering
ALTER TABLE drafts ADD COLUMN workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id);
ALTER TABLE messages ADD COLUMN workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id);

-- These are populated at INSERT time by the Edge Functions that create these records.
-- They are redundant with the conversation -> client -> workspace join path,
-- but required for Supabase Realtime filtering.
CREATE INDEX idx_drafts_workspace ON drafts(workspace_id);
CREATE INDEX idx_messages_workspace ON messages(workspace_id, direction, timestamp DESC);
```

### 8.2 Supabase Realtime subscriptions

The staff app subscribes to database changes via Supabase Realtime. No custom WebSocket server needed.

**Dual notification pattern:** Staff receives two types of notifications per inbound message:
1. **Immediate "message received"** — triggered when the inbound message row is stored (before AI processing). Latency: < 1 second from WhatsApp webhook.
2. **"Draft ready"** — triggered when the AI draft is saved. Latency: 4-16 seconds (dominated by LLM call time).

This ensures staff awareness within seconds, even while the LLM processes.

```typescript
// Staff app: React component subscribing to real-time updates

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
      // Notification 1: New inbound message (immediate awareness)
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
      // Notification 2: AI draft ready (after processing)
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
      // Action updates (approved/executed/rejected)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "proposed_actions",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          handleActionUpdate(payload.new);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId]);
}
```

### 8.2 Notification flow

```
Edge Function inserts draft row
        │
        ▼
Supabase Realtime detects INSERT on drafts table
        │
        ▼
WebSocket broadcast to subscribed staff app instances
        │
        ▼
Staff app shows toast notification + updates inbox badge
        │
        ▼
(Optional) Web Push notification via service worker
```

Web Push notifications for when the staff app is not in focus:

```typescript
// Next.js API route: /api/push/subscribe
// Staff registers their push subscription on login.
// When a draft is created, a database trigger fires a
// Supabase Edge Function that sends a Web Push notification.

-- Trigger on draft insert
CREATE OR REPLACE FUNCTION notify_staff_new_draft()
RETURNS TRIGGER AS $$
BEGIN
  -- Use pg_net to call the push notification Edge Function
  PERFORM net.http_post(
    url := current_setting('app.supabase_functions_url') || '/send-push',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'workspace_id', NEW.workspace_id,
      'draft_id', NEW.draft_id,
      'client_name', (SELECT full_name FROM clients WHERE client_id = NEW.client_id)
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_staff_new_draft
  AFTER INSERT ON drafts
  FOR EACH ROW
  EXECUTE FUNCTION notify_staff_new_draft();
```

---

## 9. Staff app architecture (Next.js on Vercel)

### 9.1 App Router structure

```
app/
  layout.tsx                    # Root layout: Supabase auth provider, Realtime provider
  (auth)/
    login/page.tsx              # Staff login (Supabase Auth)
    callback/route.ts           # OAuth callback

  (dashboard)/
    layout.tsx                  # Authenticated layout: sidebar, notifications
    inbox/
      page.tsx                  # RSC: loads conversations, ordered by recency/priority
      [conversationId]/
        page.tsx                # RSC: conversation thread + draft review panel
    today/
      page.tsx                  # RSC: today's bookings, follow-ups, at-risk items
    clients/
      page.tsx                  # RSC: client list with search
      [clientId]/
        page.tsx                # RSC: full client profile
    settings/
      page.tsx                  # Knowledge editor, tone config, SOP, calendar
      knowledge/page.tsx        # Knowledge base editor + document upload
      rules/page.tsx            # Learned communication rules (view/toggle)

  api/
    webhooks/
      stripe/route.ts           # Stripe webhook handler (subscription events)
    push/
      subscribe/route.ts        # Web Push subscription registration
```

### 9.2 Server Components for reads

Staff app views use React Server Components to fetch data on the server with Supabase RLS:

```typescript
// app/(dashboard)/inbox/page.tsx

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export default async function InboxPage() {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies }
  );

  // RLS enforces workspace isolation automatically
  const { data: conversations } = await supabase
    .from("conversations_with_latest_message") // Database view
    .select("*")
    .order("last_message_at", { ascending: false });

  return <InboxList conversations={conversations} />;
}
```

### 9.3 Server Actions for mutations

Staff mutations (approve action, send message, save note) use Next.js Server Actions:

```typescript
// app/(dashboard)/inbox/[conversationId]/actions.ts
"use server";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

export async function approveAction(actionId: string) {
  const supabase = createServerClient(/* ... */);

  // Verify the action belongs to the staff's workspace (RLS handles this)
  const { data: action } = await supabase
    .from("proposed_actions")
    .select("*")
    .eq("id", actionId)
    .eq("status", "pending")
    .single();

  if (!action) throw new Error("Action not found or already processed");

  // Mark as approved
  await supabase.from("proposed_actions").update({
    status: "approved",
    reviewed_at: new Date().toISOString(),
    reviewed_by: (await supabase.auth.getUser()).data.user?.id,
  }).eq("id", actionId);

  // Trigger execution via Edge Function
  await supabase.functions.invoke("execute-action", {
    body: { action_id: actionId },
  });

  revalidatePath(`/inbox/${action.conversation_id}`);
}

export async function sendDraft(draftId: string, editedContent?: string) {
  const supabase = createServerClient(/* ... */);

  const { data: draft } = await supabase
    .from("drafts")
    .select("*, conversations(client_id, workspace_id)")
    .eq("draft_id", draftId)
    .single();

  if (!draft) throw new Error("Draft not found");

  const finalContent = editedContent ?? draft.content;
  const staffAction = editedContent ? "edited_and_sent" : "sent_as_is";

  // Update draft record
  await supabase.from("drafts").update({
    staff_action: staffAction,
    edited_content: editedContent ?? null,
    reviewed_at: new Date().toISOString(),
    reviewed_by: (await supabase.auth.getUser()).data.user?.id,
  }).eq("draft_id", draftId);

  // Enqueue outbound message
  await supabase.from("outbound_queue").insert({
    conversation_id: draft.conversation_id,
    workspace_id: draft.conversations.workspace_id,
    content: finalContent,
  });

  // Record learning signal
  await supabase.from("learning_signals").insert({
    workspace_id: draft.conversations.workspace_id,
    client_id: draft.conversations.client_id,
    draft_id: draftId,
    staff_action: staffAction,
    original_draft: draft.content,
    final_version: finalContent,
    intent_classified: draft.intent_classified,
  });

  revalidatePath(`/inbox/${draft.conversation_id}`);
}
```

---

## 10. Approval boundary

### 10.1 Trust tiers

Identical to Architecture A and the PRD:

| Tier | Actions | Behavior |
|---|---|---|
| **Auto-allowed** | Update `last_contacted_at`, append conversation summary, save AI-extracted note, attach low-risk tags, propose time slots (read-only) | Executed immediately by Edge Function. Audit logged. |
| **Suggest for review** | Change client name, change appointment details, add preferences, log promises with deadlines, modify lifecycle status, update sensitive notes, draft replies, propose follow-ups, create bookings | Saved to `proposed_actions` table with `status: pending`. Staff sees confirmation card in app. Executed only after staff approval. |
| **Human-only** | Refunds, pricing changes, policy exceptions, negotiation, complaint handling, liability commitments | Conversation flagged for manual handling. No draft, no proposal. |

### 10.2 Approval flow in the event-driven model

```
Client Worker returns ProposedAction[]
        │
        ▼
process-message Edge Function evaluates each:
        │
        ├── tier = "auto"
        │     └── Execute immediately in same Edge Function
        │         └── INSERT into audit_events
        │
        ├── tier = "review"
        │     └── INSERT into proposed_actions (status: pending)
        │         └── Supabase Realtime → staff app shows confirmation card
        │             ├── Staff approves → Server Action → execute-action EF
        │             └── Staff rejects → Server Action → UPDATE status = rejected
        │
        └── tier = "human_only"
              └── UPDATE conversation state = escalated
                  └── Supabase Realtime → staff app shows escalation alert
```

### 10.3 Action execution Edge Function

```typescript
// supabase/functions/execute-action/index.ts

serve(async (req: Request) => {
  const { action_id } = await req.json();
  const supabase = createClient(/* service role */);

  const { data: action } = await supabase
    .from("proposed_actions")
    .select("*")
    .eq("id", action_id)
    .eq("status", "approved")
    .single();

  if (!action) {
    return new Response("Action not found or not approved", { status: 404 });
  }

  try {
    switch (action.action_type) {
      case "booking_create":
        await createBooking(supabase, action);
        break;
      case "client_update":
        await updateClient(supabase, action);
        break;
      case "followup_create":
        await createFollowUp(supabase, action);
        break;
      case "message_send":
        await enqueueOutboundMessage(supabase, action);
        break;
    }

    await supabase.from("proposed_actions").update({
      status: "executed",
      executed_at: new Date().toISOString(),
    }).eq("id", action_id);

    await logAuditEvent(supabase, {
      workspace_id: action.workspace_id,
      actor_type: "system",
      action_type: `${action.action_type}_executed`,
      target_entity: action.action_type,
      target_id: action.id,
      metadata: action.payload,
    });

    return new Response("Executed", { status: 200 });
  } catch (error) {
    await supabase.from("proposed_actions").update({
      status: "failed",
      error_message: error.message,
    }).eq("id", action_id);

    return new Response("Execution failed", { status: 500 });
  }
});
```

---

## 11. Memory and compaction

### 11.1 Daily compaction via Edge Function

Same model as Architecture A: scheduled, not reactive. Triggered by pg_cron as part of the daily workspace operations.

```typescript
async function compactClientMemory(
  supabase: SupabaseClient,
  workspaceId: string,
  clientId: string
): Promise<void> {
  // 1. Check flush-before-compact: are all async extractions complete?
  const { data: pendingExtractions } = await supabase
    .from("notes")
    .select("note_id")
    .eq("client_id", clientId)
    .eq("source", "ai_extracted")
    .eq("extraction_status", "pending");

  if (pendingExtractions?.length) {
    // Defer compaction — extractions still pending
    return;
  }

  // 2. Load existing compact summary
  const { data: existingSummary } = await supabase
    .from("memory")
    .select("content, version")
    .eq("client_id", clientId)
    .eq("type", "compact_summary")
    .order("version", { ascending: false })
    .limit(1);

  // 3. Load messages since last compaction
  const lastCompactionDate = existingSummary?.[0]?.created_at ?? "1970-01-01";
  const { data: newMessages } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", /* resolved */)
    .gte("timestamp", lastCompactionDate)
    .order("timestamp", { ascending: true });

  if (!newMessages?.length) return; // No new activity

  // 4. Generate updated summary (cheap LLM call — not the Client Worker)
  const updatedSummary = await llmGateway.chat({
    model: "claude-sonnet", // Cheaper model for summarization
    messages: [
      {
        role: "system",
        content: "Summarize the following conversation updates. Preserve: key facts, decisions, commitments, preferences. Discard: exact wording, greetings, small talk.",
      },
      {
        role: "user",
        content: `Existing summary:\n${existingSummary?.[0]?.content ?? "No prior summary."}\n\nNew messages:\n${formatMessages(newMessages)}`,
      },
    ],
    max_tokens: 1000,
  });

  // 5. Write new memory record
  const newVersion = (existingSummary?.[0]?.version ?? 0) + 1;
  await supabase.from("memory").insert({
    client_id: clientId,
    type: "compact_summary",
    content: updatedSummary.content,
    version: newVersion,
    date: new Date().toISOString().split("T")[0],
  });

  // 6. Update client.summary shortcut field
  await supabase.from("clients").update({
    summary: updatedSummary.content,
  }).eq("client_id", clientId);
}
```

---

## 12. Learning loop

Identical in design to Architecture A sections 8.1-8.8. The implementation difference is that the LearningWorker (Phase 4 async diff classification) runs as a Supabase Edge Function triggered by inserts to the `learning_signals` table where `staff_action = 'edited_and_sent'`.

```sql
-- Trigger: when a learning signal with an edit is recorded,
-- schedule async classification
CREATE OR REPLACE FUNCTION schedule_edit_classification()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.staff_action = 'edited_and_sent' THEN
    PERFORM net.http_post(
      url := current_setting('app.supabase_functions_url') || '/classify-edit',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('signal_id', NEW.signal_id)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_schedule_edit_classification
  AFTER INSERT ON learning_signals
  FOR EACH ROW
  EXECUTE FUNCTION schedule_edit_classification();
```

---

## 13. Multi-tenant and workspace isolation strategy

### 13.1 Single database, logical isolation

All tenants share one Supabase PostgreSQL instance. Isolation is enforced by:

1. **RLS policies** on every table (workspace_id scoping)
2. **Application-level WHERE clauses** in Edge Functions (defense in depth)
3. **Supabase Auth** — each staff member is associated with exactly one workspace
4. **No cross-workspace queries exist in the codebase** — there is no SQL join path that connects data across workspaces

### 13.2 Deployment models

**Model A: Shared multi-tenant (default)**
- One Supabase project, one Vercel deployment
- All workspaces in the same database
- RLS provides isolation
- Cost-efficient: shared infrastructure
- Suitable for MVP and first 50-100 workspaces

**Model B: Dedicated single-tenant**
- One Supabase project + one Vercel deployment per client
- Complete physical isolation
- Higher cost, simpler compliance story
- Used for enterprise clients or regulated industries
- Same codebase — just deployed separately

**Switching between models requires no code changes.** The only difference is the Supabase project URL and keys in environment variables.

### 13.3 Workspace provisioning

New workspace creation:

```typescript
// Triggered during onboarding (WhatsApp-first or web signup)
async function provisionWorkspace(params: {
  businessName: string;
  verticalType: string;
  ownerEmail: string;
  timezone: string;
  instagramHandle?: string;
}): Promise<Workspace> {
  const supabase = createClient(/* service role */);

  // 1. Create workspace record
  const { data: workspace } = await supabase.from("workspaces").insert({
    business_name: params.businessName,
    vertical_type: params.verticalType,
    timezone: params.timezone,
    instagram_handle: params.instagramHandle,
    onboarding_status: "pending",
    vertical_config: getDefaultVerticalConfig(params.verticalType),
  }).select().single();

  // 2. Create staff record linked to Supabase Auth user
  const { data: authUser } = await supabase.auth.admin.createUser({
    email: params.ownerEmail,
    email_confirm: true,
  });

  await supabase.from("staff").insert({
    staff_id: authUser.user.id,
    workspace_id: workspace.workspace_id,
    full_name: params.businessName, // Placeholder, updated during onboarding
    email: params.ownerEmail,
    role: "owner",
  });

  // 3. Create default conversation for onboarding
  // (WhatsApp number linked after WABA setup)

  return workspace;
}
```

---

## 14. Stripe integration

### 14.1 Subscription model

```
Stripe webhook (checkout.session.completed, subscription events)
        │
        ▼
Next.js API route: /api/webhooks/stripe
  - Verifies Stripe webhook signature
  - Maps Stripe customer_id to workspace_id
  - Updates workspace subscription status
  - Enables/disables features based on plan tier
```

### 14.2 Plan tiers and feature gating

```typescript
type PlanTier = "free" | "starter" | "pro" | "enterprise";

const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    messagesPerMonth: 100,
    clients: 20,
    knowledgeChunks: 50,
    learningLoop: false,
    cosOperations: false,
  },
  starter: {
    messagesPerMonth: 1000,
    clients: 100,
    knowledgeChunks: 200,
    learningLoop: false,
    cosOperations: true,
  },
  pro: {
    messagesPerMonth: 5000,
    clients: 500,
    knowledgeChunks: 1000,
    learningLoop: true,
    cosOperations: true,
  },
  enterprise: {
    messagesPerMonth: -1, // Unlimited
    clients: -1,
    knowledgeChunks: -1,
    learningLoop: true,
    cosOperations: true,
  },
};
```

Feature gating is checked in Edge Functions before processing (message limits) and in the staff app before rendering (feature visibility).

---

## 15. Security model

### 15.1 Defense in depth

| Layer | Mechanism | What it protects |
|---|---|---|
| Network | HTTPS everywhere (Supabase enforces TLS, Vercel enforces TLS) | Data in transit |
| Authentication | Supabase Auth (JWT-based, email + password for staff) | Identity verification |
| Authorization | RLS policies on every table | Cross-workspace data access |
| Application | WHERE workspace_id + client_id in every query | Defense in depth (supplements RLS) |
| Agent isolation | Tool parameter injection (runtime, not LLM-controlled) | Cross-client data in LLM context |
| Secrets | Supabase Edge Function secrets (encrypted at rest) | API keys, OAuth tokens |
| Audit | Append-only audit_events table | Accountability, forensics |
| Encryption | Supabase manages encryption at rest (AES-256) | Data at rest |

### 15.2 Secret management

| Secret | Storage | Access |
|---|---|---|
| WhatsApp Cloud API token | Supabase Edge Function secrets | Edge Functions only |
| Google Calendar OAuth tokens | Encrypted workspace.calendar_config JSON | Edge Functions only |
| LLM API keys | Supabase Edge Function secrets | Edge Functions only |
| Stripe webhook secret | Vercel environment variables | Next.js API routes only |
| Supabase service role key | Supabase Edge Function secrets + Vercel env | Both (for different purposes) |

### 15.3 WhatsApp webhook verification

```typescript
function verifyWebhookSignature(body: string, signature: string | null): boolean {
  if (!signature) return false;
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET")!;
  const expectedSig = "sha256=" + hmacSha256(appSecret, body);
  return timingSafeEqual(signature, expectedSig);
}
```

### 15.4 Rate limiting

| Surface | Limit | Mechanism |
|---|---|---|
| WhatsApp webhook | No limit (Meta-controlled) | Dedup by message ID |
| Staff app API | 100 requests/minute per user | Vercel Edge Middleware |
| LLM calls | 1 per inbound message (sequential queue) | Queue serialization |
| Draft regeneration | 5 per conversation per hour | Application logic |
| Edge Function invocations | Supabase plan limits | Supabase-managed |

### 15.5 Data retention and compliance

- Messages retained for 365 days, then archived
- Audit events retained indefinitely
- Client data soft-deleted (never hard-deleted in case of compliance requests)
- GDPR data export: SQL query scoped by workspace_id + client_id exports all client data
- GDPR data deletion: soft-delete client record, anonymize messages

---

## 16. Scaling approach

### 16.1 Scaling characteristics

| Component | Scaling model | Bottleneck | Mitigation |
|---|---|---|---|
| Edge Functions | Auto-scaling (Supabase manages) | Concurrent invocation limit (per plan) | Supabase Pro allows 1000 concurrent, upgrade to Enterprise for more |
| Next.js (Vercel) | Auto-scaling serverless | None at SMB scale | Vercel handles this |
| PostgreSQL | Vertical scaling (Supabase manages) | Connection pooling, query performance | PgBouncer (Supabase built-in), proper indexing, read replicas |
| Supabase Realtime | Auto-scaling | Concurrent connections per plan | Pro plan: 500 concurrent, sufficient for 50+ workspaces |
| LLM API | Rate limits per provider | Provider-imposed RPM/TPM | Queue serialization prevents bursts, multi-provider fallback |

### 16.2 Connection pooling

Supabase provides PgBouncer for connection pooling. Edge Functions use the pooled connection string to avoid exhausting database connections.

```typescript
// Edge Functions use the pooled connection
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {
    db: {
      schema: "public",
    },
    auth: {
      persistSession: false, // Edge Functions are stateless
    },
  }
);
```

### 16.3 Database indexing strategy

```sql
-- Hot path: message processing
CREATE INDEX idx_clients_phone_workspace ON clients(phone_number, workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_conversations_client ON conversations(client_id);
CREATE INDEX idx_messages_conversation_recent ON messages(conversation_id, timestamp DESC);
CREATE INDEX idx_bookings_client_status ON bookings(client_id, status) WHERE status IN ('confirmed', 'at_risk');
CREATE INDEX idx_followups_client_open ON followups(client_id) WHERE status IN ('open', 'pending');
CREATE INDEX idx_notes_client_recent ON notes(client_id, created_at DESC);
CREATE INDEX idx_memory_client_summary ON memory(client_id, type, version DESC) WHERE type = 'compact_summary';

-- Knowledge search (ivfflat index for pgvector)
CREATE INDEX idx_knowledge_embedding ON knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Queue processing
CREATE INDEX idx_inbound_queue_pending ON inbound_queue(created_at ASC) WHERE status = 'pending';
CREATE INDEX idx_inbound_queue_phone_processing ON inbound_queue(from_phone) WHERE status = 'processing';

-- Staff app reads
CREATE INDEX idx_conversations_workspace_recent ON conversations(workspace_id, last_message_at DESC);
CREATE INDEX idx_proposed_actions_workspace_pending ON proposed_actions(workspace_id, created_at DESC) WHERE status = 'pending';
```

### 16.4 Growth milestones

| Scale | Workspaces | Messages/day | Architecture changes needed |
|---|---|---|---|
| MVP | 1-5 | <500 | None — free/Pro tier sufficient |
| Seed | 5-50 | <5,000 | Supabase Pro plan, monitor connection usage |
| Growth | 50-200 | <20,000 | Consider read replicas for staff app, separate Supabase projects for large tenants |
| Scale | 200+ | 20,000+ | Multi-region deployment, dedicated database per large tenant, queue partitioning |

---

## 17. Codebase structure

### 17.1 Monorepo layout

```
/
├── apps/
│   └── web/                              # Next.js App Router (Vercel)
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── (auth)/
│       │   │   ├── login/page.tsx
│       │   │   └── callback/route.ts
│       │   ├── (dashboard)/
│       │   │   ├── layout.tsx
│       │   │   ├── inbox/
│       │   │   │   ├── page.tsx
│       │   │   │   └── [conversationId]/
│       │   │   │       ├── page.tsx
│       │   │   │       └── actions.ts    # Server Actions
│       │   │   ├── today/page.tsx
│       │   │   ├── clients/
│       │   │   │   ├── page.tsx
│       │   │   │   └── [clientId]/page.tsx
│       │   │   └── settings/
│       │   │       ├── page.tsx
│       │   │       ├── knowledge/page.tsx
│       │   │       └── rules/page.tsx
│       │   └── api/
│       │       └── webhooks/
│       │           └── stripe/route.ts
│       ├── components/
│       │   ├── inbox/
│       │   ├── draft-review/
│       │   ├── client-profile/
│       │   └── ui/                       # Shared UI components
│       └── lib/
│           ├── supabase/
│           │   ├── server.ts             # Server client factory
│           │   ├── client.ts             # Browser client factory
│           │   └── middleware.ts          # Auth middleware
│           └── hooks/
│               └── use-realtime.ts       # Realtime subscription hooks
│
├── supabase/
│   ├── functions/
│   │   ├── whatsapp-webhook/index.ts     # Webhook ingestion
│   │   ├── process-message/index.ts      # Core message pipeline
│   │   ├── execute-action/index.ts       # Action execution after approval
│   │   ├── send-message/index.ts         # Outbound WhatsApp message
│   │   ├── daily-cron/index.ts           # Daily cron dispatcher
│   │   ├── daily-workspace-ops/index.ts  # Per-workspace daily operations
│   │   ├── classify-edit/index.ts        # Learning loop: edit classification
│   │   ├── send-push/index.ts            # Web Push notifications
│   │   └── _shared/                      # Shared code across Edge Functions
│   │       ├── context-assembly.ts
│   │       ├── client-worker.ts
│   │       ├── tool-registry.ts
│   │       ├── tool-param-injector.ts
│   │       ├── approval-policy.ts
│   │       ├── system-prompt-builder.ts
│   │       ├── llm-gateway.ts
│   │       └── types.ts
│   ├── migrations/
│   │   ├── 001_core_schema.sql
│   │   ├── 002_queue_tables.sql
│   │   ├── 003_rls_policies.sql
│   │   ├── 004_functions.sql
│   │   ├── 005_triggers.sql
│   │   ├── 006_indexes.sql
│   │   └── 007_cron_jobs.sql
│   ├── seed.sql
│   └── config.toml
│
├── packages/
│   └── shared/                           # Shared types and utilities
│       ├── types/
│       │   ├── workspace.ts
│       │   ├── client.ts
│       │   ├── conversation.ts
│       │   ├── message.ts
│       │   ├── draft.ts
│       │   ├── booking.ts
│       │   ├── proposed-action.ts
│       │   └── context.ts
│       ├── schemas/                      # Zod schemas (shared validation)
│       │   ├── tool-schemas.ts
│       │   ├── vertical-config.ts
│       │   └── api-schemas.ts
│       └── utils/
│           ├── phone.ts                  # E.164 normalization
│           ├── token-budget.ts           # Token counting for context assembly
│           └── conversation-state.ts     # State machine transitions
│
├── package.json                          # Workspace root (pnpm/turborepo)
├── turbo.json
└── .env.local                            # Local development secrets
```

### 17.2 Layer responsibilities

| Layer | Location | Responsibility |
|---|---|---|
| **Staff app (reads)** | `apps/web/` | Render staff-facing views. Subscribe to Realtime. Send Server Actions. |
| **Write pipeline (events)** | `supabase/functions/` | Handle webhooks. Process messages. Execute actions. Run crons. |
| **Shared logic** | `supabase/functions/_shared/` | Context assembly, LLM invocation, approval policy, tools. |
| **Shared types** | `packages/shared/` | TypeScript types and Zod schemas used by both apps/web and supabase/functions. |
| **Database** | `supabase/migrations/` | Schema, RLS, functions, triggers, indexes, cron jobs. |

---

## 18. Deployment architecture

### 18.1 Environments

| Environment | Supabase | Vercel | Purpose |
|---|---|---|---|
| Local | `supabase start` (local Docker) | `next dev` | Development |
| Staging | Supabase project (staging) | Vercel preview deployment | Testing with real WhatsApp sandbox |
| Production | Supabase project (production) | Vercel production deployment | Live traffic |

### 18.2 CI/CD pipeline

```
Push to main branch
        │
        ▼
GitHub Actions
  ├── Type check (tsc --noEmit)
  ├── Lint (eslint)
  ├── Unit tests (vitest)
  ├── Integration tests (Supabase local + test DB)
  │
  ├── Deploy Supabase migrations
  │   └── supabase db push (staging/production)
  │
  ├── Deploy Edge Functions
  │   └── supabase functions deploy --all
  │
  └── Deploy Next.js
      └── Vercel auto-deploy from main
```

### 18.3 Local development

```bash
# Start local Supabase (Postgres, Auth, Realtime, Edge Functions, Storage)
supabase start

# Start Next.js dev server
cd apps/web && pnpm dev

# Test webhook locally (using ngrok or similar)
supabase functions serve whatsapp-webhook --env-file .env.local
```

---

## 19. Conversation state machine

Identical to Architecture A. Owned by the `Conversation` entity in shared types.

```typescript
// packages/shared/utils/conversation-state.ts

export type ConversationState =
  | "idle"
  | "awaiting_staff_review"
  | "awaiting_client_reply"
  | "follow_up_pending"
  | "booking_in_progress"
  | "escalated"
  | "payment_pending";

export type ConversationEvent =
  | "inbound_message"
  | "draft_ready"
  | "staff_sends"
  | "staff_discards"
  | "timeout_24h"
  | "followup_draft_ready"
  | "staff_resolves"
  | "booking_confirmed"
  | "escalation_detected";

const TRANSITION_TABLE: Record<ConversationState, Partial<Record<ConversationEvent, ConversationState>>> = {
  idle: {
    inbound_message: "awaiting_staff_review",
  },
  awaiting_staff_review: {
    staff_sends: "awaiting_client_reply",
    staff_discards: "idle",
  },
  awaiting_client_reply: {
    inbound_message: "awaiting_staff_review",
    timeout_24h: "follow_up_pending",
  },
  follow_up_pending: {
    followup_draft_ready: "awaiting_staff_review",
    staff_resolves: "idle",
    inbound_message: "awaiting_staff_review",
  },
  booking_in_progress: {
    inbound_message: "awaiting_staff_review",
    booking_confirmed: "idle",
    timeout_24h: "follow_up_pending",
  },
  escalated: {
    staff_resolves: "idle",
    staff_sends: "awaiting_client_reply",
  },
  payment_pending: {
    inbound_message: "awaiting_staff_review",
    staff_resolves: "idle",
  },
};

export function transition(current: ConversationState, event: ConversationEvent): ConversationState {
  const next = TRANSITION_TABLE[current]?.[event];
  if (!next) {
    throw new Error(`Invalid transition: ${current} + ${event}`);
  }
  return next;
}
```

---

## 20. WhatsApp integration details

### 20.1 Webhook configuration

The WhatsApp webhook URL points directly to the Supabase Edge Function:

```
https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook
```

This is configured in the Meta Developer Portal. The Edge Function handles both:
- GET requests (verification challenge)
- POST requests (message notifications, status updates)

### 20.2 24-hour conversation window

Handled in the `send-message` Edge Function:

```typescript
async function sendWhatsAppMessage(
  supabase: SupabaseClient,
  conversationId: string,
  content: string,
  workspaceId: string
): Promise<SendResult> {
  const { data: conversation } = await supabase
    .from("conversations")
    .select("*, clients(phone_number)")
    .eq("conversation_id", conversationId)
    .single();

  const windowOpen = conversation.last_client_message_at &&
    Date.now() - new Date(conversation.last_client_message_at).getTime() < 24 * 60 * 60 * 1000;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("whatsapp_config")
    .eq("workspace_id", workspaceId)
    .single();

  if (windowOpen) {
    return await sendFreeformMessage(
      workspace.whatsapp_config,
      conversation.clients.phone_number,
      content
    );
  } else {
    const template = await matchTemplate(supabase, workspaceId, content);
    if (template?.status === "approved") {
      return await sendTemplateMessage(
        workspace.whatsapp_config,
        conversation.clients.phone_number,
        template
      );
    } else {
      return { status: "blocked", reason: "window_closed_no_template" };
    }
  }
}
```

### 20.3 Media handling

| Tier | Types | Processing location |
|---|---|---|
| AI-processed | Images, voice notes | Voice: transcribed in `process-message` EF before context assembly. Images: passed to multimodal LLM in Client Worker call. |
| Staff-visible | PDFs, videos | Stored in Supabase Storage. Displayed in staff app. Not sent to LLM. |
| Acknowledged | Location pins, contacts, stickers | Stored as metadata. Agent acknowledges in draft. |

---

## 21. ADR summary

### ADR-B1: PostgreSQL queue over BullMQ + Redis

**Context:** Architecture A uses BullMQ + Redis for message queuing with per-client queue groups.
**Decision:** Use PostgreSQL tables with `FOR UPDATE SKIP LOCKED` for queue semantics and a `NOT EXISTS` subquery for per-client serialization.
**Why:** Eliminates Redis as a separate stateful dependency. Keeps the entire system in one database. PostgreSQL advisory locks and `SKIP LOCKED` provide the same guarantees. Per-client serialization is handled by a SQL subquery instead of Redis queue groups.
**Tradeoff:** Lower throughput ceiling than Redis. PostgreSQL queues work well up to ~10,000 messages/hour. Beyond that, consider dedicated queue infrastructure. For SMB workloads (<5,000 messages/day), this is more than sufficient.
**Consequence:** Zero-Redis deployment. No Redis monitoring, no Redis connection management, no Redis failover.

### ADR-B2: Supabase Edge Functions over Fastify backend

**Context:** Architecture A uses Fastify as the server framework, requiring a persistent Node.js process on Railway/Render/EC2.
**Decision:** All server-side processing runs in Supabase Edge Functions (Deno runtime) and Next.js API routes/Server Actions.
**Why:** Fits the constraint set (Supabase + Vercel, no self-hosted infrastructure). Edge Functions have <50ms cold start, global deployment, and built-in secrets management. The 150-second timeout is sufficient for LLM-powered message processing.
**Tradeoff:** Edge Functions have a 150-second timeout (vs. unlimited for a persistent process). Complex multi-step operations must be designed to complete within this window or be split across multiple function invocations.
**Consequence:** No server to manage. No Docker containers. No uptime monitoring for a backend server.

### ADR-B3: CQRS split between Edge Functions and Next.js

**Context:** Architecture A runs reads and writes through the same Fastify server.
**Decision:** Writes flow through Edge Functions (close to DB). Reads flow through Next.js Server Components with Supabase RLS.
**Why:** Edge Functions run in the same region as the database, minimizing write latency. Next.js Server Components provide excellent DX for building the staff app with streaming and suspense. The two paths communicate only through the database, which simplifies reasoning about consistency.
**Tradeoff:** Two deployment targets to manage (Vercel + Supabase) instead of one. But both are fully managed, so operational burden is minimal.
**Consequence:** Clean separation of concerns. Staff app development can proceed independently of pipeline development.

### ADR-B4: Supabase Realtime over custom WebSocket/SSE

**Context:** Architecture A doesn't specify how the staff app receives live updates.
**Decision:** Use Supabase Realtime (Postgres changes → WebSocket broadcast) for all live updates to the staff app.
**Why:** Built into Supabase, no custom WebSocket server needed. Supports filtering by workspace_id. Integrates with RLS for security. The staff app subscribes to table changes and receives updates automatically when Edge Functions write new drafts, messages, or proposed actions.
**Tradeoff:** Supabase Realtime has a concurrent connection limit per plan (500 on Pro). Each active staff app tab consumes one connection. This is sufficient for SMB workloads.
**Consequence:** Real-time updates work out of the box. No custom pub/sub infrastructure.

### ADR-B5: Database webhooks + pg_cron fallback over pure event-driven

**Context:** In a pure event-driven system, the question is: who triggers the Edge Function when a new message is enqueued?
**Decision:** Dual mechanism: Supabase Database Webhooks (primary, near-instant) + pg_cron polling every 5 seconds (fallback).
**Why:** Database webhooks provide low-latency triggering but are not guaranteed delivery. The pg_cron fallback ensures no message sits unprocessed for more than 5 seconds. Together, they provide at-least-once processing without a persistent listener.
**Tradeoff:** The 5-second fallback introduces a worst-case 5-second delay if the webhook fails. In practice, webhooks work >99% of the time, so this fallback rarely fires.
**Consequence:** No persistent process listening for events. The database itself drives processing through webhooks and scheduled checks.

### ADR-B6: RLS as primary isolation layer, not just application-level WHERE

**Context:** Architecture A relies on application-level WHERE clauses for workspace isolation. If a developer forgets the WHERE clause, data leaks.
**Decision:** Enable RLS on every table with workspace_id-based policies. Application-level WHERE clauses remain as defense in depth.
**Why:** RLS is enforced by PostgreSQL itself, regardless of application bugs. A missing WHERE clause in application code will still be caught by RLS (for staff app queries using the anon key). Edge Functions use the service role which bypasses RLS, but they always include explicit workspace_id filters.
**Tradeoff:** RLS adds query planning overhead (PostgreSQL must evaluate the policy for every query). For simple policies like `workspace_id = auth_workspace_id()`, this overhead is negligible.
**Consequence:** Stronger security guarantees. A developer bug cannot leak cross-workspace data through the staff app.

---

## 22. Risk assessment

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Edge Function 150s timeout exceeded during LLM call | High | Low | Set LLM timeout at 60s. Max 3 tool loop iterations. Save partial results on timeout. |
| PostgreSQL queue performance under high load | Medium | Low | Monitor queue depth. Threshold alert at 100 pending messages. Migrate to dedicated queue if needed. |
| Supabase Realtime connection limits | Medium | Low | Pro plan: 500 connections. Each staff tab = 1 connection. Alert at 80% utilization. |
| Edge Function cold starts adding latency | Low | Medium | Deno runtime has <50ms cold start. Not perceptible for message processing (which takes seconds due to LLM). |
| pg_cron 5-second fallback delay | Low | Low | Acceptable for the rare case where database webhook fails. Staff notification is still < 10 seconds. |
| Database connection exhaustion from Edge Functions | Medium | Medium | PgBouncer (Supabase built-in) manages pooling. Edge Functions use pooled connections. Monitor active connections. |
| LLM provider outage | High | Low | Multi-provider fallback (Claude primary, OpenAI secondary). Conversations continue without AI — staff handles manually. |

---

## 23. Comparison: when to choose Architecture A vs. B

| Factor | Choose Architecture A | Choose Architecture B |
|---|---|---|
| Team has Node.js backend expertise | Yes | Either |
| Team prefers Deno/Edge Functions | No | Yes |
| Need to minimize infrastructure | No — requires Redis + backend server | Yes — two managed services only |
| Message volume > 10,000/hour | Yes — Redis handles high throughput | No — PostgreSQL queue has lower ceiling |
| Need custom WebSocket features | Yes — full control | No — Supabase Realtime covers common cases |
| Budget for infrastructure ops | Yes — server monitoring, Redis ops | No — fully managed |
| Compliance requires dedicated infra | Either (deploy per-tenant) | Either (deploy per-tenant) |
| Want to stay within Supabase ecosystem | No — exits ecosystem with Redis + Fastify | Yes — everything is Supabase-native |

**Recommendation for this project:** Architecture B. The PRD targets SMBs with <5,000 messages/day per workspace. The MVP needs to ship fast with minimal ops burden. Supabase + Vercel covers the entire infrastructure need. PostgreSQL queues handle the throughput. Edge Functions eliminate the need for a backend server. The tradeoffs (150s timeout, lower queue throughput ceiling) are acceptable for the target scale.

---

## Appendix A: Verification questions and answers

### Q1: Can a Supabase Edge Function complete the full message processing pipeline (context assembly + LLM call + tool loop + DB writes) within the 150-second timeout?

**Answer:** Yes, with proper timeout management. Context assembly involves ~8 parallel Supabase queries — each takes 10-50ms. Total assembly time: ~100ms. LLM call with tool use: typically 3-15 seconds per iteration, maximum 3 iterations = ~45 seconds worst case. DB writes: ~50ms. Total worst case: ~50 seconds. Well within the 150-second limit. The risk is a very slow LLM response; this is mitigated by setting a 60-second timeout on the LLM call and saving partial results if the function approaches its time limit.

### Q2: Does the PostgreSQL queue (FOR UPDATE SKIP LOCKED) provide the same ordering guarantees as BullMQ queue groups?

**Answer:** Not exactly identical, but equivalent for our needs. BullMQ queue groups guarantee FIFO order per group key. Our PostgreSQL queue guarantees that no two messages from the same phone number are processed concurrently (via the `NOT EXISTS` subquery). Combined with `ORDER BY created_at ASC`, messages for a given client are processed in insertion order. The difference: BullMQ actively dispatches in order, while our approach is pull-based with a "skip if busy" strategy. Both prevent concurrent processing of the same client's messages, which is the actual requirement.

### Q3: What happens when the Supabase Database Webhook fails to trigger the process-message Edge Function?

**Answer:** The pg_cron fallback runs every 5 seconds and checks for pending messages. If any exist, it invokes the process-message Edge Function. Worst case: a message sits unprocessed for up to 5 seconds. The stuck-message recovery cron (every 1 minute) handles messages that were picked up but never completed (e.g., Edge Function crashed). After 3 failed attempts, messages move to dead_letter for manual review. No message is lost.

### Q4: How does RLS interact with Edge Functions that use the service role key?

**Answer:** The service role key bypasses RLS entirely. This is by design — Edge Functions are trusted server-side code that handles system-level operations (webhook processing, cron jobs, action execution). They always include explicit `WHERE workspace_id = $1` filters in their queries. RLS protects the staff app path, where queries use the anon key with the user's JWT. This creates two isolation layers: RLS for the staff app (enforced by Postgres), and application-level WHERE clauses for Edge Functions (enforced by code review and testing). A bug in Edge Function code could theoretically access cross-workspace data, but a bug in the staff app cannot.

### Q5: Can Supabase Realtime handle the notification latency requirement (< 5 seconds for new message notification)?

**Answer:** Yes. Supabase Realtime uses PostgreSQL's built-in replication stream to detect changes. The typical latency from INSERT to WebSocket broadcast is 50-200ms. Combined with the webhook-triggered processing pipeline (which adds the LLM processing time), the total time from WhatsApp message to staff notification is: webhook receipt (<100ms) + Edge Function invocation (<200ms) + context assembly (~100ms) + LLM call (3-15s) + draft save (<50ms) + Realtime broadcast (<200ms) = approximately 4-16 seconds. The bottleneck is the LLM call, not the notification infrastructure. For the "new message received" notification (before AI processing), we can send an immediate notification when the message is stored, and a second notification when the draft is ready. This achieves < 1 second for "message received" and < 20 seconds for "draft ready."

---

## Appendix B: Revisions made after verification

After working through the five verification questions, the following revisions were made to this document:

1. **Added dual notification pattern (Section 8.2):** The original design only notified staff when the draft was ready. After analyzing Q5's latency calculation, I added the recommendation to send an immediate "message received" notification when the inbound message is stored (before AI processing), and a separate "draft ready" notification when the AI completes. This achieves the < 5 second notification target for message awareness while allowing the LLM processing to take its natural time.

2. **Added partial result saving on timeout (Section 5.3):** Q1's analysis showed that while the typical processing time is well within the 150-second limit, an adversarial case (slow LLM + maximum tool iterations) could approach it. Added explicit handling: check elapsed time before each tool iteration, and if approaching the limit, save partial results and mark the message for retry with continuation from saved state.

3. **Clarified RLS vs. service role interaction (Section 4.3 and Q4):** The original text implied RLS protects all paths equally. After Q4's analysis, I clarified that RLS is the primary protection for the staff app (anon key path) and a defense-in-depth measure documented for Edge Functions (service role path). This is an honest characterization — Edge Functions bypass RLS by design, and application-level WHERE clauses are the primary isolation mechanism in that path.

4. **Added immediate notification trigger (Section 8.2):** Added a database trigger on message INSERT that sends a Web Push notification immediately, separate from the draft-ready notification. This ensures staff awareness within seconds, even if the LLM takes 15+ seconds to generate a draft.

5. **Added dead letter queue handling (Section 3.2):** The original retry logic did not specify what happens to messages that exceed max attempts. Added explicit `dead_letter` status and the expectation of manual review, preventing infinite retry loops.
