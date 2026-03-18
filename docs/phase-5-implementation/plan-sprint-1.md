# Sprint 1 Implementation Plan — Messaging Foundation

**Sprint:** 1 of 5
**Target:** 2 weeks
**Features:** F-02 (WhatsApp Message Pipeline), F-03 (Client Identity), F-04 (Notifications & Audit)
**Starting state:** Zero code — docs only
**Status:** COMPLETE — E2E verified with real WhatsApp (134 clients, 51 conversations, 207 messages synced)
**Exit criteria:** Messages flow end-to-end from WhatsApp → pgmq → staff app. Baileys survives restart. Audit trail logs all mutations.

---

## Architecture Reference

```
system_topology_corrected.svg — Full system flow:
  COS → Per-client Workers → Draft+Actions → Approval Boundary → Staff → Audit → Learning Loop
                                                                          ↑
                                                                    Sprint 1 builds this

learning_loop_detailed.svg — Signal capture → Classify → Track → Promote (Sprint 2+)
```

```
Sprint 1 builds:
┌─────────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
│  Baileys Server      │────▶│  Supabase            │────▶│  Next.js Staff App   │
│  (Railway)           │     │  (DB + Edge Funcs)   │     │  (Vercel)            │
│                      │     │                      │     │                      │
│  - QR pairing        │     │  - pgmq queue        │     │  - Inbox view        │
│  - Inbound handler   │     │  - process-message   │     │  - Realtime notifs   │
│  - Send handler      │     │  - Client upsert     │     │  - Unread badges     │
│  - Auth persistence  │     │  - Audit events      │     │  - Toast alerts      │
│  - History sync      │     │  - get_unread_counts  │     │                      │
└─────────────────────┘     └─────────────────────┘     └──────────────────────┘
```

---

## Key Design Decisions (from E2E testing)

### D-01: Message source determines behavior, not timestamp
The `handleInboundMessage` function accepts `{ source: 'live' | 'history' }`:
- `messages.upsert` → `source: 'live'` (real-time delivery)
- `messaging-history.set` → `source: 'history'` (initial sync)

Business rules by source:
| Source | Direction | is_read | pgmq enqueue | Reactivate client |
|--------|-----------|---------|-------------|-------------------|
| live | inbound | false | YES | YES |
| live | outbound | true | NO | YES |
| history | inbound | true | NO | NO |
| history | outbound | true | NO | NO |

This avoids the timestamp heuristic problem: a delayed live message (e.g., after 8h outage) arriving via `messages.upsert` is correctly treated as unread.

### D-02: Lazy draft generation (Sprint 2)
Drafts are NOT generated eagerly. The strategy:
1. Inbound message → save to DB → Realtime notification → pgmq enqueue with **5-minute visibility timeout**
2. Staff opens conversation within 5 min → frontend calls `POST /api/conversations/:id/draft` → LLM fires NOW
3. Staff doesn't open within 5 min → pgmq VT expires → LLM fires automatically as fallback

Benefits: No wasted LLM calls. Multiple rapid messages batch into one turn naturally (by the time staff opens, all messages are available for context assembly).

### D-03: Conversation lifecycle
```
idle ──(inbound msg)──→ active ──(resolved by LLM)──→ resolved ──(30 days)──→ archived
  ↑                        ↑                              │
  │                        │                              │
  └──(new msg from client)─┴──────────────────────────────┘
```
- LLM classifies intent (Sprint 2). When booking confirmed / question answered → `resolved`, no draft generated.
- COS daily cron (Sprint 4) handles archival after inactivity.
- New message from client ALWAYS reopens, even if resolved/archived.

### D-04: Client naming format
`Name-+phone` when WhatsApp contact name is known (e.g., `Alex Chen-+85298805858`).
`NULL` when name is unknown (phone is always in the `phone` column).

### D-05: History sync configuration
- `Browsers.macOS('Desktop')` + `syncFullHistory: true` — desktop browser config gets full history on first QR pairing
- `HISTORY_SYNC_CUTOFF_DAYS=45` — messages older than 45 days are skipped during import (contacts always sync fully)
- History only fires on first pairing. Reconnects do not re-sync.

### D-06: Soft-deleted client reopening
When a soft-deleted client (`deleted_at IS NOT NULL`) messages again:
1. Fetch without `deleted_at` filter (finds the archived row)
2. Clear `deleted_at`, set `lifecycle_status = 'open'`
3. Message saves normally against the reopened client

---

## Execution Phases

### Phase 0: Foundation (sequential, ~1 day) ✅ COMPLETE

All features depend on this. Must complete before any feature work begins.

