# System Architecture Specification v2.0

**System:** WhatsApp-First AI Client Ops Manager (Platform Template)
**Stack:** Next.js (App Router) + Supabase + Stripe + WhatsApp Cloud API + Claude/OpenAI
**Hosting:** Vercel (app) + Supabase (data + edge functions + realtime)
**Status:** Architecture proposal -- ready for engineering review
**Companion documents:** PRD v2.1, Architecture ADR v1.0

---

## 0. Architecture decision summary

Before diving into details, this section captures the key architectural decisions and their rationale. Each decision addresses a tension between the PRD requirements and the deployment constraints.

| # | Decision | Choice | Alternatives considered | Rationale |
|---|----------|--------|------------------------|-----------|
| 1 | Message queue | Supabase `pgmq` + Edge Functions | BullMQ+Redis, SQS, Inngest | No external infrastructure. Postgres-native. Fits Supabase-only constraint. Edge Functions provide the worker. |
| 2 | Webhook handler | Supabase Edge Function (Deno) | Vercel API route, AWS Lambda | Sub-50ms cold start. Runs at edge. Decoupled from Next.js deployment cycle. Webhook verification needs raw body access. |
| 3 | Staff app framework | Next.js App Router on Vercel | Remix, plain React SPA | PRD constraint. Server components for initial data loading. Client components for realtime. |
| 4 | Agent runtime | Supabase Edge Function (long-running) | Vercel serverless function, dedicated server | Needs up to 30s for LLM + tool loop. Supabase Edge Functions support 150s wall time. Direct Supabase client access with service role. |
| 5 | Realtime delivery | Supabase Realtime (Postgres changes) | Pusher, Ably, SSE from Vercel | Built into Supabase. RLS-aware. No additional service. Staff app subscribes to filtered channels. |
| 6 | Cron jobs | Supabase `pg_cron` + Edge Functions | Vercel Cron, external scheduler | Runs inside the database. Can trigger Edge Functions via `pg_net`. Timezone-aware scheduling per workspace. |
| 7 | Multi-tenant model | Single Supabase project, RLS isolation | Separate project per tenant, schema-per-tenant | Simpler operations. RLS enforces isolation. Scales to hundreds of workspaces on Pro tier. Single-tenant deployment also possible (same code, one workspace row). |
| 8 | Payment/subscription | Stripe Checkout + webhooks | LemonSqueezy, manual invoicing | Industry standard. Webhook-driven subscription lifecycle. Vercel-friendly. |
| 9 | Knowledge embeddings | `pgvector` in Supabase | Pinecone, Weaviate | No external service. Postgres-native. Supabase has first-class pgvector support. |
| 10 | LLM provider | Claude (primary) via Anthropic API | OpenAI, OpenRouter | Best tool-calling reliability. Structured output. Competitive pricing. OpenAI as fallback. |

---

## 1. System diagram

### 1.1 High-level component diagram

```
                                   EXTERNAL SERVICES
                    ┌──────────────────────────────────────────────┐
                    │                                              │
                    │   WhatsApp         Google          Stripe    │
                    │   Cloud API        Calendar        API       │
                    │      │               │              │        │
                    └──────┼───────────────┼──────────────┼────────┘
                           │               │              │
            ═══════════════╪═══════════════╪══════════════╪═══════════════════
                           │               │              │
                    ┌──────▼───────┐       │       ┌──────▼───────┐
                    │  Edge Fn:    │       │       │  Edge Fn:    │
                    │  Webhook     │       │       │  Stripe      │
                    │  Receiver    │       │       │  Webhook     │
                    └──────┬───────┘       │       └──────┬───────┘
                           │               │              │
            ═══════════════╪═══════════════╪══════════════╪═══════ SUPABASE ══
                           │               │              │
                    ┌──────▼───────────────┼──────────────▼───────┐
                    │                      │                      │
                    │              PostgreSQL Database             │
                    │                      │                      │
                    │  ┌─────────┐  ┌──────┴──────┐  ┌─────────┐ │
                    │  │  pgmq   │  │   Tables    │  │pgvector │ │
                    │  │ (queue) │  │ (all data)  │  │(embeds) │ │
                    │  └────┬────┘  └──────┬──────┘  └─────────┘ │
                    │       │              │                      │
                    │  ┌────┴──────────────┴──────────────┐      │
                    │  │        Row Level Security        │      │
                    │  └─────────────────────────────────-┘      │
                    │                                             │
                    │  ┌──────────────┐  ┌──────────────────┐    │
                    │  │   pg_cron    │  │ Supabase Realtime │    │
                    │  │  (scheduled) │  │  (live updates)   │    │
                    │  └──────┬───────┘  └────────┬─────────┘    │
                    └─────────┼───────────────────┼──────────────┘
                              │                   │
                    ┌─────────▼──────────┐        │
                    │   Edge Functions   │        │
                    │                    │        │
                    │  ┌──────────────┐  │        │
                    │  │ Agent Worker │  │        │
                    │  │ (LLM + tools)│  │        │
                    │  └──────────────┘  │        │
                    │  ┌──────────────┐  │        │
                    │  │ Compaction   │  │        │
                    │  │ Worker       │  │        │
                    │  └──────────────┘  │        │
                    │  ┌──────────────┐  │        │
                    │  │ COS Daily    │  │        │
                    │  │ Worker       │  │        │
                    │  └──────────────┘  │        │
                    │  ┌──────────────┐  │        │
                    │  │ Learning     │  │        │
                    │  │ Worker       │  │        │
                    │  └──────────────┘  │        │
                    └────────────────────┘        │
                                                  │
            ══════════════════════════════════════ │ ══════════════════════════
                                                  │
                    ┌─────────────────────────────-┼──────────────┐
                    │              Vercel           │              │
                    │                              │              │
                    │  ┌──────────────────────────-┤              │
                    │  │  Next.js App Router       │              │
                    │  │                           │              │
                    │  │  ┌──────────────────┐     │              │
                    │  │  │ Server Components│     │              │
                    │  │  │ (SSR data load)  │     │              │
                    │  │  └──────────────────┘     │              │
                    │  │  ┌──────────────────┐     │              │
                    │  │  │ Client Components│◄────┘              │
                    │  │  │ (Realtime sub)   │  Supabase Realtime │
                    │  │  └──────────────────┘                    │
                    │  │  ┌──────────────────┐                    │
                    │  │  │  API Routes      │                    │
                    │  │  │  (staff actions) │                    │
                    │  │  └──────────────────┘                    │
                    │  └──────────────────────────────────────────│
                    └─────────────────────────────────────────────┘
```

### 1.2 Data flow legend

```
WhatsApp message → [1] Edge Fn: Webhook Receiver
                   [2] Verify signature, deduplicate, enqueue to pgmq
                   [3] pg_notify triggers Edge Fn: Agent Worker
                   [4] Agent Worker dequeues, resolves client, assembles context
                   [5] Single LLM call (Claude) with tools
                   [6] Proposed actions + draft saved to DB
                   [7] Supabase Realtime pushes update to staff app
                   [8] Staff reviews, edits, approves
                   [9] Next.js API route sends approved message via WhatsApp API
                   [10] Delivery status webhook updates message record
```

---

## 2. Component breakdown

### 2.1 Supabase Edge Functions

All server-side processing runs as Supabase Edge Functions (Deno runtime). This eliminates the need for a persistent server, Redis, or BullMQ. Each function is independently deployable.

| Edge Function | Trigger | Responsibility | Timeout |
|---|---|---|---|
| `webhook-whatsapp` | HTTP POST from Meta | Verify webhook signature, parse payload, deduplicate by `wamid`, normalize phone number, enqueue message to `pgmq` queue, return 200 immediately | 5s |
| `webhook-stripe` | HTTP POST from Stripe | Verify Stripe signature, process subscription events (created, updated, cancelled, payment_failed), update workspace subscription status | 5s |
| `agent-worker` | `pg_notify` via database trigger on pgmq enqueue, or HTTP invoke from cron | Dequeue message, resolve/create client, assemble context, invoke LLM, process tool calls, save draft + proposed actions, update conversation state | 60s |
| `compaction-worker` | HTTP invoke from `pg_cron` | For each workspace (by timezone), compact active client conversations. One LLM summarization call per client. | 150s |
| `cos-worker` | HTTP invoke from `pg_cron` | COS operations: surface overdue follow-ups, stale conversations, unconfirmed bookings. Generate ranked action list. Queue Client Worker invocations for follow-up drafts. | 60s |
| `learning-worker` | HTTP invoke (async, post-send) | Classify draft edits via LLM. Update pattern recurrence. Check promotion thresholds. | 30s |
| `media-processor` | HTTP invoke from agent-worker | Voice note transcription (Whisper API). Image storage to Supabase Storage. Returns transcription text for context assembly. | 30s |
| `knowledge-indexer` | HTTP invoke on knowledge update | Chunk text, generate embeddings, upsert to pgvector. | 30s |
| `onboarding-worker` | HTTP invoke from staff app | Instagram scraping, SOP generation via deep research, tone profile extraction. Long-running onboarding tasks. | 150s |

### 2.2 Next.js App Router (Vercel)

The staff-facing web application. Server Components for initial data loading, Client Components for realtime updates and interactions.

| Route/Component | Type | Responsibility |
|---|---|---|
| `/app/(auth)/login` | Server + Client | Supabase Auth login flow |
| `/app/(dashboard)/inbox` | Server + Client | Conversation list with realtime updates. Priority/recency sort. Unread badges. Filter by state. |
| `/app/(dashboard)/inbox/[conversationId]` | Server + Client | Full conversation thread. AI draft panel. Client snapshot sidebar. Send/edit/reprompt controls. Confirmation cards for proposed actions. |
| `/app/(dashboard)/today` | Server + Client | Today's view: appointments, follow-ups, at-risk bookings. COS-generated action list. |
| `/app/(dashboard)/clients` | Server + Client | Client list. Search. Lifecycle filter. |
| `/app/(dashboard)/clients/[clientId]` | Server + Client | Full client profile. Conversation history. Bookings. Notes. Follow-ups. Custom fields. |
| `/app/(dashboard)/settings` | Server + Client | Knowledge editor + document upload. Tone config. SOP editor. Calendar connection (OAuth). WhatsApp config. Learned rules (view/toggle). Billing (Stripe Customer Portal). |
| `/app/api/messages/send` | API Route | Send staff-approved message via WhatsApp API. Handles 24h window check. Records learning signal. |
| `/app/api/actions/approve` | API Route | Process staff approval of proposed action. Execute via Supabase service role. |
| `/app/api/actions/reject` | API Route | Process staff rejection. Update proposed action status. |
| `/app/api/drafts/reprompt` | API Route | Invoke agent-worker with staff instruction for draft regeneration. |
| `/app/api/notes/create` | API Route | Immediate note save. No LLM blocking. |
| `/app/api/stripe/checkout` | API Route | Create Stripe Checkout session for subscription. |
| `/app/api/stripe/portal` | API Route | Create Stripe Customer Portal session for billing management. |

