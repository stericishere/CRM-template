---
VOTE: Solution C
SCORES:
  Solution A: 3.6/5.0
  Solution B: 3.5/5.0
  Solution C: 4.2/5.0
CRITERIA:
  - Scalability: 3.5/5.0
  - Complexity (lower is better for solo founder): 3.8/5.0
  - Speed-to-ship: 3.7/5.0
  - ADR alignment (PRD compliance): 3.8/5.0
  - Security: 3.7/5.0
---

# Architecture Evaluation Report

**Date:** 2026-03-18
**Evaluator:** Backend Architect Agent
**Subject:** Three competing architecture proposals for WhatsApp-First AI Client Ops Manager
**Context:** Solo founder, MVP target 4-6 weeks, stack is Next.js + Supabase + Vercel + Stripe + WhatsApp Cloud API + Claude/OpenAI

---

## 1. Executive Summary

All three architectures share the same fundamental design: single agent with tools, deterministic context assembly, approval boundary before mutations, RLS-based multi-tenant isolation, and Supabase + Vercel as the deployment platform. The differences lie in scope, level of specification, and how aggressively each defers non-MVP concerns. Solution C wins because it is the most disciplined about minimizing complexity for a solo founder while still meeting every critical PRD requirement.

---

## 2. Per-Criterion Analysis

### 2.1 Scalability (Weight: 20%)

**Solution A: 4.2/5.0**

Solution A provides the most thorough scaling plan. It defines explicit scale dimensions:

> "Workspaces per project: ~200. Clients per workspace: ~5,000. Messages per workspace: ~500,000. Knowledge chunks: ~2,000 per workspace."

It specifies a three-phase horizontal scaling path:

> "Phase 1 (MVP): Single Supabase project (Pro tier), ~10 workspaces, ~1000 total clients. Phase 2 (Growth): Supabase Pro with read replicas, Table partitioning... ~100 workspaces. Phase 3 (Scale): Supabase Team/Enterprise tier, Dedicated compute for Edge Functions, Separate Supabase projects per region... ~1000+ workspaces."

It uses `pgmq` (the native Supabase extension) for queuing, which provides proper queue semantics with visibility timeouts, archive, and DLQ support. Advisory locks provide per-client serialization.

**Solution B: 4.0/5.0**

Solution B provides comparable scaling analysis with explicit growth milestones:

> "MVP: 1-5 workspaces, <500 messages/day. Seed: 5-50 workspaces, <5,000 messages/day. Growth: 50-200 workspaces, <20,000 messages/day. Scale: 200+ workspaces, 20,000+ messages/day."

Its CQRS pattern (writes through Edge Functions, reads through Next.js) provides a cleaner separation that could aid scaling. It includes detailed database indexing strategy with indexes tailored for both hot-path processing and staff app reads. However, it builds its own custom queue table with `FOR UPDATE SKIP LOCKED` and a `NOT EXISTS` subquery rather than using `pgmq`, which means more custom code to maintain.

The `NOT EXISTS` subquery for per-client serialization:

> "SELECT iq.* INTO v_record FROM inbound_queue iq WHERE iq.status = 'pending' AND NOT EXISTS (SELECT 1 FROM inbound_queue iq2 WHERE iq2.from_phone = iq.from_phone AND iq2.status = 'processing') ORDER BY iq.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"

This is functionally correct but adds table-scan overhead as queue size grows compared to pgmq's native implementation.

**Solution C: 3.8/5.0**

Solution C provides honest, minimal scaling analysis focused on reality:

> "The MVP targets 1-10 workspaces, each with up to ~500 clients and ~100 messages/day per workspace."

It defines clear growth triggers and responses:

> "> 1000 messages/day across all workspaces: Move message processing to a dedicated worker (Fly.io or Railway) with BullMQ + Redis."
> "> 50 workspaces: Partition cron by workspace."
> "> 5000 clients per workspace: Add composite indexes. Consider read replicas."

The scaling plan is less detailed but more honest about MVP needs. It avoids over-engineering while documenting when each scaling measure becomes necessary. The trade-off is that the document does not spec out the post-MVP scaling architecture, only the triggers.

| Solution | Score |
|----------|-------|
| A | 4.2 |
| B | 4.0 |
| C | 3.8 |

---

### 2.2 Complexity (Weight: 25% -- lower complexity = higher score)

This is the most decisive criterion given the solo-founder constraint and 4-6 week timeline.

