# ADR-002: Supabase PostgreSQL with pgmq, pgvector, pg_cron

**Status:** Accepted
**Date:** 2026-03-18
**Deciders:** Solo founder
**Source:** architecture-final.md ADR-1, ADR-7

## Context

The system needs:
1. Relational storage for all domain entities (workspaces, clients, conversations, messages, drafts, bookings, etc.)
2. A durable message queue for webhook-to-processor decoupling
3. Vector search for knowledge base semantic retrieval
4. Scheduled jobs for daily compaction, follow-up surfacing, inactivity detection
5. LLM usage tracking for cost visibility

The previous architecture used BullMQ + Redis for queuing. The stack constraint specifies Supabase (managed PostgreSQL).

## Decision Drivers

- Zero additional infrastructure beyond Supabase
- Message reliability: queue must never lose messages
- Webhook deduplication via unique constraint on WhatsApp message ID
- MVP throughput: ~100-500 messages/day per workspace
- Cost visibility from day one for LLM usage

## Decision

**Supabase PostgreSQL as the single data store** with these extensions:

### pgmq (message queue)
- Replaces BullMQ + Redis entirely
- Built-in visibility timeout (if Edge Function crashes, message auto-requeues after 60s)
- Built-in dead letter queue (after 3 failures, message archived for manual review)
- ACID-compliant: enqueue + raw message save in same transaction = atomic
- Throughput ceiling: ~1,000 ops/sec — sufficient for SMB volumes

### pgvector (knowledge search)
- Stores embeddings for knowledge base chunks (1536 dimensions, text-embedding-3-small)
- Semantic search via cosine similarity
- IVFFlat index for performance at scale

### pg_cron (scheduled jobs)
- Daily compaction at 3 AM per workspace timezone
- Follow-up surfacing at 8 AM per workspace timezone
- Queue retry sweep every 1 minute (safety net for pgmq)
- Inactivity detection daily

### pg_net (async HTTP)
- Triggers processing Edge Function from DB trigger on pgmq enqueue
- Fire-and-forget HTTP call — if it fails, pg_cron sweep catches it

### llm_usage table
- Every LLM call logs: workspace_id, client_id, call_type, model, tokens_in, tokens_out, latency_ms, cost_usd
- Enables per-workspace cost analysis for pricing decisions
- Separate from audit_events for cleaner queries

## Schema Approach

- All tables carry `workspace_id` for RLS enforcement
- `workspace_id` denormalized onto messages, drafts, notes, proposed_actions for efficient Realtime filtering (no JOINs in RLS policies)
- Denormalization maintained by INSERT triggers (set from parent record, immutable after insert)
- Foreign keys enforce referential integrity
- Soft delete (`deleted_at`) on clients for merge history

## Consequences

### Positive
- Single database for everything (storage, queue, search, scheduling, events)
- Zero additional infrastructure cost
- Message durability guaranteed by Postgres ACID
- pgmq edge cases (concurrent access, visibility timeout, DLQ) are better-tested than custom queue table

### Negative
- pgmq throughput ceiling (~1,000 ops/sec) is lower than Redis (~100,000 ops/sec)
- pgvector performance degrades at >100K embeddings per workspace (sufficient for MVP)
- pg_cron minimum granularity is 1 minute

### Reversal Triggers
- pgmq: sustained throughput > 1,000 msgs/hour requires BullMQ + Redis (Upstash)
- pgvector: > 100K chunks per workspace requires dedicated vector DB (Pinecone/Qdrant)
- pg_cron: sub-minute scheduling needed requires external scheduler