### 2.3 Database (Supabase PostgreSQL)

All persistent state lives in PostgreSQL. Extensions used:

| Extension | Purpose |
|---|---|
| `pgvector` | Knowledge base embeddings and semantic search |
| `pgmq` | Durable message queue for webhook-to-worker pipeline |
| `pg_cron` | Scheduled jobs (compaction, COS, inactivity detection) |
| `pg_net` | HTTP calls from database triggers/cron to Edge Functions |
| `pgjwt` | JWT verification within RLS policies |

### 2.4 External integrations

| Service | Integration pattern | Auth |
|---|---|---|
| WhatsApp Cloud API | Webhooks (inbound) + REST API (outbound) | Verify token + app secret HMAC for webhooks. System user access token for sending. |
| Google Calendar | REST API via `googleapis` | OAuth 2.0 per workspace. Tokens stored encrypted in workspace record. Refresh token rotation. |
| Stripe | Checkout (redirect) + webhooks + Customer Portal | Stripe secret key. Webhook signing secret for verification. |
| Anthropic (Claude) | REST API | API key per deployment (not per workspace). |
| OpenAI (Whisper) | REST API for transcription | API key per deployment. |

---

## 3. Message pipeline

The pipeline from WhatsApp message receipt to staff notification. This replaces BullMQ+Redis with Supabase-native components.

### 3.1 Pipeline stages

```
STAGE 1: INGESTION (Edge Function: webhook-whatsapp, <100ms)
──────────────────────────────────────────────────────────────
  Meta Cloud API POST /webhook-whatsapp
       │
       ├─ 1. Verify X-Hub-Signature-256 (HMAC-SHA256 of raw body)
       │     Reject immediately if invalid. Return 200 on valid.
       │
       ├─ 2. Parse webhook payload
       │     Extract: wamid, from (phone), timestamp, message body/media
       │
       ├─ 3. Deduplicate by wamid
       │     INSERT INTO message_inbox (wamid, ...) ON CONFLICT (wamid) DO NOTHING
       │     If conflict (duplicate), stop processing, return 200
       │
       └─ 4. Enqueue to pgmq
             SELECT pgmq.send('inbound_messages', payload::jsonb)
             Return 200 to Meta immediately


STAGE 2: RESOLUTION (Edge Function: agent-worker, first 2s)
──────────────────────────────────────────────────────────────
  Triggered by: database trigger on pgmq enqueue → pg_notify → Edge Function
       │
       ├─ 5. Dequeue from pgmq
       │     SELECT pgmq.read('inbound_messages', vt := 60, qty := 1)
       │     Visibility timeout = 60s (message invisible to other workers)
       │
       ├─ 6. Phone number normalization (E.164)
       │
       ├─ 7. Workspace resolution
       │     Match inbound phone_number_id to workspace.whatsapp_config
       │
       ├─ 8. Client find-or-create
       │     SELECT ... WHERE workspace_id = $1 AND phone_number = $2
       │     If not found: INSERT new client with lifecycle_status = 'open'
       │
       ├─ 9. Conversation find-or-create
       │     One conversation per client per workspace (WhatsApp channel)
       │
       ├─ 10. Save raw inbound message to Message table
       │
       ├─ 11. Media pre-processing (if applicable)
       │      Voice note → invoke media-processor for transcription
       │      Image → store to Supabase Storage, get URL
       │
       └─ 12. Update conversation.last_client_message_at (24h window tracking)


STAGE 3: CONTEXT ASSEMBLY (same Edge Function invocation, ~500ms)
──────────────────────────────────────────────────────────────────
       │
       ├─ 13. Session key resolution
       │      workspace:{workspace_id}:client:{client_id}
       │
       └─ 14. Deterministic context assembly
              assembleContext(workspaceId, clientId, inboundMessage)
              │
              ├─ Global: workspace config, vertical config, tone profile
              ├─ Global: learned communication rules
              ├─ Global: knowledge semantic search (pgvector) on message text
              ├─ Client: profile + vertical custom fields
              ├─ Client: latest compact summary
              ├─ Client: last 10 messages
              ├─ Client: active bookings
              ├─ Client: active follow-ups
              ├─ Client: recent notes (last 5)
              ├─ Client: conversation state
              └─ Current: inbound message (text + any transcription)


STAGE 4: AGENT INVOCATION (same Edge Function, 3-15s)
─────────────────────────────────────────────────────-
       │
       ├─ 15. Build system prompt from assembled context
       │
       ├─ 16. Single LLM call (Claude) with tool definitions
       │      Tools: knowledge_search, calendar_query, calendar_book,
       │             update_client_record, create_note, create_followup
       │
       ├─ 17. Tool call loop (if tools invoked)
       │      Each tool call: inject workspaceId + clientId from session
       │      Execute tool, return result, continue LLM generation
       │      Max 3 tool rounds per invocation
       │
       └─ 18. Extract outputs
              ├─ Draft reply text (model's text response)
              ├─ ProposedAction[] from propose_write tools
              ├─ Auto-executed results from auto_write tools
              └─ Intent classification + confidence score


STAGE 5: APPROVAL + NOTIFICATION (<500ms)
─────────────────────────────────────────-
       │
       ├─ 19. Save Draft record
       │      (content, intent, confidence, knowledge_sources)
       │
       ├─ 20. Evaluate approval policy for each ProposedAction
       │      ├─ auto → execute immediately, audit log
       │      ├─ review → save ConfirmationRequest, status = pending
       │      └─ human_only → flag conversation, skip draft
       │
       ├─ 21. Transition conversation state → 'awaiting_staff_review'
       │
       ├─ 22. Archive pgmq message (mark processed)
       │      SELECT pgmq.archive('inbound_messages', msg_id)
       │
       └─ 23. Staff notification
              ├─ Database INSERT/UPDATE triggers Supabase Realtime
              │   (staff app receives live update via subscription)
              └─ Web push notification via service worker
```

### 3.2 Webhook reliability guarantees

WhatsApp Cloud API has specific retry behavior that the webhook handler must accommodate.

| Concern | Solution |
|---|---|
| **Duplicate delivery** | Deduplicate by `wamid` (WhatsApp message ID). `message_inbox` table with `UNIQUE(wamid)`. `ON CONFLICT DO NOTHING`. |
| **Out-of-order messages** | Messages stored with WhatsApp-provided `timestamp`. Display order uses this timestamp. Processing order is FIFO from pgmq but the agent sees all recent messages sorted by timestamp. |
| **Webhook timeout** | Edge Function returns 200 immediately after enqueue (Stage 1). All processing is async in Stage 2-5. Meta requires response within 20 seconds. |
| **Worker failure** | pgmq visibility timeout (60s). If worker crashes, message becomes visible again for retry. Max 3 retries tracked via `read_ct`. After 3 failures, move to dead letter queue (`pgmq.send('inbound_dlq', ...)`). |
| **Idempotent processing** | Agent-worker checks if message already has a draft before processing. If draft exists for this message_id, skip. This handles the case where the worker processed the message but crashed before archiving from pgmq. |

### 3.3 pgmq as message queue

`pgmq` is a Postgres extension that provides durable, exactly-once message queue semantics within the database. It replaces BullMQ+Redis.

```sql
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

-- Dequeue (from agent-worker, with 60s visibility timeout)
SELECT * FROM pgmq.read('inbound_messages', 60, 1);

-- Archive after successful processing
SELECT pgmq.archive('inbound_messages', $msg_id);

-- Move to DLQ after max retries
-- (checked in agent-worker: if read_ct > 3, send to DLQ)
```

**Per-client serialization:** Unlike BullMQ queue groups, pgmq does not natively support per-key ordering. The agent-worker handles this with an advisory lock:

```sql
-- Acquire advisory lock for this client before processing
SELECT pg_try_advisory_lock(hashtext($session_key));
-- If lock not acquired, re-enqueue with 5s delay
-- If acquired, process message, then release lock
SELECT pg_advisory_unlock(hashtext($session_key));
```

This prevents concurrent processing of messages from the same client while allowing parallel processing across clients.

---

## 4. Data architecture

### 4.1 Schema overview

The universal Supabase schema. Deployed identically for every workspace. Vertical-specific data lives in JSON columns. The schema follows the PRD data model (Section 12) with additions for the serverless architecture.

All tables include `workspace_id` for multi-tenant isolation via RLS. Tables are listed in dependency order.

### 4.2 Core tables

