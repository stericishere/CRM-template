# ADR-005: Split API — Edge Functions for Processing, Next.js for Staff Actions

**Status:** Accepted
**Date:** 2026-03-18
**Deciders:** Solo founder
**Source:** architecture-final.md Sections 3, 6, 8, ADR-5, ADR-8

## Context

The system has two categories of API interactions:
1. **Machine-to-machine**: WhatsApp webhooks, LLM calls, calendar API, daily cron — latency-tolerant, long-running, no user JWT
2. **Staff-to-system**: approve draft, send message, edit client, upload knowledge — latency-sensitive, short-running, authenticated via JWT

We need to decide how to split these across the available execution environments.

## Decision Drivers

- Webhook must return 200 within 5 seconds (Meta requirement)
- LLM processing needs up to 30 seconds
- Staff actions need fast response (<500ms)
- Minimize deployment complexity

## Decision

### Edge Functions (Supabase, Deno runtime) — 6 functions

| Function | Trigger | Purpose |
|---|---|---|
| `whatsapp-webhook` | HTTP POST from Meta | Verify, deduplicate, save message, enqueue to pgmq |
| `process-message` | pg_net from DB trigger | Context assembly → LLM → tools → draft → approval |
| `send-message` | HTTP from Next.js | 24h window check → WhatsApp Cloud API send |
| `approve-action` | HTTP from Next.js | Execute approved ProposedAction, audit log |
| `daily-cron` | pg_cron | Compaction, follow-ups, inactivity |
| `embed-knowledge` | HTTP from Next.js | Chunk text → generate embeddings → upsert |

Edge Functions use service role key (bypass RLS). Auth is via webhook signature (WhatsApp, Stripe) or internal service key (pg_net, Next.js calls).

### Next.js API Routes / Server Actions (Vercel, Node.js runtime)

| Route | Purpose |
|---|---|
| Staff CRUD (clients, notes, follow-ups) | Direct Supabase queries with user JWT (RLS enforced) |
| `/api/drafts/reprompt` | Regenerate draft with staff instruction (rate limited: 5/hour/conversation) |
| `/api/webhooks/stripe` | Stripe subscription lifecycle events |
| `/api/auth/callback` | Google Calendar OAuth callback |
| `/api/knowledge` | Knowledge CRUD, triggers embed-knowledge Edge Function |

Next.js routes use the authenticated user's JWT. RLS enforces workspace isolation automatically.

### LLM Integration Pattern

**Single agent with tools** — one LLM invocation per inbound message:
- Model: Claude Sonnet 4 (drafting), Haiku (compaction)
- Direct SDK call (`@anthropic-ai/sdk`), no abstraction layer
- Tool loop: max 5 iterations
- Tool parameter injection: `workspaceId` and `clientId` immutable, set by runtime
- Cost logged to `llm_usage` table on every call

**Approval boundary** — three trust tiers:
| Tier | Actions | Behavior |
|---|---|---|
| auto | Save note, update last_contacted | Execute immediately, audit log |
| review | Booking, client update, follow-up, draft | ProposedAction → staff confirmation card |
| human_only | Refund, pricing, complaint | Flag conversation, no draft |

### Rate Limiting

| Endpoint | Limit | Reason |
|---|---|---|
| Reprompt | 5/hour/conversation | Prevent LLM cost runaway |
| Webhook (per sender) | 20 msgs/min | Spam protection |
| Staff API (per user) | 100 req/min | General abuse prevention |

## Consequences

### Positive
- Clean separation: long-running async work in Edge Functions, fast sync work in Next.js
- Staff actions benefit from Vercel CDN and fast cold starts
- Edge Functions have 150s timeout (comfortable for LLM calls)
- Rate limiting on reprompts prevents cost overruns

### Negative
- Two execution environments (Deno + Node.js)
- Edge Function → Next.js communication requires HTTP (not shared memory)
- Staff actions that need Edge Function processing (send, approve) have an extra hop

### Reversal Triggers
- ADR-5 (direct SDK): switch to OpenRouter if multi-model fallback needed
- Rate limits too restrictive: make configurable per workspace
- Edge Function limitations: extract to dedicated Node.js server
