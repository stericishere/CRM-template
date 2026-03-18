# Sprint 1 Implementation Plan — Messaging Foundation

**Sprint:** 1 of 5
**Target:** 2 weeks
**Features:** F-02 (WhatsApp Message Pipeline), F-03 (Client Identity), F-04 (Notifications & Audit)
**Starting state:** Zero code — docs only
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
└─────────────────────┘     └─────────────────────┘     └──────────────────────┘
```

---

## Execution Phases

### Phase 0: Foundation (sequential, ~1 day)

All features depend on this. Must complete before any feature work begins.

| Task | Description | Size | Test |
|------|-------------|------|------|
| **T-00-01** | Scaffold Next.js 15 project (App Router, TypeScript strict, Tailwind, shadcn/ui) | S | `npm run build` passes |
| **T-00-02** | Configure tooling: ESLint, Prettier, Vitest, Playwright, tsconfig strict | S | `npm run lint` passes |
| **T-00-03** | Scaffold Baileys server project (`baileys-server/` — separate Node.js + Express + TypeScript) | S | `npm run build` in baileys-server/ |
| **T-00-04** | Initialize Supabase project (`supabase init`, config.toml) | S | `supabase start` runs locally |
| **T-00-05** | Create migration `001_initial_schema.sql` — ALL Sprint 1 tables (workspaces, staff, clients, conversations, messages, drafts, audit_events, message_inbox, baileys_auth, llm_usage, pgmq queues) + indexes + extensions (pgmq, vector) | M | `supabase db reset` succeeds, all tables exist |
| **T-00-06** | Create migration `002_rls_policies.sql` — `auth.workspace_id()` function + ALL RLS policies | M | RLS test: authenticated user sees only own workspace data |
| **T-00-07** | Create migration `003_functions_and_queues.sql` — pgmq queue creation (`inbound_messages`, `inbound_dlq`, `audit_retry`, `audit_dlq`) | S | pgmq.send/read roundtrip works |
| **T-00-08** | Generate TypeScript types from Supabase schema (`supabase gen types typescript`) | S | Types import without errors |
| **T-00-09** | Set up Supabase client utilities: `src/lib/supabase/client.ts` (browser), `src/lib/supabase/server.ts` (server), `src/lib/supabase/middleware.ts` (auth) | S | Can authenticate and query |
| **T-00-10** | Create `seed.sql` with test workspace, staff user, and sample data | S | Seed runs without errors |
| **T-00-11** | Set up Next.js auth middleware (redirect unauthenticated to /login) | S | Unauthenticated request redirects |

**Dependency:** T-00-01 → T-00-02. T-00-04 → T-00-05 → T-00-06 → T-00-07 → T-00-08. T-00-01 + T-00-08 → T-00-09 → T-00-11.
**Parallel:** T-00-01..02 ∥ T-00-03 ∥ T-00-04..08

---

### Phase 1: F-02 — WhatsApp Message Pipeline (sequential within, ~3-4 days)

**Depends on:** Phase 0 complete
**Architecture ref:** `architecture-final.md §16`, feature spec `f02-whatsapp-message-pipeline.md`

#### 1A: Baileys Server Core (Railway project)

| Task | Description | Size | Test |
|------|-------------|------|------|
| **T-02-01** | `baileys-server/src/auth-store.ts` — Supabase-backed auth state persistence (read/write credentials to `baileys_auth` table) | M | Unit test: write creds, read back, verify match |
| **T-02-02** | `baileys-server/src/socket-manager.ts` — Per-workspace Baileys socket lifecycle (init, connect, disconnect, auto-reconnect with exponential backoff) | L | Integration test: socket connects, disconnects, reconnects |
| **T-02-03** | `baileys-server/src/qr-handler.ts` — QR code SSE endpoint (`GET /qr/:workspaceId`) | M | SSE stream delivers QR code data |
| **T-02-04** | `baileys-server/src/message-handler.ts` — Inbound message processing: extract fields, normalize phone (E.164), dedup via `message_inbox` INSERT ON CONFLICT, save to `messages` table, enqueue to pgmq `inbound_messages` | L | Integration: mock inbound → message in DB + pgmq |
| **T-02-05** | `baileys-server/src/send-handler.ts` — `POST /send` endpoint (workspaceId, to, content, mediaUrl?) → send via Baileys socket, return delivery status | M | Unit test: correct Baileys API called |
| **T-02-06** | `baileys-server/src/health.ts` — `GET /health` + `GET /status/:workspaceId` endpoints | S | HTTP 200 with connection status JSON |
| **T-02-07** | `baileys-server/src/index.ts` — Express server wiring, graceful shutdown, env config | M | Server starts, routes respond |
| **T-02-08** | `baileys-server/Dockerfile` + Railway config | S | Docker build succeeds |

**Dependency chain:** T-02-01 → T-02-02 → T-02-03, T-02-04, T-02-05 (parallel after socket-manager) → T-02-07 → T-02-08.

#### 1B: Supabase Edge Functions

| Task | Description | Size | Test |
|------|-------------|------|------|
| **T-02-09** | `supabase/functions/_shared/phone-utils.ts` — E.164 normalization + validation (Zod regex) | S | Unit: valid/invalid phone numbers |
| **T-02-10** | `supabase/functions/_shared/db.ts` — Supabase client factory for Edge Functions | S | Can connect and query |
| **T-02-11** | `supabase/functions/_shared/types.ts` — Shared types for Edge Functions | S | Compiles |
| **T-02-12** | `supabase/functions/process-message/index.ts` — Dequeue from pgmq → phone normalize → client find-or-create (calls F-03) → advisory lock on client_id → (stub: context assembly + LLM deferred to Sprint 2) → mark message processed | L | Integration: message in pgmq → dequeued, client created, message acknowledged |

**Dependency:** T-02-09, T-02-10, T-02-11 (parallel) → T-02-12

#### 1C: Delivery Status & History Import

| Task | Description | Size | Test |
|------|-------------|------|------|
| **T-02-13** | Delivery status tracking in Baileys server: listen for receipt events (sent/delivered/read), update `messages.delivery_status` | M | Status updates propagate to DB |
| **T-02-14** | Conversation history import: on first connection, queue existing messages from Baileys chat history to pgmq (with `is_historical = true` flag) | M | Historical messages appear in DB after connection |
| **T-02-15** | Advisory lock helper in process-message: `pg_advisory_xact_lock(hashtext(client_id))` to ensure per-client ordering | S | Concurrent messages for same client processed sequentially |

---

### Phase 2: F-03 — Client Identity & Profile (parallel with Phase 3 after Phase 1B, ~2-3 days)

**Depends on:** T-02-09 (phone-utils), T-02-10 (db), T-00-05 (schema)
**Architecture ref:** feature spec `f03-client-identity.md`

| Task | Description | Size | Test |
|------|-------------|------|------|
| **T-03-01** | Domain types: `Client` entity, `ClientProfile` value object, `LifecycleStatus` enum, `ClientRepository` interface in `src/lib/clients/types.ts` | S | TypeScript compiles |
| **T-03-02** | `src/lib/clients/repository.ts` — `SupabaseClientRepository` implementing `findByPhone`, `findOrCreate` (upsert), `list`, `update`, `softDelete`, `updateLifecycleStatus`, `mergePreferences` | L | Integration tests for all methods |
| **T-03-03** | `src/lib/clients/e164.ts` — E.164 validation schema (Zod, shared with Edge Functions) | S | Validates correct formats, rejects invalid |
| **T-03-04** | `FindOrCreateClient` use case: single SQL upsert (`INSERT ON CONFLICT DO UPDATE SET updated_at = now() RETURNING *`) | M | Concurrent race: two calls → one row, both get same client_id |
| **T-03-05** | `UpdateClientLifecycleStatus` use case: validates status enum, writes update + audit event | M | Status changes correctly, audit event created |
| **T-03-06** | `MergeClientPreferences` use case: JSON merge patch (`||` operator), type validation against `vertical_config.customFields` | M | Partial patch preserves existing keys |
| **T-03-07** | Client CRUD API routes: `src/app/api/workspaces/[workspaceId]/clients/route.ts` (GET list, POST create), `[clientId]/route.ts` (GET, PATCH, DELETE), `[clientId]/lifecycle/route.ts` (PATCH) | M | All CRUD operations work with RLS |
| **T-03-08** | Inactivity detection: pg_cron job + Edge Function (`detect-inactive`) — find clients with `last_contacted_at` > 30 days → update to `inactive` + audit event | M | Job runs, inactive clients updated |
| **T-03-09** | Integration tests: concurrent upsert, workspace isolation, lifecycle transitions, preference merge, p99 < 50ms for findOrCreate | M | All pass |

**Dependency:** T-03-01 → T-03-02 → T-03-04, T-03-05, T-03-06 (parallel) → T-03-07 → T-03-09. T-03-08 independent after T-03-02.

---

### Phase 3: F-04 — Staff Notifications & Audit (parallel with Phase 2, ~2-3 days)

**Depends on:** T-00-05 (schema), T-02-04 (messages table populated)
**Architecture ref:** feature spec `f04-notifications-audit.md`

#### 3A: Audit Foundation (backend)

| Task | Description | Size | Test |
|------|-------------|------|------|
| **T-04-01** | `src/lib/audit/types.ts` — `AuditEvent` entity, `AUDIT_ACTION_TYPES` const, `AuditMetadata` type | S | Compiles, rejects unknown action types |
| **T-04-02** | `src/lib/audit/service.ts` — `AuditService.logEvent()` with fire-and-log pattern: non-blocking catch, structured error log, pgmq retry enqueue | M | Integration: event written; failure → logged + retry enqueued |
| **T-04-03** | Audit instrumentation in process-message: add `auditService.logEvent()` after message INSERT with `action_type: 'message_received'` | S | Inbound message → audit event row exists |
| **T-04-04** | Audit retry processor: pg_cron job (every 60s) → dequeue from `audit_retry` → re-attempt INSERT → after 3 failures → move to `audit_dlq` | M | Retry succeeds; malformed event → DLQ |

#### 3B: Realtime Notifications (frontend)

| Task | Description | Size | Test |
|------|-------------|------|------|
| **T-04-05** | `src/hooks/useInboxRealtime.ts` — Subscribe to `messages` INSERT + `drafts` INSERT Realtime channels filtered by workspace_id. Handle disconnect → polling fallback. | M | Realtime events received; disconnect → polling starts |
| **T-04-06** | `src/hooks/useUnreadCount.ts` — Server-authoritative count on mount, update from Realtime events, reset on conversation open. Browser tab title: `(N) Inbox`. | M | Count accurate, tab title updates |
| **T-04-07** | `GET /api/notifications/unread-count` route — SQL query for unread messages grouped by conversation | S | Returns correct counts |
| **T-04-08** | `PATCH /api/conversations/[conversationId]/read` route — Marks messages read, propagates via Realtime to other tabs | S | Messages marked read, cross-tab sync works |
| **T-04-09** | `src/components/NotificationToast.tsx` — Client name, message preview (100 chars), 5s auto-dismiss, 10s dedup, navigate on click | M | Toast shows, dedup works, navigation works |
| **T-04-10** | Add `is_read BOOLEAN NOT NULL DEFAULT false` to messages table migration (coordinate with F-02) | S | Column exists, defaults correctly |

**Dependency:** T-04-01 → T-04-02 → T-04-03, T-04-04 (parallel). T-04-05 → T-04-06 → T-04-09. T-04-07, T-04-08 independent.

---

### Phase 4: Staff App Shell (parallel with Phases 2-3, ~1-2 days)

Minimal UI to prove the pipeline works end-to-end.

| Task | Description | Size | Test |
|------|-------------|------|------|
| **T-UI-01** | Login page (`src/app/(auth)/login/page.tsx`) — Supabase Auth email/password | S | Can log in |
| **T-UI-02** | Dashboard layout (`src/app/(dashboard)/layout.tsx`) — Sidebar with nav (Inbox, Clients, Settings), auth guard | M | Renders, redirects if unauthenticated |
| **T-UI-03** | Inbox page (`src/app/(dashboard)/inbox/page.tsx`) — Conversation list sorted by `last_message_at`, unread badges, Realtime updates | M | Shows conversations, real-time updates |
| **T-UI-04** | Conversation thread (`src/app/(dashboard)/inbox/[conversationId]/page.tsx`) — Message bubbles (inbound/outbound), mark as read on open, message input (calls Baileys /send) | L | Messages display, can send, marks read |
| **T-UI-05** | Client list page (`src/app/(dashboard)/clients/page.tsx`) — Table with search, lifecycle filter | M | Lists clients, filters work |

---

## Dependency Graph

```
Phase 0 (Foundation)
  T-00-01..02 (Next.js)  ─────────────────────────────────────┐
  T-00-03 (Baileys scaffold) ──────────────────────────────────┤
  T-00-04..08 (Supabase + migrations + types) ─────────────────┤
  T-00-09..11 (Supabase clients + auth middleware) ────────────┤
                                                                │