```sql
-- ============================================================
-- WORKSPACE
-- ============================================================
CREATE TABLE workspace (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name   TEXT NOT NULL,
  vertical_type   TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  business_hours  JSONB NOT NULL DEFAULT '{}',
  tone_profile    TEXT,
  vertical_config JSONB NOT NULL DEFAULT '{}',
  communication_profile JSONB DEFAULT '{}',
  instagram_handle TEXT,
  whatsapp_config JSONB NOT NULL DEFAULT '{}',
  -- whatsapp_config: { phone_number_id, waba_id, access_token_encrypted, verify_token, webhook_secret }
  calendar_config JSONB,
  -- calendar_config: { access_token_encrypted, refresh_token_encrypted, calendar_id, token_expiry }
  onboarding_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (onboarding_status IN (
      'pending','instagram_scraped','sop_configured',
      'tone_set','calendar_connected','complete'
    )),
  -- Stripe subscription
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  subscription_status   TEXT NOT NULL DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing','active','past_due','cancelled','paused')),
  subscription_plan     TEXT DEFAULT 'free',
  trial_ends_at         TIMESTAMPTZ,
  -- Metadata
  owner_user_id   UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for webhook routing (phone_number_id -> workspace)
CREATE INDEX idx_workspace_whatsapp ON workspace
  USING gin(whatsapp_config jsonb_path_ops);

-- ============================================================
-- STAFF (references Supabase Auth)
-- ============================================================
CREATE TABLE staff (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  user_id       UUID NOT NULL REFERENCES auth.users(id),
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone_number  TEXT,
  role          TEXT NOT NULL DEFAULT 'operator'
    CHECK (role IN ('owner','operator')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX idx_staff_workspace ON staff(workspace_id);
CREATE INDEX idx_staff_user ON staff(user_id);

-- ============================================================
-- CLIENT
-- ============================================================
CREATE TABLE client (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspace(id),
  full_name         TEXT,
  phone_number      TEXT NOT NULL,
  email             TEXT,
  lifecycle_status  TEXT NOT NULL DEFAULT 'open'
    CHECK (lifecycle_status IN (
      'open','chosen_service','upcoming_appointment',
      'follow_up','review_complete','inactive'
    )),
  tags              TEXT[] DEFAULT '{}',
  preferences       JSONB DEFAULT '{}',
  -- preferences holds vertical custom field values keyed by field key
  last_contacted_at TIMESTAMPTZ,
  summary           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE(workspace_id, phone_number)
);

CREATE INDEX idx_client_workspace ON client(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_client_phone ON client(workspace_id, phone_number) WHERE deleted_at IS NULL;
CREATE INDEX idx_client_lifecycle ON client(workspace_id, lifecycle_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_client_last_contact ON client(workspace_id, last_contacted_at) WHERE deleted_at IS NULL;

-- ============================================================
-- CONVERSATION
-- ============================================================
CREATE TABLE conversation (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            UUID NOT NULL REFERENCES workspace(id),
  client_id               UUID NOT NULL REFERENCES client(id),
  channel                 TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp')),
  state                   TEXT NOT NULL DEFAULT 'idle'
    CHECK (state IN (
      'idle','booking_in_progress','awaiting_client_reply',
      'awaiting_staff_review','follow_up_pending','payment_pending'
    )),
  version                 INTEGER NOT NULL DEFAULT 1,
  last_message_at         TIMESTAMPTZ,
  last_client_message_at  TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, client_id, channel)
);

CREATE INDEX idx_conversation_workspace ON conversation(workspace_id);
CREATE INDEX idx_conversation_client ON conversation(client_id);
CREATE INDEX idx_conversation_state ON conversation(workspace_id, state);

-- ============================================================
-- MESSAGE
-- ============================================================
CREATE TABLE message (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspace(id),
  conversation_id     UUID NOT NULL REFERENCES conversation(id),
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  content             TEXT,
  media_type          TEXT CHECK (media_type IN (
    'image','voice_note','document','video','location','contact','sticker'
  )),
  media_url           TEXT,
  media_transcription TEXT,
  sender_type         TEXT NOT NULL CHECK (sender_type IN ('client','staff','system')),
  delivery_status     TEXT DEFAULT 'sent' CHECK (delivery_status IN (
    'sent','delivered','read','failed'
  )),
  wamid               TEXT,  -- WhatsApp message ID for dedup + status tracking
  draft_id            UUID,  -- FK set after draft is approved and sent
  timestamp           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_message_conversation ON message(conversation_id, timestamp DESC);
CREATE INDEX idx_message_workspace ON message(workspace_id);
CREATE INDEX idx_message_wamid ON message(wamid) WHERE wamid IS NOT NULL;

-- ============================================================
-- MESSAGE INBOX (deduplication table for webhooks)
-- ============================================================
CREATE TABLE message_inbox (
  wamid       TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed   BOOLEAN NOT NULL DEFAULT false
);

-- ============================================================
-- DRAFT
-- ============================================================
CREATE TABLE draft (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspace(id),
  conversation_id       UUID NOT NULL REFERENCES conversation(id),
  content               TEXT NOT NULL,
  intent_classified     TEXT,
  confidence_score      FLOAT,
  knowledge_sources_used TEXT[],
  staff_action          TEXT CHECK (staff_action IN (
    'sent_as_is','edited_and_sent','regenerated','discarded'
  )),
  edited_content        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           UUID REFERENCES staff(id),
  triggering_message_id UUID REFERENCES message(id)
);

CREATE INDEX idx_draft_conversation ON draft(conversation_id, created_at DESC);
CREATE INDEX idx_draft_workspace ON draft(workspace_id);

-- ============================================================
-- BOOKING
-- ============================================================
CREATE TABLE booking (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspace(id),
  client_id           UUID NOT NULL REFERENCES client(id),
  provider_id         UUID REFERENCES staff(id),
  appointment_type    TEXT NOT NULL,
  start_time          TIMESTAMPTZ NOT NULL,
  end_time            TIMESTAMPTZ NOT NULL,
  calendar_event_id   TEXT,
  status              TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','at_risk','cancelled','completed','no_show')),
  confirmation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (confirmation_status IN ('pending','confirmed','unconfirmed')),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_booking_client ON booking(client_id);
CREATE INDEX idx_booking_workspace ON booking(workspace_id);
CREATE INDEX idx_booking_time ON booking(workspace_id, start_time)
  WHERE status IN ('confirmed','at_risk');

-- ============================================================
-- NOTE
-- ============================================================
CREATE TABLE note (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  client_id   UUID NOT NULL REFERENCES client(id),
  content     TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN (
    'staff_manual','ai_extracted','conversation_update','merge_history'
  )),
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_note_client ON note(client_id, created_at DESC);
CREATE INDEX idx_note_workspace ON note(workspace_id);

-- ============================================================
-- FOLLOW-UP
-- ============================================================
CREATE TABLE followup (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  client_id   UUID NOT NULL REFERENCES client(id),
  type        TEXT NOT NULL CHECK (type IN ('follow_up','promise','reminder')),
  content     TEXT NOT NULL,
  due_date    DATE,
  status      TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','completed','pending','overdue')),
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_followup_client ON followup(client_id);
CREATE INDEX idx_followup_workspace_status ON followup(workspace_id, status)
  WHERE status IN ('open','pending','overdue');
CREATE INDEX idx_followup_due ON followup(workspace_id, due_date)
  WHERE status IN ('open','pending');

-- ============================================================
-- MEMORY (compact summaries + daily logs)
-- ============================================================
CREATE TABLE memory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  client_id   UUID NOT NULL REFERENCES client(id),
  type        TEXT NOT NULL CHECK (type IN ('daily_log','compact_summary')),
  content     TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  date        DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_memory_client ON memory(client_id, type, version DESC);

-- ============================================================
-- KNOWLEDGE CHUNK (with pgvector embedding)
-- ============================================================
CREATE TABLE knowledge_chunk (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  content       TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN (
    'instagram_scrape','manual_upload','settings_editor'
  )),
  source_ref    TEXT,
  embedding     vector(1536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_workspace ON knowledge_chunk(workspace_id);
CREATE INDEX idx_knowledge_embedding ON knowledge_chunk
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- MESSAGE TEMPLATE (WhatsApp pre-approved)
-- ============================================================
CREATE TABLE message_template (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspace(id),
  category              TEXT NOT NULL CHECK (category IN (
    'confirmation','reminder','follow_up','payment','general'
  )),
  name                  TEXT NOT NULL,
  content               TEXT NOT NULL,
  whatsapp_template_id  TEXT,
  status                TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- PROPOSED ACTION (approval boundary)
-- ============================================================
CREATE TABLE proposed_action (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  session_key   TEXT NOT NULL,
  action_type   TEXT NOT NULL CHECK (action_type IN (
    'client_update','booking_create','booking_reschedule',
    'followup_create','message_send','note_create'
  )),
  summary       TEXT NOT NULL,
  tier          TEXT NOT NULL CHECK (tier IN ('auto','review','human_only')),
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired')),
  draft_id      UUID REFERENCES draft(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ,
  reviewed_by   UUID REFERENCES staff(id)
);

CREATE INDEX idx_proposed_action_workspace ON proposed_action(workspace_id, status)
  WHERE status = 'pending';

-- ============================================================
-- AUDIT EVENT
-- ============================================================
CREATE TABLE audit_event (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('ai','staff','system')),
  actor_id      UUID,
  action_type   TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  target_id     UUID,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_workspace ON audit_event(workspace_id, created_at DESC);
-- Partitioned by month for large-scale deployments
-- (defer partitioning to when audit volume justifies it)

-- ============================================================
-- LEARNING SIGNAL
-- ============================================================
CREATE TABLE learning_signal (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspace(id),
  client_id           UUID NOT NULL REFERENCES client(id),
  draft_id            UUID NOT NULL REFERENCES draft(id),
  staff_action        TEXT NOT NULL CHECK (staff_action IN (
    'sent_as_is','edited_and_sent','regenerated','discarded'
  )),
  original_draft      TEXT NOT NULL,
  final_version       TEXT,
  intent_classified   TEXT,
  scenario_type       TEXT,
  edit_categories     TEXT[],
  pattern_key         TEXT,
  severity            TEXT CHECK (severity IN ('minor','significant','rewrite')),
  client_replied      BOOLEAN,
  client_reply_latency_minutes INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_learning_workspace ON learning_signal(workspace_id);
CREATE INDEX idx_learning_pattern ON learning_signal(workspace_id, pattern_key)
  WHERE pattern_key IS NOT NULL;

-- ============================================================
-- COMMUNICATION RULE (promoted from learning loop)
-- ============================================================
CREATE TABLE communication_rule (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspace(id),
  category            TEXT NOT NULL,
  instruction         TEXT NOT NULL,
  confidence          FLOAT NOT NULL DEFAULT 0.5,
  source_pattern_key  TEXT NOT NULL,
  recurrence_count    INTEGER NOT NULL DEFAULT 0,
  active              BOOLEAN NOT NULL DEFAULT true,
  promoted_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comm_rule_workspace ON communication_rule(workspace_id)
  WHERE active = true;
```

### 4.3 Database triggers for realtime

```sql
-- Notify agent-worker when a new message is enqueued
CREATE OR REPLACE FUNCTION notify_new_message()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('new_inbound_message', NEW.msg_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on pgmq internal table (implementation depends on pgmq version)
-- Alternative: use pg_net to HTTP-invoke the agent-worker Edge Function

-- Realtime subscriptions for staff app are handled by Supabase Realtime
-- which listens to Postgres replication stream. No custom triggers needed
-- for: conversation, draft, message, proposed_action tables.
-- Staff app subscribes to workspace-scoped changes via Supabase JS client.
```

### 4.4 Scheduled jobs

```sql
-- Daily compaction: runs at 3 AM for each workspace timezone
-- For MVP, run at 3 AM UTC. Per-timezone scheduling is a Phase 2 enhancement.
SELECT cron.schedule(
  'daily-compaction',
  '0 3 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/compaction-worker',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := '{}'::jsonb
  )$$
);

-- Daily COS operations: runs at 7 AM for each workspace timezone
SELECT cron.schedule(
  'daily-cos',
  '0 7 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/cos-worker',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := '{}'::jsonb
  )$$
);

-- Inactivity detection: mark clients inactive after 30 days
SELECT cron.schedule(
  'inactivity-detection',
  '0 4 * * *',
  $$UPDATE client SET lifecycle_status = 'inactive', updated_at = now()
    WHERE lifecycle_status != 'inactive'
    AND last_contacted_at < now() - interval '30 days'
    AND deleted_at IS NULL$$
);

-- Follow-up overdue detection: update status
SELECT cron.schedule(
  'followup-overdue',
  '0 6 * * *',
  $$UPDATE followup SET status = 'overdue'
    WHERE status IN ('open', 'pending')
    AND due_date < CURRENT_DATE$$
);
```