| Task | Description | Size | Status |
|------|-------------|------|--------|
| **T-00-01** | Scaffold Next.js 15 project (App Router, TypeScript strict, Tailwind, shadcn/ui) | S | ✅ |
| **T-00-02** | Configure tooling: ESLint, Prettier, Vitest, Playwright, tsconfig strict | S | ✅ |
| **T-00-03** | Scaffold Baileys server project (`baileys-server/` — separate Node.js + Express + TypeScript) | S | ✅ |
| **T-00-04** | Initialize Supabase project (`supabase init`, config.toml) | S | ✅ |
| **T-00-05** | Create migration `001_initial_schema.sql` — 18 tables + indexes + extensions (pgmq, vector) | M | ✅ |
| **T-00-06** | Create migration `002_rls_policies.sql` — `auth.workspace_id()` + RLS on all tables including message_inbox | M | ✅ |
| **T-00-07** | Create migration `003_functions_and_queues.sql` — pgmq queues + `get_unread_counts` RPC + `update_updated_at` trigger | S | ✅ |
| **T-00-08** | Generate TypeScript types from Supabase schema | S | ✅ |
| **T-00-09** | Set up Supabase client utilities (browser, server, middleware) | S | ✅ |
| **T-00-10** | Create `seed.sql` with test workspace and sample data | S | ✅ |
| **T-00-11** | Set up Next.js auth middleware | S | ✅ |