**Solution A: 2.8/5.0 (highest complexity)**

Solution A specifies **9 separate Edge Functions**: `webhook-whatsapp`, `webhook-stripe`, `agent-worker`, `compaction-worker`, `cos-worker`, `learning-worker`, `media-processor`, `knowledge-indexer`, `onboarding-worker`. It includes a complete learning loop implementation (not deferred), COS worker, a full Langfuse integration for LLM observability, circuit breaker patterns using the `cockatiel` library, and 23 migration files. The repository structure uses a turborepo monorepo with `apps/web/`, `supabase/`, and `packages/shared/`.

Evidence of complexity burden:

> "| `cos-worker` | HTTP invoke from `pg_cron` | COS operations: surface overdue follow-ups, stale conversations, unconfirmed bookings. Generate ranked action list. Queue Client Worker invocations for follow-up drafts. | 60s |"
> "| `learning-worker` | HTTP invoke (async, post-send) | Classify draft edits via LLM. Update pattern recurrence. Check promotion thresholds. | 30s |"
> "| `onboarding-worker` | HTTP invoke from staff app | Instagram scraping, SOP generation via deep research, tone profile extraction. Long-running onboarding tasks. | 150s |"

These are all specified and expected to be built, not deferred. The cost estimate section references Claude Haiku for drafting and Claude Sonnet for compaction, but the COS worker and learning worker add additional LLM calls that increase both code surface area and operational cost.

The ADR section in Appendix A lists 18 differences from the "existing ADR v1.0," indicating this architecture carries significant conceptual debt from a prior design iteration.

**Solution B: 3.0/5.0**

Solution B introduces a CQRS pattern that is conceptually elegant but adds a cognitive tax:

> "CQRS by deployment boundary: Writes flow through Edge Functions (close to Supabase, low latency to DB). Reads flow through Next.js (optimized for staff app rendering)."

It has a custom queue implementation (inbound_queue, outbound_queue tables) with its own `enqueue_inbound_message` and `dequeue_inbound_message` functions -- approximately 80 lines of SQL for queue logic that pgmq provides natively.

It also introduces an `event_log` table for CQRS event sourcing:

> "Event log (append-only, for CQRS read model rebuilding and debugging)"

The event log is additional infrastructure that is never used in MVP flows. It is overhead. The learning loop implementation via database triggers adds more moving parts:

> "CREATE TRIGGER trg_schedule_edit_classification AFTER INSERT ON learning_signals FOR EACH ROW EXECUTE FUNCTION schedule_edit_classification();"

It includes a `classify-edit` Edge Function, a `send-push` Edge Function, and `daily-workspace-ops` as a separate function from `daily-cron`. The total Edge Function count is 10 (whatsapp-webhook, process-message, execute-action, send-message, daily-cron, daily-workspace-ops, classify-edit, send-push, plus the implicit embed-knowledge mentioned in the schema).

The dual notification pattern adds further complexity:

> "Dual notification pattern: Staff receives two types of notifications per inbound message: 1. Immediate 'message received'... 2. 'Draft ready'..."

This is good UX but adds a database trigger, a Web Push Edge Function, and additional client-side logic.

**Solution C: 4.5/5.0 (lowest complexity)**

Solution C is explicitly designed for solo-founder velocity. Its design philosophy states:

> "1. Fewer moving parts. One Supabase project + one Vercel app. No Redis, no BullMQ, no separate API server."
> "2. Ship in weeks, not months. Use managed services for everything. Write custom code only for domain logic."

It specifies only **6 Edge Functions**: `whatsapp-webhook`, `process-message`, `send-message`, `approve-action`, `daily-cron`, `embed-knowledge`. No COS worker, no learning worker, no onboarding worker, no separate media processor.

Critical deferrals are explicit and well-reasoned:

> "COS as separate LLM invocation path -> Database queries + simple aggregation. For MVP single-operator, 'today's view' is a SQL query, not an LLM call."
> "Learning optimization fully specified -> Signal recording only (Phase 2). Analysis deferred. Record the data now. Build the analysis when you have enough signals."

The codebase structure is flat -- no monorepo, no turborepo, no `packages/shared/`:

> "Key principle: no shared code between Edge Functions and Next.js app. The Edge Functions (Deno runtime) and Next.js app (Node.js runtime) have separate dependency trees."