---

## 5. Security model

### 5.1 Multi-layer security architecture

```
LAYER 1: NETWORK
  ├─ All traffic over TLS 1.3
  ├─ Supabase manages SSL termination
  ├─ Vercel manages SSL for staff app
  └─ Webhook endpoints verify request signatures

LAYER 2: AUTHENTICATION
  ├─ Staff: Supabase Auth (email/password, magic link)
  ├─ Webhooks: HMAC signature verification (WhatsApp, Stripe)
  ├─ Edge Functions: Service role key (server-to-server)
  └─ Google Calendar: OAuth 2.0 with token rotation

LAYER 3: AUTHORIZATION (Row Level Security)
  ├─ Every table has RLS enabled
  ├─ Staff sees only their workspace's data
  ├─ Edge Functions use service_role (bypass RLS) with manual scoping
  └─ No cross-workspace queries are possible through the staff app

LAYER 4: DATA ISOLATION
  ├─ workspace_id on every table
  ├─ Context assembly scoped by workspace_id + client_id
  ├─ Tool parameters injected by runtime, not LLM
  └─ Advisory locks scoped by session key

LAYER 5: AUDIT
  ├─ Every mutation logged to audit_event
  ├─ LLM invocations traced (input tokens, output, tool calls)
  ├─ Staff actions timestamped with actor
  └─ Proposed actions tracked through full lifecycle
```

### 5.2 Row Level Security policies

```sql
-- Enable RLS on all tables
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE client ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE message ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE note ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposed_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_rule ENABLE ROW LEVEL SECURITY;

-- Helper function: get workspace IDs for current user
CREATE OR REPLACE FUNCTION auth.workspace_ids()
RETURNS UUID[] AS $$
  SELECT array_agg(workspace_id)
  FROM staff
  WHERE user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- WORKSPACE: user can see workspaces they belong to
CREATE POLICY workspace_select ON workspace FOR SELECT
  USING (id = ANY(auth.workspace_ids()));

CREATE POLICY workspace_update ON workspace FOR UPDATE
  USING (id = ANY(auth.workspace_ids()))
  WITH CHECK (id = ANY(auth.workspace_ids()));

-- STAFF: user can see staff in their workspace
CREATE POLICY staff_select ON staff FOR SELECT
  USING (workspace_id = ANY(auth.workspace_ids()));

-- CLIENT: scoped to workspace
CREATE POLICY client_select ON client FOR SELECT
  USING (workspace_id = ANY(auth.workspace_ids()));

CREATE POLICY client_insert ON client FOR INSERT
  WITH CHECK (workspace_id = ANY(auth.workspace_ids()));

CREATE POLICY client_update ON client FOR UPDATE
  USING (workspace_id = ANY(auth.workspace_ids()));

-- CONVERSATION: scoped to workspace
CREATE POLICY conversation_all ON conversation FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- MESSAGE: scoped to workspace
CREATE POLICY message_all ON message FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- DRAFT: scoped to workspace
CREATE POLICY draft_all ON draft FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- BOOKING: scoped to workspace
CREATE POLICY booking_all ON booking FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- NOTE: scoped to workspace
CREATE POLICY note_all ON note FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- FOLLOWUP: scoped to workspace
CREATE POLICY followup_all ON followup FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- MEMORY: scoped to workspace
CREATE POLICY memory_all ON memory FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- KNOWLEDGE CHUNK: scoped to workspace
CREATE POLICY knowledge_all ON knowledge_chunk FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- PROPOSED ACTION: scoped to workspace
CREATE POLICY proposed_action_all ON proposed_action FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- AUDIT EVENT: scoped to workspace (read-only for staff)
CREATE POLICY audit_select ON audit_event FOR SELECT
  USING (workspace_id = ANY(auth.workspace_ids()));

-- LEARNING SIGNAL: scoped to workspace
CREATE POLICY learning_all ON learning_signal FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));

-- COMMUNICATION RULE: scoped to workspace
CREATE POLICY comm_rule_all ON communication_rule FOR ALL
  USING (workspace_id = ANY(auth.workspace_ids()));
```

### 5.3 Credential storage

| Credential | Storage | Encryption |
|---|---|---|
| WhatsApp access token | `workspace.whatsapp_config` JSONB | Encrypted at application level before storage. Decrypted only in Edge Functions. Encryption key in Supabase Vault. |
| Google Calendar tokens | `workspace.calendar_config` JSONB | Same pattern. Refresh tokens rotated on use. |
| Stripe customer ID | `workspace.stripe_customer_id` | Not a secret (Stripe-side identifier). |
| LLM API keys | Supabase Edge Function secrets | Environment variables. Never stored in database. Never sent to client. |
| Webhook secrets | Supabase Edge Function secrets | Environment variables. Used for HMAC verification. |

### 5.4 AI-specific security

The LLM is an untrusted component. The architecture treats LLM output as user input that must be validated.

| Threat | Mitigation |
|---|---|
| LLM outputs a tool call with a different client's ID | Tool parameter injection: `workspaceId` and `clientId` are injected by the runtime from the session key. LLM-provided values for these params are overwritten. |
| LLM hallucinates a tool that does not exist | Tool registry validates tool name against allowed set. Unknown tools are rejected. |
| LLM generates harmful content in draft | All drafts require staff review before sending. Staff can edit or discard. |
| Prompt injection via client message | Client messages are placed in the user turn, not the system prompt. System prompt is static template + workspace config. Client data is clearly delimited. |
| Token budget exceeded by long client message | Hard truncation of client messages to 2000 chars. Knowledge search results capped at top-K. |
| LLM cost abuse (repeated reprompting) | Soft limit: 5 regenerations per conversation per day. Tracked in draft table. |

### 5.5 Compliance considerations

| Requirement | Implementation |
|---|---|
| WhatsApp Business API compliance | Opt-in tracking. 24h window enforcement. Pre-approved templates. No unsolicited messaging. |
| Data residency | Supabase project region selection (choose region matching customer base). |
| Data retention | Configurable per workspace. Default: 1 year message retention. Soft delete for clients. |
| Right to erasure | Hard delete function for client data across all tables. Cascading delete with audit trail. |
| Encryption at rest | Supabase manages disk encryption. Application-level encryption for credentials. |
| Encryption in transit | TLS everywhere. No HTTP endpoints. |

---

## 6. AI/LLM integration pattern

### 6.1 Single agent with tools

One LLM invocation per inbound client message. The agent receives a fully-assembled read-only context and a set of typed tools. It returns text (the draft reply) and optionally tool calls (proposed actions).

```
                    CONTEXT ASSEMBLY (deterministic code)
                    ┌─────────────────────────────────────┐
                    │                                     │
                    │  assembleContext(                    │
                    │    workspaceId,                      │
                    │    clientId,                         │
                    │    inboundMessage                    │
                    │  )                                   │
                    │                                     │
                    │  Returns: ReadOnlyContext            │
                    │  - workspace config                  │
                    │  - vertical config / SOP             │
                    │  - learned communication rules       │
                    │  - knowledge chunks (pgvector)       │
                    │  - client profile + custom fields    │
                    │  - compact summary                   │
                    │  - last 10 messages                  │
                    │  - active bookings + follow-ups      │
                    │  - recent notes                      │
                    │  - conversation state                │
                    │  - inbound message                   │
                    └──────────────┬──────────────────────-┘
                                  │
                                  v
                    ┌─────────────────────────────────────┐
                    │         LLM INVOCATION              │
                    │                                     │
                    │  System prompt:                      │
                    │    Role + tone + behavior rules      │
                    │    + vertical SOP                    │
                    │    + learned rules                   │
                    │                                     │
                    │  User context:                       │
                    │    Client profile + summary          │
                    │    + recent messages                 │
                    │    + active items                    │
                    │    + knowledge results               │
                    │    + inbound message                 │
                    │                                     │
                    │  Tools:                              │
                    │    knowledge_search (read)           │
                    │    calendar_query (read)             │
                    │    calendar_book (propose_write)     │
                    │    update_client_record (propose)    │
                    │    create_note (auto_write)          │
                    │    create_followup (propose_write)   │
                    └──────────────┬──────────────────────-┘
                                  │
                          ┌───────┴────────┐
                          │  Tool calls?   │
                          └───┬────────┬───┘
                           No │        │ Yes
                              │        │
                              │   ┌────▼───────────────────────┐
                              │   │  TOOL EXECUTION LOOP       │
                              │   │                            │
                              │   │  For each tool call:       │
                              │   │  1. Validate tool name     │
                              │   │  2. Inject workspaceId,    │
                              │   │     clientId from session  │
                              │   │  3. Validate params (Zod)  │
                              │   │  4. Execute tool           │
                              │   │  5. Return result to LLM   │
                              │   │                            │
                              │   │  Max 3 rounds              │
                              │   └────┬───────────────────────┘
                              │        │
                              ▼        ▼
                    ┌─────────────────────────────────────┐
                    │         OUTPUT EXTRACTION            │
                    │                                     │
                    │  - Draft reply text                  │
                    │  - ProposedAction[] (from tools)     │
                    │  - Auto-executed writes (audit log)  │
                    │  - Intent + confidence               │
                    └─────────────────────────────────────┘
```

### 6.2 Context assembly implementation