**PR:** [#1](https://github.com/stericishere/CRM-template/pull/1)

---

### Phase 1: F-02 — WhatsApp Message Pipeline (~3-4 days) ✅ COMPLETE

#### 1A: Baileys Server Core

| Task | Description | Size | Status |
|------|-------------|------|--------|
| **T-02-01** | `auth-store.ts` — Supabase-backed Baileys auth persistence. Batched key lookups (not N+1). | M | ✅ |
| **T-02-02** | `socket-manager.ts` — Per-workspace socket lifecycle. Two-phase reconnect (fast exponential → slow 5min polling). `Browsers.macOS('Desktop')` + `syncFullHistory: true`. `MessageSource` context passed to handler. | L | ✅ |
| **T-02-03** | `qr-handler.ts` — QR code SSE endpoint with server-side PNG rendering via `qrcode` package. `clearQrCallback` on disconnect. | M | ✅ |
| **T-02-04** | `message-handler.ts` — Bidirectional message processing (inbound + outbound). `MessageSource` context (`live` / `history`). Soft-deleted client reopening. WhatsApp timestamp preservation. | L | ✅ |
| **T-02-05** | `send-handler.ts` — `POST /send` with shared `phone-utils.ts` (not inline JID conversion) | M | ✅ |
| **T-02-06** | `health.ts` — `GET /health` + `GET /status/:workspaceId` | S | ✅ |
| **T-02-07** | `index.ts` — Express wiring with API secret middleware, graceful shutdown (closes all sockets), history router | M | ✅ |
| **T-02-08** | `Dockerfile` + Railway config | S | ✅ |

#### 1B: Supabase Edge Functions

| Task | Description | Size | Status |
|------|-------------|------|--------|
| **T-02-09** | `_shared/phone-utils.ts` — E.164 normalization + validation + JID conversion | S | ✅ |
| **T-02-10** | `_shared/db.ts` — Supabase client factory for Edge Functions (Deno) | S | ✅ |
| **T-02-11** | `_shared/types.ts` — Shared types (InboundMessagePayload, Client, AuditEvent) | S | ✅ |
| **T-02-12** | `process-message/index.ts` — Dequeue from pgmq → advisory lock → audit event (Sprint 2: + LLM) | L | ✅ |

#### 1C: History Sync & Debug Endpoints

| Task | Description | Size | Status |
|------|-------------|------|--------|
| **T-02-13** | History sync: `contacts.upsert` → client records with `Name-+phone` format. `messaging-history.set` → all 1:1 messages (both directions). `HISTORY_SYNC_CUTOFF_DAYS=45` | M | ✅ |
| **T-02-14** | `history-handler.ts` — `POST /history/:workspaceId`, `GET /chats/:workspaceId`, `GET /messages/:workspaceId/:conversationId`, `GET /db-stats/:workspaceId` | M | ✅ |
| **T-02-15** | `phone-utils.ts` (baileys-server) — Shared `jidToE164` / `e164ToJid` with validation (mirrors Edge Function version) | S | ✅ |

**PRs:** [#2](https://github.com/stericishere/CRM-template/pull/2), [#5](https://github.com/stericishere/CRM-template/pull/5), [#6](https://github.com/stericishere/CRM-template/pull/6)

---

### Phase 2: F-03 — Client Identity & Profile (~2-3 days) ✅ COMPLETE

| Task | Description | Size | Status |
|------|-------------|------|--------|
| **T-03-01** | Domain types: Zod schemas (e164, lifecycle, clientPatch, createClient), TypeScript interfaces | S | ✅ |
| **T-03-02** | Repository: 7 methods (findOrCreate, getById, getProfile, list, patch, updateLifecycleStatus, mergePreferences, softDelete) | L | ✅ |
| **T-03-03** | Client CRUD API routes (6 endpoints across 3 route files) | M | ✅ |
| **T-03-04** | Unit tests: 37 tests for Zod schema validation | M | ✅ |
| **T-03-05** | `isValidE164()` exported from types for use in integration tests | S | ✅ |

**PR:** [#3](https://github.com/stericishere/CRM-template/pull/3)

---

### Phase 3: F-04 — Staff Notifications & Audit (~2-3 days) ✅ COMPLETE

| Task | Description | Size | Status |
|------|-------------|------|--------|
| **T-04-01** | `audit/types.ts` — 14 audit action types, AuditEvent/AuditEventRow interfaces | S | ✅ |
| **T-04-02** | `audit/service.ts` — `logAuditEvent()` fire-and-log pattern with pgmq retry | M | ✅ |
| **T-04-03** | `useInboxRealtime.ts` — Supabase Realtime subscription + disconnect/polling fallback | M | ✅ |
| **T-04-04** | `useUnreadCount.ts` — Server-authoritative count, Realtime updates, tab title badge | M | ✅ |
| **T-04-05** | `GET /api/notifications/unread-count` — uses `get_unread_counts` RPC with fallback | S | ✅ |
| **T-04-06** | `PATCH /api/conversations/:id/read` — mark all inbound messages as read | S | ✅ |
| **T-04-07** | `NotificationToast.tsx` — 5s auto-dismiss, 10s dedup, click-to-navigate | M | ✅ |
| **T-04-08** | Unit tests: 23 tests for audit types | S | ✅ |

**PR:** [#4](https://github.com/stericishere/CRM-template/pull/4)

---

### Phase 4: UI Shell (pending) — Login, inbox, conversation thread, client list

| Task | Description | Size | Status |
|------|-------------|------|--------|
| **T-UI-01** | Login page — Supabase Auth email/password | S | Pending |
| **T-UI-02** | Dashboard layout — Sidebar, nav, auth guard | M | Pending |
| **T-UI-03** | Inbox page — Conversation list, unread badges, Realtime | M | Pending |
| **T-UI-04** | Conversation thread — Message bubbles, mark as read, send, draft trigger (`POST /api/conversations/:id/draft`) | L | Pending |
| **T-UI-05** | Client list — Table with search, lifecycle filter | M | Pending |

---

## E2E Test Results (real WhatsApp, 2026-03-18)

| Metric | Count |
|--------|-------|
| Clients synced | 134 |
| Conversations | 51 |
| Messages (inbound) | 96 |
| Messages (outbound) | 111 |
| Dedup entries | 2,726 |
| Auth keys persisted | 841+ |
| Tests passing | 161/161 |

### Architecture Verification

| Test | Result |
|------|--------|
| Per-client session isolation (UNIQUE constraint) | PASS — 51 convs = 51 unique clients |
| No cross-client data (workspace_id consistency) | PASS — 0 mismatched rows |
| Message dedup (wamid uniqueness) | PASS — 207 msgs, 0 duplicates |
| Bidirectional messages (inbound + outbound) | PASS — both directions stored correctly |
| Client naming (`Name-+phone` format) | PASS — 83/134 with names, 51 NULL (no contact info) |
| Knowledge base (pgvector) | READY — table + vector(1536) column exist |
| Learning loop (signal capture tables) | READY — draft_edit_signals, drafts.staff_action |
| Approval boundary (proposed_actions) | READY — table with tier + status columns |
| Audit events (immutable, RLS read-only) | READY — table + policies |
| pgmq queues (4 queues operational) | PASS — inbound_messages, inbound_dlq, audit_retry, audit_dlq |
| Session persistence (survives restart) | PASS — reconnects from stored credentials |
| Outbound send (/send endpoint) | PASS — message delivered to WhatsApp |
| QR code pairing | PASS — server-side PNG rendering via SSE |

---

## Open Questions Resolved

1. **OQ-1:** Add `message_received` to audit action types? → **YES**
2. **OQ-2:** `is_read` on messages table? → **Included in 001_initial_schema.sql**
3. **OQ-3:** Wire drafts Realtime channel in F-04? → **YES** — events fire when F-05 ships
4. **OQ-4:** `baileys_auth` FK? → **Fixed: `REFERENCES workspaces(id)`**
5. **OQ-5:** Column names? → **`phone`** (matches architecture-final.md)
6. **OQ-6:** History sync behavior? → **Event source context (`live`/`history`), not timestamp heuristic**
7. **OQ-7:** Draft generation timing? → **Lazy: 5-min VT, immediate on app open**
8. **OQ-8:** Conversation end detection? → **LLM intent classification (Sprint 2)**
9. **OQ-9:** RLS on `message_inbox`? → **YES — added with workspace_isolation policy**
10. **OQ-10:** `get_unread_counts` RPC? → **Added to migration 003**

---

## PRs

| PR | Title | Status |
|----|-------|--------|
| [#1](https://github.com/stericishere/CRM-template/pull/1) | Phase 0: Foundation | MERGED |
| [#2](https://github.com/stericishere/CRM-template/pull/2) | F-02: WhatsApp pipeline | MERGED |
| [#3](https://github.com/stericishere/CRM-template/pull/3) | F-03: Client identity | MERGED |
| [#4](https://github.com/stericishere/CRM-template/pull/4) | F-04: Notifications & audit | MERGED |
| [#5](https://github.com/stericishere/CRM-template/pull/5) | Simplify review fixes | OPEN |
| [#6](https://github.com/stericishere/CRM-template/pull/6) | History sync + bidirectional + E2E fixes | OPEN |