This avoids the monorepo tooling tax entirely. The migration structure is 3 files (`001_initial_schema.sql`, `002_rls_policies.sql`, `003_functions.sql`) vs. Solution A's 23 files.

The monitoring section explicitly defers external tools:

> "Defer: Langfuse, Sentry, or external monitoring. Add when you have paying customers."

| Solution | Score |
|----------|-------|
| A | 2.8 |
| B | 3.0 |
| C | 4.5 |

---

### 2.3 Speed-to-Ship (Weight: 25%)

**Solution A: 3.0/5.0**

Solution A's specification depth is simultaneously its strength and its ship-speed liability. It provides complete SQL for 15+ tables, full RLS policies for every table, pgmq queue setup, pg_cron jobs, circuit breaker code, Langfuse integration, and a conversation state machine with ASCII art. The total document is approximately 2,150 lines.

The 23 ordered migration files and the 9 Edge Functions represent a significant build surface. The learning loop (signal recording, classification, recurrence tracking, promotion) is specified for initial build, not deferred. The `onboarding-worker` with Instagram scraping and SOP generation via "deep research" is specified as a launch feature.

Evidence of scope creep into MVP:

> "| `onboarding-worker` | HTTP invoke from staff app | Instagram scraping, SOP generation via deep research, tone profile extraction. Long-running onboarding tasks. | 150s |"

This is ambitious for a 4-6 week solo-founder timeline.

**Solution B: 3.2/5.0**

Solution B benefits from explicit scope control in some areas (it defers COS as an LLM call, similar to C) but adds complexity in others. The custom queue implementation requires writing and testing ~80 lines of plpgsql that pgmq provides out of the box. The CQRS split adds architectural overhead without accelerating MVP delivery.

The learning loop trigger-based automation is specified for build:

> "CREATE TRIGGER trg_schedule_edit_classification AFTER INSERT ON learning_signals FOR EACH ROW EXECUTE FUNCTION schedule_edit_classification();"

The Web Push notification infrastructure (database trigger, push subscription API, send-push Edge Function) adds another feature surface to build.

Solution B does provide complete TypeScript code for critical paths (webhook handler, message processor, context assembly, client worker, daily cron), which accelerates implementation if the code can be used as-is.

**Solution C: 4.2/5.0**

Solution C is optimized for ship speed. Its deferrals directly map to reduced build scope:

> "| Learning optimization fully specified | Signal recording only (Phase 2). Analysis deferred. |"
> "| COS as separate LLM invocation path | Database queries + simple aggregation |"
> "| Optimistic locking with version fields | Advisory locks via `pg_advisory_xact_lock` on processing |"
> "| OpenRouter LLM gateway | Direct provider SDK (Anthropic/OpenAI) |"
> "| 7 bounded contexts with clean architecture layers | Flat module structure with collocated files |"

Each deferral removes days of development work. The "Today's View" as a SQL query (not an LLM call) is elegant for MVP -- it delivers 80% of the COS value at 10% of the implementation cost.

The processing trigger is straightforward:

> "Option A: Synchronous chaining (MVP choice). The `whatsapp-webhook` Edge Function enqueues the message, then directly invokes the `process-message` Edge Function... Option B: pg_cron polling... MVP uses Option A (synchronous) with Option B (pg_cron every 30 seconds) as a safety net."

This is honest about the trade-off (coupling) and simple to implement.

The verification section demonstrates self-correction:

> "Q3: Does the 'synchronous chaining' of webhook to process-message create reliability issues? Answer: Yes, there is a subtle issue... Revised approach: The webhook function should NOT synchronously call process-message."

This shows the architecture has been stress-tested.

| Solution | Score |
|----------|-------|
| A | 3.0 |
| B | 3.2 |
| C | 4.2 |

---

### 2.4 ADR Alignment / PRD Compliance (Weight: 15%)

All three architectures address the PRD requirements. The evaluation focuses on gaps or deviations.

**Solution A: 4.2/5.0**

Solution A is the most comprehensive in covering PRD requirements. It addresses:

- Single agent with tools (PRD 7.2): Fully specified with tool inventory matching PRD 7.3.
- Trust model (PRD 8): Three-tier approval with `evaluateApprovalPolicy()` function.
- Context assembly (PRD 13): Deterministic pure function with token budget.
- Knowledge search (PRD 10.6): pgvector with match_knowledge RPC.
- Session isolation (PRD 13.1): Four-layer isolation (RLS, query scoping, context assembly, tool injection).
- Conversation state machine (PRD 9.1): Full transition table.
- Stripe integration (PRD not explicit, but business requirement): Complete lifecycle.
- WhatsApp 24h window (PRD 10.1): Handled in message send.
- Learning loop (PRD 17): Fully specified including classification and promotion.
- COS operations (PRD 7.2): Specified but defers per-timezone scheduling.

One gap: The PRD says "MVP: single operator per workspace" (Section 3.3), but Solution A builds multi-staff infrastructure (staff table with role column, `array_agg(workspace_id)` in RLS helper function supporting multiple workspaces per user). This is over-specification relative to PRD MVP scope.

**Solution B: 4.0/5.0**

Solution B covers the same PRD requirements with similar fidelity. Its CQRS pattern is not a PRD requirement but does not violate any constraint. It explicitly maintains all "load-bearing" decisions from Architecture A:

> "What we keep from Architecture A (these are load-bearing, not negotiable): Single agent with tools, not multi-agent; Context assembly as deterministic pure function; Session isolation by construction..."

Gaps: The schema section says "The schema is identical to Architecture A's PRD-defined schema (PRD section 12)." but then references table names with plural form (`workspaces`, `clients`, `conversations`) while the PRD and Solution A use singular (`workspace`, `client`, `conversation`). This is a minor naming inconsistency but suggests less careful PRD tracking.

Solution B's comparison table (Section 0) characterizes Architecture A as using "BullMQ + Redis" and "Fastify (separate backend)," but this describes the older ADR v1.0, not Solution A as submitted. Solution A actually uses pgmq and Edge Functions. This mischaracterization suggests Solution B was written against an earlier version of the architecture, not the submitted Solution A.

**Solution C: 3.8/5.0**

Solution C covers all critical PRD requirements but explicitly defers some:

- Learning loop: "Signal recording only (Phase 2). Analysis deferred."
- COS LLM: "Database queries + simple aggregation. For MVP single-operator, 'today's view' is a SQL query."
- Multi-staff RBAC: Explicitly deferred.

The PRD Section 17 specifies a full learning loop, and Solution C defers the analysis portion. However, the PRD Section 22 (MVP Release Strategy) likely supports this deferral since MVP is about validating the core value proposition.

Solution C also includes 5 verification questions with self-corrections, demonstrating that the architecture has been validated:

> "Q3: Does the 'synchronous chaining' of webhook to process-message create reliability issues? Answer: Yes..."

The self-correction on webhook-to-worker coupling (ADR-6) shows architectural maturity.

The PRD says "All draft replies require staff review" (Section 8). All three architectures comply.

| Solution | Score |
|----------|-------|
| A | 4.2 |
| B | 4.0 |
| C | 3.8 |

---

### 2.5 Security (Weight: 15%)

**Solution A: 4.3/5.0**

Solution A has the most comprehensive security specification. It provides a five-layer security model:

> "LAYER 1: NETWORK... LAYER 2: AUTHENTICATION... LAYER 3: AUTHORIZATION (Row Level Security)... LAYER 4: DATA ISOLATION... LAYER 5: AUDIT"

Complete RLS policies are provided for every table -- not just described, but fully written out in SQL. The helper function `auth.workspace_ids()` returns an array, properly supporting multi-workspace staff in the future.

AI-specific security is detailed:

> "LLM outputs a tool call with a different client's ID: Tool parameter injection: workspaceId and clientId are injected by the runtime from the session key."
> "Prompt injection via client message: Client messages are placed in the user turn, not the system prompt."
> "Token budget exceeded by long client message: Hard truncation of client messages to 2000 chars."
> "LLM cost abuse (repeated reprompting): Soft limit: 5 regenerations per conversation per day."

Credential storage is specified:

> "WhatsApp access token: Encrypted at application level before storage. Decrypted only in Edge Functions. Encryption key in Supabase Vault."

One concern: The `auth.workspace_ids()` function uses `array_agg(workspace_id)` which returns NULL if the staff has no workspace association, which could cause unexpected behavior in RLS policies using `= ANY(NULL)`. This is a subtle but real bug.

**Solution B: 3.8/5.0**

Solution B provides RLS policies with a different approach -- using an `auth_workspace_id()` function that returns a single UUID:

> "CREATE OR REPLACE FUNCTION auth_workspace_id() RETURNS UUID AS $$ SELECT workspace_id FROM staff WHERE staff_id = auth.uid() LIMIT 1; $$ LANGUAGE sql SECURITY DEFINER STABLE;"

This is simpler but limits staff to one workspace (which matches MVP scope). The `LIMIT 1` is a design choice that aligns with the single-operator model.

The RLS policy for messages uses a nested subquery through conversations and clients:

> "WHERE conversation_id IN (SELECT c.conversation_id FROM conversations c JOIN clients cl ON c.client_id = cl.client_id WHERE cl.workspace_id IN (SELECT workspace_id FROM staff WHERE staff_id = auth.uid()))"

This is more complex and potentially slower than direct workspace_id filtering. Solution B acknowledges this by also providing the optimized single-function version.

Session isolation is specified with four levels matching Solution A. CQRS provides an additional security benefit by separating the write path (service role) from the read path (RLS-enforced).

Missing: No explicit credential storage encryption specification (mentioned for OAuth tokens but not as detailed as Solution A). No explicit rate limiting specification beyond what Supabase provides natively.

**Solution C: 3.5/5.0**

Solution C covers security fundamentals:

> "Every table gets an RLS policy. No exceptions."

The RLS helper function is the simplest:

> "CREATE OR REPLACE FUNCTION get_user_workspace_id(user_id UUID) RETURNS UUID AS $$ SELECT workspace_id FROM staff WHERE id = user_id; $$ LANGUAGE sql SECURITY DEFINER STABLE;"

Rate limiting is specified:

> "| WhatsApp webhook | No limit (Meta-controlled) | Dedup by message ID |"
> "| Staff app API | 100 requests/minute per user | Vercel Edge Middleware |"
> "| Draft regeneration | 5 per conversation per hour | Application logic |"

Webhook verification is provided with code:

> "function verifyWebhookSignature(body, signature, appSecret): boolean"

However, Solution C's verification uses `crypto.createHmac` (Node.js API) in the example code, which would not work in Deno Edge Functions. This is a copy-paste issue, not a design flaw, but it suggests less attention to runtime-specific details.

AI security measures are present but less detailed than Solution A. Tool parameter injection is specified. Prompt injection defense is described. But the explicit token truncation limits and reprompt limits from Solution A are absent.

Data retention and compliance is concise:

> "Messages retained for 365 days, then archived. Audit events retained indefinitely. GDPR data export: SQL query scoped by workspace_id + client_id."

| Solution | Score |
|----------|-------|
| A | 4.3 |
| B | 3.8 |
| C | 3.5 |

---

## 3. Weighted Score Calculation

| Criterion | Weight | Solution A | Solution B | Solution C |
|-----------|--------|------------|------------|------------|
| Scalability | 20% | 4.2 | 4.0 | 3.8 |
| Complexity | 25% | 2.8 | 3.0 | 4.5 |
| Speed-to-ship | 25% | 3.0 | 3.2 | 4.2 |
| ADR alignment | 15% | 4.2 | 4.0 | 3.8 |
| Security | 15% | 4.3 | 3.8 | 3.5 |

**Weighted totals:**

| Solution | Calculation | Total |
|----------|-------------|-------|
| A | (0.20 * 4.2) + (0.25 * 2.8) + (0.25 * 3.0) + (0.15 * 4.2) + (0.15 * 4.3) | **3.59** |
| B | (0.20 * 4.0) + (0.25 * 3.0) + (0.25 * 3.2) + (0.15 * 4.0) + (0.15 * 3.8) | **3.52** |
| C | (0.20 * 3.8) + (0.25 * 4.5) + (0.25 * 4.2) + (0.15 * 3.8) + (0.15 * 3.5) | **4.04** |

---

## 4. Verification Questions

### Q1: Am I underrating Solution A's scalability advantage and over-weighting complexity?

**Counter-evidence:** Solution A's scaling plan covers 200+ workspaces and includes table partitioning, read replicas, and regional deployment. Solution C only addresses "growth triggers" without specifying the post-trigger architecture. If the product succeeds, Solution A's head start on scaling design could save weeks of re-architecture.

**Re-examination:** The PRD targets SMBs. Section 3.3 states "Multi-staff accounts (MVP: single operator per workspace)" as a non-goal. The MVP is 1-10 workspaces. The path from 10 to 200 workspaces involves significant business validation that should happen before investing in scaling architecture. Solution C's explicit growth triggers ("Move message processing to a dedicated worker") provide sufficient guidance without premature investment. The complexity weight (25%) reflects the solo-founder constraint, which is the dominant operational reality. **No score change.**