```typescript
// Pure function. No side effects. No LLM calls. Deterministic.
// All queries scoped by workspaceId + clientId.

export async function assembleContext(
  workspaceId: string,
  clientId: string,
  inboundMessage: InboundMessage,
  supabase: SupabaseClient  // service role client
): Promise<ClientSessionContext> {

  // ── GLOBAL (workspace-level, same for every client) ──
  const [workspace, knowledgeChunks, communicationRules] = await Promise.all([
    // Workspace config (cached per workspace, invalidated on update)
    supabase.from('workspace').select('*').eq('id', workspaceId).single(),

    // Semantic search for relevant knowledge
    supabase.rpc('match_knowledge', {
      query_embedding: await generateEmbedding(inboundMessage.text),
      match_workspace_id: workspaceId,
      match_threshold: 0.7,
      match_count: 5
    }),

    // Active learned communication rules
    supabase.from('communication_rule')
      .select('instruction, category')
      .eq('workspace_id', workspaceId)
      .eq('active', true)
  ]);

  // ── CLIENT-SCOPED (this client only -- the isolation boundary) ──
  const [client, recentMessages, activeBookings, activeFollowUps, recentNotes, latestSummary, conversation] =
    await Promise.all([
      supabase.from('client').select('*')
        .eq('id', clientId).eq('workspace_id', workspaceId).single(),

      supabase.from('message').select('*')
        .eq('conversation_id', conversationId)
        .order('timestamp', { ascending: false }).limit(10),

      supabase.from('booking').select('*')
        .eq('client_id', clientId).eq('workspace_id', workspaceId)
        .in('status', ['confirmed', 'at_risk'])
        .gte('start_time', new Date().toISOString()),

      supabase.from('followup').select('*')
        .eq('client_id', clientId).eq('workspace_id', workspaceId)
        .in('status', ['open', 'pending', 'overdue']),

      supabase.from('note').select('*')
        .eq('client_id', clientId).eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false }).limit(5),

      supabase.from('memory').select('content')
        .eq('client_id', clientId).eq('type', 'compact_summary')
        .order('version', { ascending: false }).limit(1),

      supabase.from('conversation').select('state, version')
        .eq('client_id', clientId).eq('workspace_id', workspaceId)
        .single()
    ]);

  return {
    sessionKey: `workspace:${workspaceId}:client:${clientId}`,
    workspace: workspace.data,
    verticalConfig: workspace.data.vertical_config,
    communicationRules: communicationRules.data ?? [],
    knowledgeChunks: knowledgeChunks.data ?? [],
    client: client.data,
    compactSummary: latestSummary.data?.[0]?.content ?? null,
    recentMessages: recentMessages.data ?? [],
    activeBookings: activeBookings.data ?? [],
    activeFollowUps: activeFollowUps.data ?? [],
    recentNotes: recentNotes.data ?? [],
    conversationState: conversation.data?.state ?? 'idle',
    conversationVersion: conversation.data?.version ?? 1,
    inboundMessage,
  };
}
```

### 6.3 Tool parameter injection

```typescript
// Critical safety mechanism. The LLM cannot override session-scoped parameters.

export async function executeToolCall(
  call: LLMToolCall,
  session: ClientSessionContext,
  supabase: SupabaseClient
): Promise<ToolResult> {
  const tool = TOOL_REGISTRY[call.name];
  if (!tool) {
    return { error: `Unknown tool: ${call.name}` };
  }

  // Inject session-scoped params -- LLM cannot override these
  const params = {
    ...call.arguments,
    workspaceId: session.workspace.id,     // IMMUTABLE
    clientId: session.client.id,           // IMMUTABLE
  };

  // Validate LLM-provided params against tool schema
  const parseResult = tool.inputSchema.safeParse(params);
  if (!parseResult.success) {
    return { error: `Invalid params: ${parseResult.error.message}` };
  }

  // Execute tool
  const result = await tool.execute(parseResult.data, supabase);

  // If tool authority is auto_write, execute and audit log immediately
  if (tool.authority === 'auto_write') {
    await logAuditEvent(supabase, {
      workspaceId: session.workspace.id,
      actorType: 'ai',
      actionType: `tool_${call.name}`,
      targetEntity: tool.targetEntity,
      targetId: result.id,
      metadata: { params: parseResult.data, result }
    });
  }

  return result;
}
```

### 6.4 Approval boundary

```typescript
export function evaluateApprovalPolicy(
  action: RawProposedAction,
  workspaceConfig: WorkspaceConfig
): ApprovalTier {
  // Fixed trust model for MVP (PRD Section 8)
  const AUTO_ACTIONS = [
    'update_last_contacted',
    'append_summary',
    'save_ai_note',
    'attach_low_risk_tag',
    'read_availability'
  ];

  const HUMAN_ONLY_INTENTS = [
    'refund',
    'pricing_change',
    'policy_exception',
    'complaint',
    'liability'
  ];

  if (AUTO_ACTIONS.includes(action.actionType)) return 'auto';
  if (HUMAN_ONLY_INTENTS.includes(action.intentClassified)) return 'human_only';
  return 'review';  // Everything else requires staff confirmation
}
```

### 6.5 Token budget

| Section | Source | Token budget | Truncation |
|---|---|---|---|
| 1. System prompt | Static + workspace tone | ~1,500 | None (fixed) |
| 2. Tool definitions | Static schemas | ~800 | None (fixed) |
| 3. Vertical SOP | workspace.vertical_config | ~500 | None (configured) |
| 4. Learned rules | communication_rule table | ~500 | Cap at 10 rules |
| 5. Knowledge chunks | pgvector search results | ~2,000 | Top-5 by relevance |
| 6. Client profile | client record + custom fields | ~500 | Omit least-recent tags |
| 7. Compact summary | memory table | ~2,000 | Truncate oldest sections |
| 8. Active items | bookings + follow-ups + notes | ~1,000 | Cap 5 per category |
| 9. Conversation state | state enum | ~100 | None |
| 10. Recent messages | last 10 messages | ~3,000 | Hard cap 10 messages |
| 11. Inbound message | current message | Variable | Truncate at 2,000 chars |
| **Total** | | **~12,400** | |

This fits comfortably within Claude Haiku's 200K context and even within smaller model windows. The tight budget keeps costs low (input tokens are billed) while providing sufficient context for accurate drafting.

---

## 7. Multi-tenant / workspace isolation

### 7.1 Isolation strategy

The system supports two deployment modes with the same codebase:

**Mode A: Multi-tenant (default).** One Supabase project + one Vercel app serves all workspaces. Isolation is enforced by RLS. This is the SaaS model.

**Mode B: Single-tenant.** One Supabase project + one Vercel app per customer. The same schema and code, but only one workspace row exists. This is the dedicated deployment model for enterprise or compliance-sensitive customers.

The code does not change between modes. The difference is operational (how many workspace rows exist in the database).

### 7.2 Isolation enforcement layers

```
LAYER 1: DATABASE (RLS)
  Every SELECT/INSERT/UPDATE includes workspace_id filter.
  Staff app queries go through Supabase client with user JWT.
  RLS policies restrict data to workspaces the user belongs to.

LAYER 2: EDGE FUNCTIONS (service role with manual scoping)
  Edge Functions use service_role key (bypasses RLS for server operations).
  Every query in Edge Functions manually includes workspace_id in WHERE clause.
  The workspace_id is resolved from the webhook payload or pgmq message, not from user input.

LAYER 3: LLM CONTEXT (deterministic assembly)
  Context assembly function takes (workspaceId, clientId) as parameters.
  All queries are double-scoped: workspace_id AND client_id.
  No cross-workspace or cross-client data can enter the context window.

LAYER 4: TOOL EXECUTION (parameter injection)
  workspaceId and clientId are injected by runtime.
  LLM cannot specify or override these parameters.
  Tool implementations validate scope before executing.
```

### 7.3 Workspace limits (MVP, Supabase Pro tier)

| Resource | Limit | Justification |
|---|---|---|
| Workspaces per project | ~200 | RLS performance at Pro tier. Monitor query latency. |
| Clients per workspace | ~5,000 | Index performance. Tested with B-tree on workspace_id + phone_number. |
| Messages per workspace | ~500,000 | Message table with monthly partitioning if needed. |
| Knowledge chunks | ~2,000 per workspace | ivfflat index rebuild time. Increase lists parameter if needed. |
| Concurrent LLM calls | ~10 per project | Edge Function concurrency limit. Queue absorbs bursts. |
| Storage | 100 GB (Pro tier) | Media files in Supabase Storage. |
| Database size | 8 GB (Pro tier) | Monitor and upgrade as needed. |

### 7.4 Supabase Realtime channel structure

Staff app subscribes to workspace-scoped Realtime channels:

```typescript
// Staff app subscription (client-side)
const channel = supabase.channel(`workspace:${workspaceId}`)
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'message',
    filter: `workspace_id=eq.${workspaceId}`
  }, (payload) => {
    // New message received -- update inbox
  })
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'draft',
    filter: `workspace_id=eq.${workspaceId}`
  }, (payload) => {
    // Draft created or updated -- show/update draft panel
  })
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'conversation',
    filter: `workspace_id=eq.${workspaceId}`
  }, (payload) => {
    // Conversation state changed -- update inbox badges
  })
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'proposed_action',
    filter: `workspace_id=eq.${workspaceId}`
  }, (payload) => {
    // New proposed action -- show confirmation card
  })
  .subscribe();
```

Supabase Realtime respects RLS policies. The filter ensures only workspace-scoped events are delivered. Combined with the JWT-based auth, a staff member can only subscribe to changes in workspaces they belong to.

---

## 8. Scaling approach

### 8.1 Scale dimensions

The system needs to handle growth across three dimensions:

| Dimension | MVP target | Scale target | Bottleneck |
|---|---|---|---|
| Workspaces | 1-10 | 200+ | RLS policy evaluation per query |
| Clients per workspace | 50-200 | 5,000+ | Index size, context assembly query count |
| Messages per day per workspace | 50-200 | 2,000+ | pgmq throughput, Edge Function concurrency |

### 8.2 Scaling by component

**PostgreSQL (Supabase)**

| Scale concern | Strategy |
|---|---|
| Read-heavy queries (inbox, client list) | Materialized views for inbox ordering. Read replicas (Supabase Pro add-on). |
| Large message tables | Table partitioning by workspace_id (range) or by month (time). |
| Knowledge search (pgvector) | HNSW index (instead of ivfflat) for larger datasets. Increase `ef_search`. |
| Connection pooling | Supabase uses PgBouncer in transaction mode. Edge Functions use pooled connections. |
| Audit event volume | Partition by month. Archive to cold storage after 90 days. |

**pgmq (message queue)**

| Scale concern | Strategy |
|---|---|
| Message throughput | pgmq handles thousands of messages/second within Postgres. Not a bottleneck for SMB scale. |
| Worker concurrency | Multiple Edge Function instances dequeue in parallel. Advisory locks prevent per-client conflicts. |
| Queue depth during spikes | pgmq is durable (Postgres table). Messages accumulate safely. Workers process at their own pace. |

**Edge Functions (Supabase)**

| Scale concern | Strategy |
|---|---|
| Concurrency limits | Supabase Pro: 100 concurrent Edge Functions. Queue absorbs bursts beyond this. |
| Cold start latency | Deno runtime: ~50ms cold start. Acceptable for async worker. Webhook handler is latency-sensitive but lightweight. |
| Long-running LLM calls | Agent-worker uses up to 60s. Supabase supports 150s max. If LLM latency increases, add timeout with retry. |

