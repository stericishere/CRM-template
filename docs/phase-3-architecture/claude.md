# phase-3-architecture — Decisions & Context

## Date
2026-03-18

## Summary

Architecture locked for the WhatsApp-First AI Client Ops Manager. Used SADD `do-competitively` pattern: 3 competing proposals, 3 independent judges, SELECT_AND_POLISH of unanimous winner.

**Winner: Solution C (Pragmatic MVP-First)** — Score: 4.2/5.0 (unanimous, all 3 judges)

Polished with cherry-picks from Solutions A and B per judge consensus. Final architecture written to `architecture-final.md`.

## Stack Finalized

| Layer | Technology |
|---|---|
| Staff web app | Next.js 15 (App Router) on Vercel |
| Database | Supabase PostgreSQL |
| Auth | Supabase Auth (email/password, JWT with workspace_id) |
| Message queue | pgmq (Supabase extension) |
| Knowledge search | pgvector (Supabase extension) |
| Scheduled jobs | pg_cron + pg_net (Supabase extensions) |
| Real-time | Supabase Realtime (Postgres Changes) |
| File storage | Supabase Storage |
| LLM | Claude Sonnet 4 (drafting), Haiku (compaction), via OpenRouter |
| Embeddings | text-embedding-3-small (OpenAI) |
| Payments | Stripe |
| WhatsApp | Baileys v6+ (WhatsApp Web protocol, QR pairing) on Railway |
| Calendar | Google Calendar API (OAuth per workspace) |
| Hosting | Vercel (Next.js) + Supabase (Edge Functions + DB) + Railway (Baileys server) |

## Key Decisions

- **pgmq over BullMQ + Redis** — zero additional infrastructure, built-in visibility timeout + DLQ, ACID with Postgres (ADR-001, ADR-002)
- **Edge Functions for webhooks + processing, Next.js for staff API** — 6 Edge Functions, 150s timeout comfortable for LLM calls (ADR-001)
- **Flat codebase over DDD bounded contexts** — solo founder speed, refactor when team > 2 (ADR-003)
- **No COS LLM call for MVP** — "Today's View" is a SQL query, not an LLM invocation
- **OpenRouter for all LLM calls (including embeddings)** — OpenAI-compatible SDK, models from env vars (PRO_MODEL, FLASH_MODEL, SMALL_MODEL, EMBEDDING_MODEL). Replaces "direct SDK" decision. (ADR-005 amended)
- **4-layer isolation** — Supabase Auth -> RLS -> query scoping -> tool parameter injection (ADR-003)
- **Dual notification pattern** — raw message saved at webhook time (staff sees it immediately via Realtime), draft arrives async after LLM processing
- **workspace_id denormalized** on messages, drafts, notes, proposed_actions for efficient Realtime filtering
- **LLM usage logging** to dedicated `llm_usage` table from day one (cost visibility)
- **Reprompt rate limiting** — 5/hour/conversation to prevent LLM cost overruns

## Key Trade-offs Accepted

| Trade-off | What we give up | What we gain |
|---|---|---|
| pgmq over Redis | Throughput ceiling (~1K ops/sec vs ~100K) | Zero infrastructure, ACID durability |
| Flat modules over DDD | Module boundary enforcement | Speed to ship, navigable at solo scale |
| No COS LLM call | NL cross-client queries | Simplicity, cost savings |
| Deno Edge Functions | Full npm ecosystem | 150s timeout, direct DB access |
| No Langfuse | Advanced LLM tracing | Simplicity, llm_usage table sufficient |
| Single operator per workspace | Multi-staff collaboration | Simpler auth, no RBAC |

## Deployment Targets

- **Vercel**: Next.js app (auto-deploy on push to main)
- **Supabase**: Edge Functions + DB migrations (CLI deploy via GitHub Actions)
- **Model**: B2B template — one Supabase project per client for data isolation, or multi-tenant with RLS

## Known Technical Debt Accepted

1. Deno/Node.js type sharing may require duplication of some types in `_shared/` vs `lib/`
2. Learning loop analysis deferred (signal recording only in Phase 2)
3. No external monitoring (Sentry, Langfuse) — Supabase/Vercel logs + llm_usage table for MVP
4. No offline/PWA support — staff app must be open for Realtime updates
5. No circuit breaker patterns — simple retry + pgmq visibility timeout
6. Baileys (WhatsApp Web) chosen over Cloud API — per PRD owner decision. Adds Railway server as 3rd deployment target. Risk: unofficial protocol may break. Fallback: Cloud API.

## Inputs Used

- PRD v2.1 (`docs/phase-1-ideation/prd.md`)
- Previous architecture draft (`docs/phase-3-architecture/adr/architecture.md`)
- 3 competing proposals (`architecture.a.md`, `architecture.b.md`, `architecture.c.md`)
- 3 judge evaluation reports (`.specs/reports/architecture-2026-03-18.[1|2|3].md`)

## Outputs Produced