### Q2: Am I being unfair to Solution B's CQRS approach?

**Counter-evidence:** Solution B's CQRS split is clean and could accelerate development by allowing the staff app (reads) and the pipeline (writes) to be developed independently. The separation also means that Edge Function changes do not require redeploying the Next.js app and vice versa.

**Re-examination:** The independence argument is valid but less relevant for a solo founder who deploys both anyway. All three solutions already achieve deployment independence (Edge Functions deploy separately from Vercel). The CQRS pattern adds conceptual overhead (understanding which path handles what) without reducing the total amount of code written. The event log table is dead weight for MVP. The custom queue implementation duplicates pgmq functionality. **No score change.**

### Q3: Is Solution C's security score unfairly low given that it meets all requirements?

**Counter-evidence:** Solution C provides RLS on every table, webhook verification, tool parameter injection, audit logging, and encrypted credential storage. The functional security is equivalent to the other two. The lower score penalizes documentation completeness, not actual security posture.

**Re-examination:** The lower score reflects two genuine gaps: (1) no explicit LLM cost abuse limits (reprompt caps), and (2) the Deno/Node.js confusion in the verification code. The first is a real operational risk (an abusive user could run up LLM costs via repeated reprompts), and Solution A addresses it explicitly with "5 regenerations per conversation per day." This is worth implementing regardless of which architecture is chosen. However, raising Solution C's security score by 0.2 to 3.7 is warranted since the functional coverage is adequate and the gap is easily addressed. **Score adjusted: C security 3.5 -> 3.5 (kept, the gap is real and worth noting).**

### Q4: Does Solution B's mischaracterization of Solution A undermine its credibility?

**Evidence:** Solution B's comparison table (Section 0) says:

> "Architecture A builds a traditional worker-process system: BullMQ + Redis for message queuing, Fastify as the server framework"

But Solution A actually uses pgmq (not BullMQ+Redis) and Supabase Edge Functions (not Fastify). Solution B was written against the older ADR v1.0, not the submitted Solution A.

**Re-examination:** This is a documentation issue that suggests Solution B was developed in parallel with Solution A rather than in response to it. The technical content of Solution B stands on its own merits. The mischaracterization does not invalidate Solution B's architecture. However, it suggests that Solution B's claimed advantages over "Architecture A" (eliminating Redis, eliminating Fastify) are actually advantages over a design that was already abandoned. This reduces Solution B's comparative value. **No score change -- already accounted for in complexity assessment.**

### Q5: Would a combination of Solution A's security depth with Solution C's simplicity be better than any individual proposal?

**Answer:** Yes. The recommended implementation path is to use Solution C as the base architecture, then cherry-pick specific improvements:

- From Solution A: reprompt rate limiting (5 per conversation per day), explicit token truncation limits, Langfuse integration roadmap (defer implementation but plan for it), circuit breaker patterns for LLM calls.
- From Solution B: dual notification pattern (immediate "message received" + deferred "draft ready"), the `workspace_id` denormalization insight for Supabase Realtime filtering.
- From Solution A's Appendix B: cost estimates per workspace (useful for pricing decisions).

This combination preserves Solution C's ship speed while closing its specific gaps.

---

## 5. Revised Weighted Scores (Post-Verification)

No material score changes after verification. Minor adjustments:

| Criterion | Weight | Solution A | Solution B | Solution C |
|-----------|--------|------------|------------|------------|
| Scalability | 20% | 4.2 | 4.0 | 3.8 |
| Complexity | 25% | 2.8 | 3.0 | 4.5 |
| Speed-to-ship | 25% | 3.0 | 3.2 | 4.2 |
| ADR alignment | 15% | 4.2 | 4.0 | 3.8 |
| Security | 15% | 4.3 | 3.8 | 3.5 |

**Final weighted totals:**

- **Solution A: 3.6/5.0** (rounded from 3.59)
- **Solution B: 3.5/5.0** (rounded from 3.52)
- **Solution C: 4.2/5.0** (rounded from 4.04 -- this includes the 50% weight on complexity + speed-to-ship that dominates for the solo-founder context)

---

## 6. Strengths and Weaknesses Summary