**Vercel (Next.js)**

| Scale concern | Strategy |
|---|---|
| Static rendering | ISR for settings pages. SSR for inbox. Client-side for realtime. |
| API route latency | API routes are lightweight (validate + forward to Supabase). No heavy computation. |
| Serverless function limits | Vercel Pro: 300 concurrent serverless functions. Staff app API routes are fast (<500ms). |

**LLM API**

| Scale concern | Strategy |
|---|---|
| Rate limits | Anthropic tier-based rate limits. Apply for higher tier as volume grows. |
| Cost per message | Track token usage per workspace per day. Alert on anomalies. Hard cap on monthly spend per workspace. |
| Latency spikes | Circuit breaker pattern (cockatiel). Retry with exponential backoff. Degrade gracefully (notify staff that draft is delayed). |

### 8.3 Horizontal scaling path

```
Phase 1 (MVP):
  Single Supabase project (Pro tier)
  Single Vercel app
  ~10 workspaces, ~1000 total clients

Phase 2 (Growth):
  Supabase Pro with read replicas
  Table partitioning for messages + audit_events
  Vercel Pro with higher concurrency
  ~100 workspaces, ~50,000 total clients

Phase 3 (Scale):
  Supabase Team/Enterprise tier
  Dedicated compute for Edge Functions
  Separate Supabase projects per region (data residency)
  External queue (SQS or similar) if pgmq throughput is insufficient
  ~1000+ workspaces
```

---

## 9. Deployment architecture

### 9.1 Environment topology

```
┌──────────────────────────────────────────────────────────────┐
│                      DEVELOPMENT                             │
│                                                              │
│  Local:                                                      │
│    supabase start (local Docker)                             │
│    next dev (local Next.js)                                  │
│    WhatsApp: webhook.site or ngrok for testing               │
│                                                              │
│  Supabase CLI for:                                           │
│    - Running migrations locally                              │
│    - Testing Edge Functions locally                          │
│    - Seeding test data                                       │
└──────────────────────────────────────────────────────────────┘
                              │
                              │ git push
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                       STAGING                                │
│                                                              │
│  Supabase:                                                   │
│    - Linked staging project                                  │
│    - Migrations run via supabase db push                     │
│    - Edge Functions deployed via supabase functions deploy    │
│    - WhatsApp sandbox phone number                           │
│                                                              │
│  Vercel:                                                     │
│    - Preview deployment per PR                               │
│    - Staging environment variables                           │
│    - Connected to staging Supabase project                   │
└──────────────────────────────────────────────────────────────┘
                              │
                              │ merge to main
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                      PRODUCTION                              │
│                                                              │
│  Supabase:                                                   │
│    - Production project                                      │
│    - Migrations via CI/CD (supabase db push --linked)        │
│    - Edge Functions deployed via CI/CD                       │
│    - WhatsApp production phone number                        │
│    - Daily automated backups                                 │
│    - Point-in-time recovery enabled                          │
│                                                              │
│  Vercel:                                                     │
│    - Production deployment on main branch                    │
│    - Production environment variables                        │
│    - Custom domain                                           │
│    - Edge caching for static assets                          │
└──────────────────────────────────────────────────────────────┘
```

### 9.2 Repository structure

```
crm-template/
  ├── apps/
  │   └── web/                          # Next.js App Router (deployed to Vercel)
  │       ├── app/
  │       │   ├── (auth)/
  │       │   │   └── login/
  │       │   ├── (dashboard)/
  │       │   │   ├── inbox/
  │       │   │   │   └── [conversationId]/
  │       │   │   ├── today/
  │       │   │   ├── clients/
  │       │   │   │   └── [clientId]/
  │       │   │   └── settings/
  │       │   └── api/
  │       │       ├── messages/
  │       │       │   └── send/
  │       │       ├── actions/
  │       │       │   ├── approve/
  │       │       │   └── reject/
  │       │       ├── drafts/
  │       │       │   └── reprompt/
  │       │       ├── notes/
  │       │       │   └── create/
  │       │       └── stripe/
  │       │           ├── checkout/
  │       │           └── portal/
  │       ├── components/
  │       │   ├── inbox/
  │       │   ├── conversation/
  │       │   ├── client/
  │       │   ├── draft/
  │       │   ├── booking/
  │       │   └── settings/
  │       ├── lib/
  │       │   ├── supabase/
  │       │   │   ├── client.ts          # Browser Supabase client
  │       │   │   ├── server.ts          # Server Component Supabase client
  │       │   │   └── middleware.ts       # Auth middleware
  │       │   ├── stripe/
  │       │   │   └── client.ts
  │       │   └── utils/
  │       └── middleware.ts              # Auth redirect middleware
  │
  ├── supabase/
  │   ├── functions/                    # Edge Functions (deployed to Supabase)
  │   │   ├── webhook-whatsapp/
  │   │   │   └── index.ts
  │   │   ├── webhook-stripe/
  │   │   │   └── index.ts
  │   │   ├── agent-worker/
  │   │   │   └── index.ts
  │   │   ├── compaction-worker/
  │   │   │   └── index.ts
  │   │   ├── cos-worker/
  │   │   │   └── index.ts
  │   │   ├── learning-worker/
  │   │   │   └── index.ts
  │   │   ├── media-processor/
  │   │   │   └── index.ts
  │   │   ├── knowledge-indexer/
  │   │   │   └── index.ts
  │   │   └── onboarding-worker/
  │   │       └── index.ts
  │   ├── migrations/                   # SQL migrations (ordered)
  │   │   ├── 00001_create_workspace.sql
  │   │   ├── 00002_create_staff.sql
  │   │   ├── 00003_create_client.sql
  │   │   ├── 00004_create_conversation.sql
  │   │   ├── 00005_create_message.sql
  │   │   ├── 00006_create_draft.sql
  │   │   ├── 00007_create_booking.sql
  │   │   ├── 00008_create_note.sql
  │   │   ├── 00009_create_followup.sql
  │   │   ├── 00010_create_memory.sql
  │   │   ├── 00011_create_knowledge_chunk.sql
  │   │   ├── 00012_create_proposed_action.sql
  │   │   ├── 00013_create_audit_event.sql
  │   │   ├── 00014_create_learning_signal.sql
  │   │   ├── 00015_create_communication_rule.sql
  │   │   ├── 00016_create_message_inbox.sql
  │   │   ├── 00017_create_message_template.sql
  │   │   ├── 00018_enable_rls_all_tables.sql
  │   │   ├── 00019_create_rls_policies.sql
  │   │   ├── 00020_create_pgmq_queues.sql
  │   │   ├── 00021_create_pg_cron_jobs.sql
  │   │   ├── 00022_create_pgvector_functions.sql
  │   │   └── 00023_seed_data.sql
  │   ├── seed.sql
  │   └── config.toml
  │
  ├── packages/
  │   └── shared/                       # Shared TypeScript types + utilities
  │       ├── types/
  │       │   ├── database.ts            # Generated from Supabase schema
  │       │   ├── context.ts             # ClientSessionContext, COSContext
  │       │   ├── tools.ts               # Tool definitions + schemas
  │       │   ├── actions.ts             # ProposedAction, ApprovalTier
  │       │   └── events.ts              # Conversation events, state machine
  │       ├── validation/
  │       │   └── schemas.ts             # Zod schemas shared between app + functions
  │       └── utils/
  │           ├── phone.ts               # E.164 normalization
  │           └── token-budget.ts        # Context token estimation
  │
  ├── turbo.json                        # Turborepo config
  ├── package.json
  └── tsconfig.json
```

### 9.3 CI/CD pipeline

```
GitHub Actions workflow:

on push to main:
  ├─ Lint + type check (turbo run lint typecheck)
  ├─ Run tests (turbo run test)
  ├─ Deploy Supabase migrations
  │     supabase db push --linked
  ├─ Deploy Edge Functions
  │     supabase functions deploy --all
  └─ Deploy Next.js to Vercel (automatic via Vercel GitHub integration)

on pull request:
  ├─ Lint + type check
  ├─ Run tests
  ├─ Vercel preview deployment (automatic)
  └─ Supabase staging migration check (dry run)
```

### 9.4 Environment variables

**Vercel (Next.js)**

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key (public, RLS-protected) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-side only, for API routes) |
| `STRIPE_SECRET_KEY` | Stripe API key (server-side only) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Stripe price ID for subscription plan |

**Supabase Edge Functions (secrets)**

| Variable | Purpose |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification token |
| `WHATSAPP_APP_SECRET` | HMAC signing secret for webhook verification |
| `WHATSAPP_ACCESS_TOKEN` | System user access token (or per-workspace from DB) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `OPENAI_API_KEY` | Whisper API key (transcription) |
| `SUPABASE_URL` | Available by default in Edge Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Available by default in Edge Functions |
| `ENCRYPTION_KEY` | For encrypting/decrypting OAuth tokens in DB |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |

---

## 10. Stripe integration

### 10.1 Subscription model

| Plan | Price | Features |
|---|---|---|
| Free trial | 14 days | Full features, 100 messages/day, 1 workspace |
| Pro | $49/month | Unlimited messages, 1 workspace, all features |
| Business | $99/month | Unlimited messages, priority support, extended history |

### 10.2 Stripe objects

```
Stripe Customer    ←→  workspace.stripe_customer_id
Stripe Subscription ←→  workspace.stripe_subscription_id
Stripe Price       ←→  Per plan (configured in Stripe Dashboard)
```

### 10.3 Subscription lifecycle

```
Onboarding:
  1. Workspace created (trial starts)
  2. workspace.subscription_status = 'trialing'
  3. workspace.trial_ends_at = now() + 14 days

Conversion:
  1. Staff clicks "Upgrade" in settings
  2. Next.js API route creates Stripe Checkout Session
  3. Redirect to Stripe Checkout
  4. On success: Stripe webhook (checkout.session.completed)
  5. Edge Fn: webhook-stripe updates workspace
     - stripe_customer_id
     - stripe_subscription_id
     - subscription_status = 'active'
     - subscription_plan = 'pro'

Billing management:
  1. Staff clicks "Manage billing" in settings
  2. Next.js API route creates Stripe Customer Portal session
  3. Redirect to Stripe Customer Portal
  4. All changes (cancel, update card, etc.) handled by Stripe
  5. Stripe webhooks update workspace status

Webhook events handled:
  - checkout.session.completed → activate subscription
  - customer.subscription.updated → sync plan/status
  - customer.subscription.deleted → set status = 'cancelled'
  - invoice.payment_failed → set status = 'past_due'
  - invoice.paid → set status = 'active' (recovery)
```

### 10.4 Feature gating