Phase 1 (F-02: Message Pipeline)                                ▼
  T-02-01..08 (Baileys server) ──────────────────────┐
  T-02-09..11 (Edge Function shared) ─┐              │
  T-02-12 (process-message) ◀─────────┘              │
  T-02-13..15 (delivery + history + locks) ◀──────────┘
                                                       │
           ┌───────────────────────────────────────────┘
           │
           ▼
  Phase 2 (F-03: Client Identity)  ∥  Phase 3 (F-04: Notifications)  ∥  Phase 4 (UI Shell)
    T-03-01..09                         T-04-01..10                        T-UI-01..05
```

**Critical path:** T-00-04 → T-00-05 → T-00-06 → T-00-07 → T-02-04 → T-02-12 → T-03-04

---

## Parallel Execution Strategy

| Time | Agent A | Agent B | Agent C |
|------|---------|---------|---------|
| Day 1 AM | T-00-01..02 (Next.js scaffold) | T-00-03 (Baileys scaffold) | T-00-04..07 (Supabase setup) |
| Day 1 PM | T-00-09..11 (Supabase clients) | T-02-01 (auth-store) | T-00-08, T-00-10 (types, seed) |
| Day 2 | T-02-09..11 (Edge shared) | T-02-02..03 (socket-manager, QR) | T-04-01..02 (audit types, service) |
| Day 3 | T-02-12 (process-message) | T-02-04..05 (message handler, send) | T-04-05..06 (Realtime hooks) |
| Day 4 | T-03-01..04 (client domain + upsert) | T-02-06..08 (health, index, Docker) | T-04-07..09 (unread API, toast) |
| Day 5 | T-03-05..07 (lifecycle, prefs, API) | T-02-13..15 (delivery, history, locks) | T-UI-01..03 (login, layout, inbox) |
| Day 6 | T-03-08..09 (inactivity job, tests) | T-04-03..04 (audit instrumentation) | T-UI-04..05 (thread, clients) |
| Day 7 | Integration testing + fixes | E2E testing | Bug fixes |

---

## Risk Areas & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Baileys v6 API instability | Blocks all messaging | Pin exact version, wrap in abstraction layer, have Cloud API fallback plan |
| pgmq not available on Supabase free tier | Can't queue messages | Verify extension availability before starting; fallback: custom queue table with SKIP LOCKED |
| Supabase Realtime connection limits | Notifications unreliable | Polling fallback in useInboxRealtime (already designed in spec) |
| Advisory lock contention | Message processing stalls | Use `pg_try_advisory_xact_lock` (non-blocking), skip to next message if locked |
| Edge Function cold starts | Slow message processing | Pre-warm via pg_cron polling every 60s (already in architecture) |
| QR code SSE across Railway/Vercel domains | CORS issues | Configure CORS in Express, use environment-based origin allowlist |

---

## Testing Strategy

### Unit Tests (Vitest)
- Phone normalization (E.164 regex, country codes)
- AuditEvent construction + serialization
- Client entity lifecycle transitions
- Zod schema validations
- Toast dedup logic

### Integration Tests (Vitest + Supabase local)
- Client findOrCreate race condition (concurrent promises)
- pgmq enqueue/dequeue roundtrip
- RLS isolation (workspace A can't see workspace B's data)
- Audit fire-and-log pattern (failure doesn't block)
- p99 < 50ms for findOrCreate

### E2E Tests (Playwright)
- Login → Inbox → see conversations
- Receive mock inbound message → toast appears → badge increments
- Open conversation → messages marked read → badge decrements
- Client list → search → filter by lifecycle status

---

## Open Questions to Resolve Before Starting

1. **OQ-1 (from F-04 spec):** Add `message_received` to audit action types? → **Decision: YES** — full audit trail from day one.
2. **OQ-2 (from F-04 spec):** Does F-02 migration include `is_read` on messages? → **Decision: Include in 001_initial_schema.sql** — single migration avoids conflicts.
3. **OQ-3 (from F-04 spec):** Wire drafts Realtime channel in F-04? → **Decision: YES** — wire now, events fire when F-05 ships.
4. **baileys_auth FK:** Architecture says `REFERENCES workspaces(workspace_id)` but workspaces table uses `id` column. → **Fix: use `REFERENCES workspaces(id)`**
5. **F-03 column names:** Architecture uses `phone`, F-03 spec uses `phone_number`. → **Decision: Use `phone`** (matches architecture-final.md schema)

---

## Definition of Done (Sprint 1)

### Functional
- [ ] Workspace owner can scan QR code and connect WhatsApp (Baileys session established)
- [ ] Inbound messages received, deduplicated by wamid, stored in messages table
- [ ] Phone numbers normalized to E.164, matched to client records (find-or-create)
- [ ] Client lifecycle status set to "open" on first contact
- [ ] Staff receives in-app notification within 5 seconds of inbound message
- [ ] Unread badge counts are accurate, update across tabs
- [ ] Audit events logged for all data mutations

### Infrastructure
- [ ] Baileys session survives Railway container restart (credentials in Supabase)
- [ ] pgmq processes messages with correct per-client ordering (advisory locks)
- [ ] Failed processing retries via pgmq visibility timeout
- [ ] Dead letter queue captures messages after max retries
- [ ] Supabase Realtime delivers events to Next.js staff app

### Observability
- [ ] Baileys session health endpoint reports connection status
- [ ] Queue depth monitoring (alert when depth > 10 or age > 2 min)
- [ ] Message delivery status tracking (sent/delivered/read/failed)

### Quality
- [ ] TypeScript strict mode, zero `any` types
- [ ] 80%+ unit test coverage on business logic
- [ ] All integration tests pass
- [ ] No P0 security issues (RLS verified, no SQL injection, no XSS)