- `docs/phase-3-architecture/architecture-final.md` — final polished architecture (106KB)
- `docs/phase-3-architecture/architecture.a.md` — Solution A: Balanced (107KB)
- `docs/phase-3-architecture/architecture.b.md` — Solution B: Event-driven (98KB)
- `docs/phase-3-architecture/architecture.c.md` — Solution C: Pragmatic MVP (78KB)
- `docs/phase-3-architecture/adr/001-framework.md` — Next.js + Edge Functions
- `docs/phase-3-architecture/adr/002-database.md` — Supabase PostgreSQL + pgmq + pgvector
- `docs/phase-3-architecture/adr/003-auth.md` — Supabase Auth + 4-layer isolation
- `docs/phase-3-architecture/adr/004-state-management.md` — Supabase Realtime + server-driven state
- `docs/phase-3-architecture/adr/005-api-design.md` — Split API pattern + LLM integration
- `.specs/reports/architecture-2026-03-18.[1|2|3].md` — Judge evaluation reports
- `docs/phase-3-architecture/claude.md` — this journal

## Open Questions

1. **WhatsApp Cloud API vs Baileys** — RESOLVED. PRD owner confirmed Baileys (QR pairing). Architecture updated to use `@whiskeysockets/baileys` v6+ on a persistent Node.js server (Railway). Adds a third deployment target but eliminates WABA registration, per-conversation fees, and 24h window restrictions. Cloud API remains the fallback if Baileys becomes unsustainable.
2. **Embedding model** — text-embedding-3-small chosen for cost. May need evaluation vs. alternatives.
3. **Supabase free vs Pro tier for MVP** — free tier has 500K Edge Function invocations/month, 200 Realtime connections. Likely sufficient for <5 pilot workspaces.

## Deferred Items

| Item | Phase | Trigger |
|---|---|---|
| Learning loop analysis | Phase 4 | 500+ draft edit signals collected |
| COS LLM invocation | Phase 3+ | Staff requests NL cross-client queries |
| Multi-staff RBAC | Post-MVP | Workspace needs 2+ operators |
| Langfuse observability | Post-MVP | Debugging becomes painful |
| Web Push notifications | Post-MVP | Staff requests background alerts |
| Auto-send (no staff review) | Post-MVP | Draft acceptance > 90% sustained |
| Circuit breaker patterns | Post-MVP | External API failures become frequent |

## Next Phase

Architecture locked. Proceed to `/phase-4-feature-design` for user stories and feature specs.

---

## Sprint 2 Implementation Amendments (March 2026)

The following decisions were made during Sprint 2 implementation. Each amends or refines the original architecture above. See `architecture-final.md` Section 19 for the full list.

### LLM Integration (ADR-005 amended)
- All LLM calls (drafting, compaction, embeddings) route through **OpenRouter** using OpenAI-compatible SDK (`baseURL: 'https://openrouter.ai/api/v1'`).
- Models are env vars: `PRO_MODEL`, `FLASH_MODEL`, `SMALL_MODEL`, `EMBEDDING_MODEL`. No model IDs in code.
- Embeddings go through OpenRouter too — not direct OpenAI API.

### Context Architecture
- `ReadOnlyContext` explicitly split into `GlobalContext` (workspace-level, cacheable) and `MessageContext` (per-client, per-message).
- `GlobalContext` fields: `identity`, `agent`, `tools`, `businessContext` (includes `scheduledReminder`), `memory`, `heartbeat`.
- Agent system prompt templates are Markdown files at `src/app/api/workspaces/agent/`.
- Builder modules live in `global-context/` at project root.

### Approval Policy
- Auto tier is **empty in MVP**. All agent-proposed writes go through staff review.
- This includes `note_create`, `tag_attach`, `last_contacted_update` — previously listed as auto.
- Auto tier reserved for future cron job actions (appointment reminders, etc.).
- Approve-action execution order: execute domain action first, mark `approved` only on success. Failure leaves `pending` for retry.
- If `proposed_actions` INSERT fails after draft save: draft is deleted to preserve idempotency.

### Booking Flow
- `calendar_book` tool captures `appointmentType + startTime` (not `slotId`).
- Executor computes `end_time = start_time + durationMinutes` from `vertical_config.appointmentTypes`.
- Default `durationMinutes = 60` if not configured.

### Idempotency
- `drafts.source_message_id` (UUID FK to `messages`) is the per-message idempotency key.
- Unique index: one draft per inbound message.
- Multiple messages before staff review each get their own draft.

### DLQ
- `inbound_dlq` is a pgmq queue (not a table).
- DLQ write happens **before** archiving the main queue message.

### Baileys Authentication
- Send requests include `x-api-secret` header from `BAILEYS_API_SECRET` env var.
- Non-2xx responses fail the action and set `messages.delivery_status = 'failed'`.

### Sprint 3 Design (proactive operations)
- Four cron jobs planned: heartbeat (2h), appointment reminder (daily 9am), follow-up trigger (hourly, 72h per-client timer), memory compaction (daily 3am).
- Spec: `docs/phase-4-feature-design/feature-specs/proactive-operations-cron.md`.