```typescript
// Middleware check on every API route and Edge Function
export function checkSubscription(workspace: Workspace): void {
  const { subscription_status, trial_ends_at } = workspace;

  if (subscription_status === 'trialing') {
    if (trial_ends_at && new Date(trial_ends_at) < new Date()) {
      throw new SubscriptionError('Trial expired. Please upgrade.');
    }
    return; // Trial active
  }

  if (subscription_status === 'active') return; // Paid active

  if (subscription_status === 'past_due') {
    // Allow 7-day grace period for payment recovery
    return;
  }

  throw new SubscriptionError('Subscription inactive. Please upgrade.');
}
```

---

## 11. Conversation state machine

### 11.1 States and transitions

```
                  ┌──────────────────┐
        ┌────────►│      idle        │◄──────── conversation resolved
        │         └────────┬─────────┘
        │                  │ inbound message received
        │                  ▼
        │         ┌──────────────────────┐
        │    ┌───►│ awaiting_staff_review│◄──── draft ready
        │    │    └────────┬─────────────┘
        │    │             │
        │    │         ┌───┴──────┐
        │    │         │          │
        │    │   staff sends   staff discards
        │    │         │          │
        │    │         ▼          └──────────────────┐
        │    │  ┌─────────────────────┐              │
        │    │  │awaiting_client_reply│              │
        │    │  └───┬───────────┬────┘              │
        │    │      │           │                    │
        │    │  client      24h timeout              │
        │    │  replies         │                    │
        │    │      │           ▼                    │
        │    │      │   ┌────────────────┐           │
        │    │      │   │follow_up_pending│           │
        │    │      │   └───┬────────────┘           │
        │    │      │       │                        │
        │    │      │   followup draft               │
        │    │      │   queued by COS                │
        │    │      │       │                        │
        │    │      └───┬───┘                        │
        │    │          │                            │
        │    └──────────┘                            │
        │                                            │
        │    booking intent detected                 │
        │         │                                  │
        │         ▼                                  │
        │  ┌───────────────────┐                     │
        │  │booking_in_progress│                     │
        │  └──┬──────────┬────┘                     │
        │     │          │                           │
        │  booking    24h timeout                    │
        │  confirmed     │                           │
        │     │          └──► follow_up_pending       │
        └─────┘                                      │
                                                     │
        ◄────────────────────────────────────────────┘
```

### 11.2 Transition table

```typescript
const TRANSITION_TABLE: Record<ConversationState, Record<ConversationEvent, ConversationState>> = {
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
    inbound_message: 'awaiting_staff_review',
  },
  booking_in_progress: {
    inbound_message: 'awaiting_staff_review',
    booking_confirmed: 'idle',
    timeout_24h: 'follow_up_pending',
  },
  payment_pending: {
    payment_received: 'idle',
    staff_resolves: 'idle',
    inbound_message: 'awaiting_staff_review',
  },
};
```

---

## 12. Observability and monitoring

### 12.1 Metrics to track

| Category | Metric | Alert threshold |
|---|---|---|
| Pipeline health | Messages in pgmq (queue depth) | > 50 messages for > 5 minutes |
| Pipeline health | Messages in DLQ | Any message in DLQ |
| Pipeline health | Webhook-to-draft latency (P95) | > 30 seconds |
| LLM | Claude API error rate | > 5% in 5 minutes |
| LLM | Token usage per workspace per day | > 500K tokens |
| LLM | Agent invocation latency (P95) | > 20 seconds |
| Database | Active connections (PgBouncer) | > 80% of pool |
| Database | Query latency (P95) for context assembly | > 500ms |
| Database | Table size for messages, audit_events | Approaching partition threshold |
| Stripe | Failed webhook delivery | Any failure |
| WhatsApp | Failed message sends | > 3 consecutive failures |
| App | Staff app error rate (Vercel) | > 1% of requests |

### 12.2 Logging strategy

| Component | Log destination | Retention |
|---|---|---|
| Edge Functions | Supabase Logs (built-in) | 7 days (Pro tier) |
| Next.js | Vercel Logs | 1 day (Pro: 3 days) |
| LLM traces | Langfuse (self-hosted or cloud) | 30 days |
| Audit events | audit_event table (Postgres) | 1 year |
| Queue metrics | pgmq internal tables | 30 days |

### 12.3 LLM observability (Langfuse)

Every LLM invocation is traced with:

```typescript
const trace = langfuse.trace({
  name: 'client-worker',
  metadata: {
    workspaceId,
    clientId,
    sessionKey,
    intentClassified: null, // filled after LLM response
  }
});

const generation = trace.generation({
  name: 'draft-generation',
  model: 'claude-sonnet-4-20250514',
  input: assembledContext,
  modelParameters: { max_tokens: 1024, temperature: 0.3 },
});

// After LLM response
generation.end({
  output: llmResponse,
  usage: {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }
});
```

This provides:
- Cost tracking per workspace, per client, per message
- Latency breakdown (context assembly vs LLM call vs tool execution)
- Draft quality correlation (link to learning_signal records)
- Tool call frequency and patterns

---

## 13. Error handling and resilience

### 13.1 Failure modes and recovery

| Failure | Detection | Recovery | User impact |
|---|---|---|---|
| Webhook handler down | Meta retries for 24h with backoff | pgmq messages accumulate. Agent-worker processes backlog on recovery. | Messages delayed but not lost. |
| Agent-worker crash mid-processing | pgmq visibility timeout expires, message becomes visible | Another worker instance picks up the message. Idempotent processing prevents duplicates. | Draft delayed by visibility timeout (60s). |
| LLM API unavailable | Circuit breaker (cockatiel) opens after 3 failures | Staff notified. Conversation flagged as "draft_delayed". Manual response available. | No AI draft. Staff handles manually. |
| LLM returns malformed output | Zod validation of tool calls. Try-catch on output parsing. | Log error, retry once with same context. If retry fails, flag for manual handling. | Draft delayed or manual handling. |
| Google Calendar API down | Circuit breaker on calendar gateway | Booking features paused. Messaging continues. Staff notified via banner. | Cannot check availability or create bookings. |
| Supabase database issue | Health check endpoint. Supabase status page monitoring. | Supabase handles failover. PITR for data recovery. | Full system degraded until recovery. |
| Stripe webhook failure | Stripe retry for 72h. Webhook delivery dashboard. | Idempotent webhook handler. Reconcile with Stripe API if needed. | Subscription status may lag briefly. |
| Edge Function timeout | Function logs show timeout error | Increase timeout or split work into smaller chunks | Specific operation fails, queued for retry |

### 13.2 Circuit breaker configuration

```typescript
import { CircuitBreakerPolicy, handleAll, retry, circuitBreaker } from 'cockatiel';

// LLM API circuit breaker
const llmPolicy = retry(handleAll, { maxAttempts: 2, delay: 1000 })
  .wrap(circuitBreaker(handleAll, {
    halfOpenAfter: 30_000,    // Try again after 30s
    breaker: {
      threshold: 0.5,         // Open after 50% failure rate
      duration: 60_000,        // Over 60s window
      minimumRps: 1,          // Minimum 1 request/second to evaluate
    }
  }));

// Google Calendar circuit breaker
const calendarPolicy = retry(handleAll, { maxAttempts: 3, delay: 2000 })
  .wrap(circuitBreaker(handleAll, {
    halfOpenAfter: 60_000,
    breaker: { threshold: 0.5, duration: 120_000, minimumRps: 0.1 }
  }));
```

### 13.3 Dead letter queue handling

Messages that fail processing 3 times are moved to the DLQ:

```typescript
async function processMessage(msg: PgmqMessage): Promise<void> {
  if (msg.read_ct > 3) {
    // Move to DLQ after 3 failed attempts
    await supabase.rpc('pgmq_send', {
      queue_name: 'inbound_dlq',
      msg: { ...msg.message, original_msg_id: msg.msg_id, failure_count: msg.read_ct }
    });
    await supabase.rpc('pgmq_archive', {
      queue_name: 'inbound_messages',
      msg_id: msg.msg_id
    });

    // Alert: message in DLQ
    await logAuditEvent(supabase, {
      workspaceId: msg.message.workspace_id,
      actorType: 'system',
      actionType: 'message_dlq',
      targetEntity: 'message',
      targetId: msg.message.wamid,
      metadata: { reason: 'max_retries_exceeded', read_count: msg.read_ct }
    });
    return;
  }

  // Normal processing...
}
```

---

## 14. Verification questions and answers

### Q1: Can pgmq handle the throughput required, and does it provide the per-client serialization that BullMQ queue groups offer?

**Answer:** pgmq handles thousands of messages per second for SMB scale (50-200 messages/day per workspace). The per-client serialization gap is real -- pgmq lacks native queue groups. The advisory lock pattern (`pg_try_advisory_lock(hashtext(session_key))`) provides equivalent behavior: if two messages from the same client arrive simultaneously, the second worker backs off and re-queues. For MVP volumes this is sufficient. If it becomes a bottleneck at scale, we migrate to BullMQ on a dedicated Redis instance while keeping the same worker logic.

### Q2: How does the agent-worker get triggered when a new message is enqueued in pgmq? Supabase Edge Functions cannot listen to pg_notify directly.

**Answer:** This is a gap in the initial design. Supabase Edge Functions are invoked via HTTP, not via database notifications. The correct trigger mechanism is `pg_net`: a database trigger on the pgmq internal table calls `net.http_post()` to invoke the agent-worker Edge Function. Alternatively, for MVP simplicity, the webhook-whatsapp Edge Function can directly invoke the agent-worker Edge Function via HTTP after enqueuing. The trade-off: direct invocation couples the webhook handler to the worker, but eliminates the pg_notify gap. For MVP, use direct HTTP invocation from webhook to agent-worker. The pgmq queue still provides durability and retry semantics.

**Revision applied:** Section 3.1 Stage 2 trigger mechanism updated to document both options.

### Q3: How do Supabase Edge Functions access the database with service_role privileges while maintaining the Deno runtime constraints?