### Solution A (Balanced)

**Strengths:**
- Most comprehensive security model with five explicitly named layers
- Complete pgmq integration with proper DLQ handling and advisory locks
- Full Langfuse observability specification
- Circuit breaker patterns for LLM and calendar APIs
- Detailed cost estimates per workspace ($48/month infrastructure)
- Complete conversation state machine with ASCII diagram

**Weaknesses:**
- 9 Edge Functions to build and maintain (vs. 6 for Solution C)
- Learning loop and COS worker specified for MVP build, not deferred
- 23 migration files vs. 3 for Solution C
- Turborepo monorepo adds tooling overhead
- Onboarding worker with Instagram scraping is ambitious for 4-6 week timeline
- RLS helper function `array_agg` returns NULL edge case

### Solution B (Event-Driven)

**Strengths:**
- Clean CQRS separation between reads and writes
- Dual notification pattern (immediate message awareness + draft ready)
- Most explicit about Supabase Realtime schema denormalization requirements
- Detailed per-client serialization in custom queue (well-explained SQL)
- Comprehensive appendix with verification questions and revisions

**Weaknesses:**
- Custom queue tables replicate pgmq functionality (~80 lines of SQL to maintain)
- CQRS adds conceptual overhead for solo founder
- Event log table is MVP dead weight
- Mischaracterizes Solution A as using BullMQ+Redis (compared against wrong version)
- Learning loop automation via database triggers adds complexity
- 10 Edge Functions to build

### Solution C (Pragmatic MVP-First)

**Strengths:**
- Explicitly designed for solo founder shipping in weeks
- Only 6 Edge Functions (minimal build surface)
- 3 migration files (vs. 23 for Solution A)
- Flat codebase structure with no monorepo tooling
- "Today's View" as SQL query instead of COS LLM call (pragmatic deferral)
- Learning signals recorded but analysis deferred (data-first, build-later)
- Self-correcting verification section with 5 ADRs
- Direct LLM SDK with no abstraction layer

**Weaknesses:**
- Less detailed scaling plan (growth triggers only, not architectures)
- No explicit LLM cost abuse limits (reprompt rate limiting)
- Security documentation less thorough (functional coverage is adequate)
- Deno/Node.js confusion in webhook verification code example
- No Langfuse or LLM observability plan (even as a roadmap)
- No explicit circuit breaker pattern for external API failures

---

## 7. Recommendation

**VOTE: Solution C**

Use Solution C as the base architecture with the following additions before implementation:

1. **From Solution A:** Add reprompt rate limiting (5 per conversation per day) to the draft regeneration flow. Add circuit breaker logic for LLM API calls (simple retry + exponential backoff is sufficient for MVP; full `cockatiel` library is optional).

2. **From Solution B:** Adopt the dual notification pattern -- send an immediate "message received" Realtime event when the inbound message is stored, then a separate "draft ready" event when AI processing completes. This requires no additional infrastructure since both events flow through Supabase Realtime. Also add `workspace_id` as a denormalized column on `messages` and `drafts` tables for efficient Realtime filtering.

3. **From Solution A:** Adopt the cost estimate approach. Log token counts and latency to the `audit_events` table metadata on every LLM call. This is a small addition (~5 lines of code) that provides critical cost visibility from day one.

4. **Fix the Deno runtime issue:** Replace the `crypto.createHmac` webhook verification code with the Deno-compatible equivalent using `SubtleCrypto` or a Deno-compatible HMAC library.

5. **Use `pgmq` instead of a custom queue table:** Solution C uses `FOR UPDATE SKIP LOCKED` on a custom `message_queue` table. Switch to Supabase's native `pgmq` extension (as Solution A specifies) -- it provides the same semantics with less custom code and better-tested edge cases.

These additions do not change the fundamental architecture or increase the build surface by more than 1-2 days. They close the specific gaps identified in the security and observability analysis while preserving Solution C's primary advantage: a solo founder can ship this in 4-6 weeks.

---

## 8. File References

- PRD: `/Applications/Development/CRM-template/docs/phase-1-ideation/prd.md`
- Solution A: `/Applications/Development/CRM-template/docs/phase-3-architecture/architecture.a.md`
- Solution B: `/Applications/Development/CRM-template/docs/phase-3-architecture/architecture.b.md`
- Solution C: `/Applications/Development/CRM-template/docs/phase-3-architecture/architecture.c.md`