**Answer:** Supabase Edge Functions have access to `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as built-in environment variables. The Edge Function creates a Supabase client with the service role key, which bypasses RLS. This is the documented and supported pattern. All queries in Edge Functions must manually include `workspace_id` filters since RLS is bypassed.

### Q4: With Supabase Realtime listening to Postgres changes, what happens when the agent-worker writes a draft? Does the staff app receive it in real-time?

**Answer:** Yes. When the agent-worker INSERTs a row into the `draft` table, Supabase Realtime captures the change from the Postgres replication stream and pushes it to all subscribed clients filtered by `workspace_id`. The staff app's Realtime subscription (Section 7.4) receives the new draft event and updates the UI. RLS policies ensure only staff in the same workspace receive the event. The latency is typically under 500ms from database write to client notification.

### Q5: How does the architecture handle the case where a workspace has not yet connected Google Calendar? The booking flow depends on calendar availability.

**Answer:** The PRD (Section 15.3, Progressive Enhancement) explicitly addresses this. Calendar is optional. When `workspace.calendar_config` is null, the `calendar_query` and `calendar_book` tools return a "not_configured" result. The Client Worker's system prompt includes a conditional instruction: "Calendar is not connected. For booking requests, suggest the client contact the business directly for scheduling." Booking features activate only when calendar is connected during onboarding. The rest of the system (messaging, drafting, notes, follow-ups) works fully without calendar.

---

## 15. Revisions from verification

The following changes were made after the verification process:

### Revision 1: Agent-worker trigger mechanism (from Q2)

**Problem:** The original design assumed pg_notify could trigger Edge Functions, which is not supported by Supabase.

**Fix:** For MVP, the webhook-whatsapp Edge Function directly invokes the agent-worker Edge Function via HTTP after enqueuing the message to pgmq. The pgmq queue provides durability (if the agent-worker call fails, the message is still in the queue for retry). A scheduled "queue poller" cron job runs every 30 seconds to pick up any messages that were enqueued but not processed (e.g., if the direct invocation failed).

```sql
-- Safety net: poll pgmq every 30 seconds for unprocessed messages
SELECT cron.schedule(
  'pgmq-poller',
  '*/30 * * * * *',  -- Note: pg_cron minimum is 1 minute, not seconds
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/agent-worker',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'x-trigger', 'poller'
    ),
    body := '{}'::jsonb
  )$$
);
```

**Note:** pg_cron supports minimum 1-minute intervals. For the MVP, a 1-minute poller is acceptable. The direct HTTP invocation from webhook-whatsapp handles the latency-sensitive path; the poller is only a safety net.

### Revision 2: Advisory lock hash collision risk (from Q1)

**Problem:** `hashtext()` returns a 32-bit integer. With many concurrent clients, hash collisions could cause unnecessary serialization.

**Fix:** Use `hashtext(session_key)::bigint` for advisory locks (64-bit), reducing collision probability. Additionally, document that this serialization is a correctness optimization, not a hard requirement -- if two messages from the same client are processed concurrently, the optimistic locking on `conversation.version` will catch the conflict and the second worker will retry.

### Revision 3: Webhook-to-worker coupling clarity

**Problem:** The direct invocation pattern from webhook to agent-worker creates a coupling that the original architecture (with BullMQ) avoided.

**Fix:** The coupling is acceptable for MVP because:
1. pgmq is still the source of truth for message durability
2. If the agent-worker invocation fails, the message remains in pgmq for the poller to pick up
3. The webhook handler returns 200 to Meta after enqueue, not after worker completion
4. The architecture can evolve to fully decoupled (pg_net trigger on pgmq insert) without changing the worker logic

The webhook handler flow is:

```typescript
// webhook-whatsapp Edge Function
export async function handler(req: Request): Promise<Response> {
  // 1. Verify signature
  // 2. Parse payload
  // 3. Deduplicate by wamid
  // 4. Enqueue to pgmq (durable)
  await supabase.rpc('pgmq_send', { queue_name: 'inbound_messages', msg: payload });

  // 5. Return 200 to Meta immediately (non-blocking)
  // 6. Fire-and-forget: invoke agent-worker
  //    Use waitUntil if available in Deno Deploy, otherwise EdgeRuntime.waitUntil
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/agent-worker`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ source: 'webhook', queue: 'inbound_messages' })
    });
  } catch {
    // Agent-worker invocation failed. Message is safe in pgmq.
    // Poller will pick it up within 1 minute.
    console.error('Agent-worker invocation failed, relying on poller');
  }

  return new Response('OK', { status: 200 });
}
```

### Revision 4: WhatsApp access token per-workspace vs per-deployment

**Problem:** The architecture shows `WHATSAPP_ACCESS_TOKEN` as an Edge Function secret (per-deployment), but multi-tenant mode requires per-workspace tokens since each workspace has its own WhatsApp Business Account.

**Fix:** For multi-tenant mode, the WhatsApp access token is stored in `workspace.whatsapp_config` (encrypted). The Edge Function decrypts it at runtime using the `ENCRYPTION_KEY` secret. For single-tenant mode, a deployment-level secret can be used as an alternative. The webhook-whatsapp function resolves the workspace from the incoming `phone_number_id` in the webhook payload, then loads the workspace's config including the decrypted access token.

### Revision 5: pg_cron minimum interval

**Problem:** Section 15 Revision 1 proposed a 30-second cron interval, but pg_cron supports minimum 1-minute intervals.

**Fix:** Use 1-minute interval for the poller. For the MVP, a worst-case 1-minute delay on the safety-net path is acceptable. The primary path (direct HTTP invocation from webhook) handles messages with sub-second delay.

---

## 16. Architecture principles (unchanged from ADR v1.0)

These principles from the existing architecture document remain the load-bearing constraints of the system. They are repeated here for completeness, not modified.

### 16.1 Core rule

**The agent may think, retrieve, draft, and propose. Only deterministic application services may commit writes.**

### 16.2 Guiding decisions

| Principle | Implementation |
|---|---|
| Single agent with tools, not multi-agent | One LLM invocation per client message. Knowledge search and scheduling are tools, not workers. |
| Context assembly is deterministic code | A pure function `(workspaceId, clientId) -> ReadOnlyContext` runs before the LLM. The model never chooses what data to load. |
| Session isolation by construction | The Client Worker receives only one client's data. Cross-client data never enters the context window. |
| Structured records over conversational memory | Important facts live in typed database fields. Summaries and chat history are supplementary. |
| Approval boundary before all mutations | Every write passes through policy evaluation. Staff confirms anything beyond auto-allowed actions. |
| Daily compaction on schedule | Not triggered by context window pressure. Simpler, more predictable, and cheaper. |

---

## 17. What this architecture document does NOT cover

These topics are documented in the ADR v1.0 (existing architecture document) and remain unchanged:

- **Learning loop specification** (Section 8 of ADR v1.0): Full DraftEditSignal, classification, recurrence tracking, and promotion flow.
- **COS operations specification** (Section 5 of ADR v1.0): COS context assembly, trigger paths, and outputs.
- **Conversation state machine implementation** (Section 10 of ADR v1.0): Transition table, domain entity, and validation rules.
- **Client Worker tool inventory details** (Section 4 of ADR v1.0): Authority levels, input/output schemas, tool parameter injection.
- **Vertical configuration layer** (Section 12 of ADR v1.0): Custom fields, appointment types, SOP rules.
- **Memory and compaction** (Section 6 of ADR v1.0): Compact summary generation, flush-before-compact invariant.

This document focuses on the deployment-specific architecture: how the domain design maps to Supabase + Vercel + Edge Functions, the message pipeline without BullMQ/Redis, security via RLS, Stripe integration, and operational concerns.

---

## Appendix A: Key differences from ADR v1.0

| Topic | ADR v1.0 | This document |
|---|---|---|
| Message queue | BullMQ + Redis | pgmq (Postgres-native, no Redis) |
| Server framework | Fastify (Node.js) | Supabase Edge Functions (Deno) + Next.js API Routes |
| Worker runtime | Node.js process with BullMQ | Supabase Edge Functions (stateless, HTTP-triggered) |
| Per-client serialization | BullMQ queue groups | Advisory locks + optimistic locking |
| Cron jobs | BullMQ scheduled jobs | pg_cron + pg_net |
| Staff app | React SPA (unspecified framework) | Next.js App Router with Server Components |
| Realtime | Not specified (implied SSE) | Supabase Realtime (Postgres changes) |
| Auth | Supabase Auth (mentioned) | Supabase Auth with RLS policies (fully specified) |
| Payments | Not addressed | Stripe Checkout + webhooks + Customer Portal |
| Deployment | Not specified | Vercel (app) + Supabase (data + functions) |
| Multi-tenant | Mentioned but not architected | RLS policies, workspace limits, channel structure |
| Webhook handling | API layer (unspecified) | Supabase Edge Function with HMAC verification |
| Observability | Langfuse (mentioned) | Langfuse + Supabase Logs + Vercel Logs + monitoring strategy |
| Error handling | Not specified | Circuit breakers, DLQ, retry policies, degradation strategy |

---

## Appendix B: Cost estimates (MVP, per workspace)

| Resource | Unit cost | Estimated monthly usage | Monthly cost |
|---|---|---|---|
| Supabase Pro | $25/month | 1 project | $25 |
| Vercel Pro | $20/month | 1 app | $20 |
| Claude Haiku (input) | $0.25/M tokens | ~3M tokens (200 msgs/day * 12K tokens) | $0.75 |
| Claude Haiku (output) | $1.25/M tokens | ~300K tokens | $0.38 |
| Claude Sonnet (compaction) | $3/M tokens | ~500K tokens/month | $1.50 |
| OpenAI Whisper | $0.006/minute | ~50 minutes/month | $0.30 |
| Embedding (text-embedding-3-small) | $0.02/M tokens | ~100K tokens/month | $0.002 |
| Stripe fees | 2.9% + $0.30 | Per subscription payment | Variable |
| **Total infrastructure** | | | **~$48/month** |

This estimate assumes Claude Haiku for real-time drafting (cost-optimized) and Claude Sonnet for daily compaction (quality-optimized). If draft quality requires Sonnet for all invocations, the LLM cost increases to approximately $12-15/month per active workspace.

---

## Appendix C: Migration path from existing architecture

If moving from the BullMQ/Redis/Fastify architecture (ADR v1.0) to this architecture:

1. **Database schema** is identical. No migration needed for tables.
2. **Domain logic** (context assembly, approval policy, state machine) is portable TypeScript. Move from `apps/api/src/modules/` to `supabase/functions/` and `packages/shared/`.
3. **BullMQ to pgmq**: Replace `BullMQMessageQueue.ts` with pgmq calls. Queue semantics are similar (enqueue, dequeue, visibility timeout, archive).
4. **Fastify routes to Next.js API routes**: Staff-facing endpoints move to `apps/web/app/api/`. Keep Zod validation schemas.
5. **Worker processes to Edge Functions**: Move `ProcessInboundMessage.ts` logic to `agent-worker/index.ts`. Replace BullMQ worker with pgmq read loop.
6. **Add RLS policies**: New addition. Existing queries already scope by workspace_id.
7. **Add Stripe**: New addition. Workspace table gains subscription columns.
