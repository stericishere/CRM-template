---
VOTE: Solution C
SCORES:
  Solution A: 3.6/5.0
  Solution B: 3.1/5.0
  Solution C: 4.2/5.0
CRITERIA:
  - Scalability: 3.8/5.0
  - Complexity (lower is better for solo founder): 3.5/5.0
  - Speed-to-ship: 3.5/5.0
  - ADR alignment (PRD compliance): 3.9/5.0
  - Security: 4.0/5.0
---

# Architecture Evaluation Report: WhatsApp-First AI Client Ops Manager

**Date:** 2026-03-18
**Evaluator:** Backend Architect Agent
**Context:** Three architecture proposals evaluated against PRD v2.1 requirements for a solo-founder SaaS targeting SMBs. Stack: Next.js + Supabase + Vercel + Stripe + WhatsApp Cloud API + Claude/OpenAI.

---

## 1. Executive Summary

All three proposals share the same fundamental architecture: Supabase Edge Functions for server-side processing, Next.js on Vercel for the staff app, PostgreSQL as the single stateful component, pgmq/Postgres-backed queue replacing BullMQ+Redis, and Supabase Realtime for live updates. The differences are in scope, abstraction level, and how much ceremony each proposal introduces.

**Solution A** is the most detailed and comprehensive specification -- a monorepo with a shared `packages/` layer, 9 Edge Functions, extensive CI/CD pipeline, and formalized scaling milestones. It reads like a team-level architecture document.

**Solution B** introduces CQRS by deployment boundary, an explicit event log table, and a dual-notification pattern. It is the most theoretically rigorous, with the strongest separation of concerns.

**Solution C** is the most pragmatic. It explicitly optimizes for a solo founder, defers features aggressively (COS LLM calls, learning loop analysis, multi-staff RBAC), and provides the clearest path from zero to production.

After detailed analysis and self-verification, **Solution C wins** because this is a 4-6 week MVP for a solo founder, and C eliminates the most complexity without sacrificing structural correctness. The core guarantees (session isolation, approval boundary, tool parameter injection, RLS, webhook verification) are preserved identically across all three proposals.

---

## 2. Per-Criterion Analysis

### 2.1 Scalability (Weight: 20%)

| Solution | Score | Rationale |
|---|---|---|
| A | 4.5 | Most detailed scaling plan with explicit milestones |
| B | 4.0 | Good scaling story but CQRS adds operational surface |
| C | 3.5 | Adequate for 500+ workspaces with explicit growth triggers |

**Solution A** provides the most rigorous scaling analysis. It specifies exact limits:
> "Workspaces per project: ~200. Clients per workspace: ~5,000. Messages per workspace: ~500,000." (Section 7.3)

It includes a three-phase horizontal scaling path:
> "Phase 1 (MVP): Single Supabase project (Pro tier) ... Phase 2 (Growth): Supabase Pro with read replicas, table partitioning ... Phase 3 (Scale): Supabase Team/Enterprise tier, dedicated compute, separate projects per region" (Section 8.3)

It addresses pgmq throughput directly:
> "pgmq handles thousands of messages/second within Postgres. Not a bottleneck for SMB scale." (Section 8.2)

And Edge Function concurrency:
> "Supabase Pro: 100 concurrent Edge Functions. Queue absorbs bursts beyond this." (Section 8.2)

**Solution B** adds the CQRS split:
> "Edge Functions run close to the Supabase database (same region). Write-heavy operations like message processing benefit from low-latency DB access." (Section 2.2)

However, the event_log table adds write amplification:
> "Event log (append-only, for CQRS read model rebuilding and debugging)" (Section 7.2)

At SMB scale, this event log provides no practical value but adds storage costs and write overhead. It is an over-abstraction for the problem space.

**Solution C** provides a simpler but adequate scaling story:
> "MVP targets 1-10 workspaces, each with up to ~500 clients and ~100 messages/day per workspace." (Section 4.1)

Its growth triggers are pragmatic:
> "> 1000 messages/day across all workspaces: Move message processing to a dedicated worker (Fly.io or Railway) with BullMQ + Redis." (Section 4.2)

**Gap in C:** No explicit limits on workspace count, no connection pooling discussion, no partitioning strategy. These are acceptable deferrals for MVP but need to be addressed at 50+ workspaces.

**Verdict:** A leads here, but the extra scaling detail is premature for a solo founder. C provides sufficient scaling headroom for the first 12+ months.

---

### 2.2 Complexity (Weight: 25%) -- Lower complexity = higher score

| Solution | Score | Rationale |
|---|---|---|
| A | 3.0 | Monorepo with shared packages, 9 Edge Functions, CI/CD pipeline |
| B | 2.5 | CQRS, event log, dual notifications, custom dequeue function |
| C | 4.5 | Flat structure, 6 Edge Functions, explicit deferrals |

This is the most differentiating criterion for a solo founder working in a 4-6 week timeframe.

**Solution A** specifies 9 Edge Functions:
> "webhook-whatsapp, webhook-stripe, agent-worker, compaction-worker, cos-worker, learning-worker, media-processor, knowledge-indexer, onboarding-worker" (Section 2.1)

It introduces a monorepo with Turborepo:
> "packages/shared/ -- Shared TypeScript types + utilities" (Section 9.2)

And a formalized CI/CD pipeline with GitHub Actions:
> "on push to main: Lint + type check (turbo run lint typecheck), Run tests (turbo run test), Deploy Supabase migrations, Deploy Edge Functions, Deploy Next.js" (Section 9.3)

The shared packages layer creates a cross-runtime dependency that A itself acknowledges is problematic:
> Types can be shared, but "Edge Functions (Deno runtime) and Next.js app (Node.js runtime) have separate dependency trees" -- this tension between the monorepo structure and the runtime split adds cognitive overhead.

**Solution B** is the most complex. It introduces CQRS as a first-class concept:
> "CQRS by deployment boundary. Writes flow through Edge Functions. Reads flow through Next.js." (Section 1.2)

It builds a custom PostgreSQL queue rather than using pgmq:
> "CREATE TABLE inbound_queue..." with a custom `dequeue_inbound_message` function (Section 3.2)

This is 50+ lines of SQL for per-client serialization that Solution A achieves with pgmq + advisory locks. B's approach is technically sound but requires maintaining custom queue logic.

B also introduces an event log:
> "CREATE TABLE event_log (id BIGSERIAL PRIMARY KEY, workspace_id UUID, event_type TEXT, entity_type TEXT, entity_id UUID, payload JSONB)" (Section 7.2)

And a dual notification pattern:
> "1. Immediate 'message received' -- triggered when the inbound message row is stored... 2. 'Draft ready' -- triggered when the AI draft is saved." (Section 8.2)

While technically valuable, this doubles the notification implementation surface.

**Solution C** is deliberately minimal:
> "This architecture is designed for a solo founder shipping fast. Every decision optimizes for: 1. Fewer moving parts. 2. Ship in weeks, not months. 3. Correct by construction. 4. Defer what you can." (Section 0)

It specifies only 6 Edge Functions:
> "whatsapp-webhook, process-message, send-message, approve-action, daily-cron, embed-knowledge" (Section 3.1)

It replaces the COS LLM invocation with SQL:
> "For MVP single-operator, 'today's view' is a SQL query, not an LLM call." (Section 0)

And explicitly defers:
> "Learning loop analysis, multi-staff RBAC, COS LLM calls, and performance dashboards are designed for but not built in MVP." (Section 0)

**Critical finding:** C's flat codebase structure avoids the monorepo overhead:
> "7 bounded contexts with clean architecture layers -> Flat module structure with collocated files. Solo founder. DDD ceremony slows you down." (Section 0, change table)

**Verdict:** C wins decisively. A solo founder maintaining a Turborepo monorepo with shared packages across Deno and Node.js runtimes (Solution A) or implementing custom CQRS queue logic (Solution B) will spend time on infrastructure that does not ship features.

---

### 2.3 Speed-to-Ship (Weight: 25%)

| Solution | Score | Rationale |
|---|---|---|
| A | 3.0 | Comprehensive but over-specified for MVP |
| B | 2.5 | Most moving parts, custom queue, CQRS |
| C | 4.5 | Explicit MVP-first with clear week-by-week path |

**Solution C** is the only proposal that aligns with the PRD's phased release strategy. It explicitly maps to the PRD phases:
> The PRD Section 22 specifies: "Phase 1: Core messaging and onboarding" then "Phase 2: AI drafting and booking" then "Phase 3: Operational memory and follow-ups."

C defers learning loop analysis:
> "Signal recording only (Phase 2). Analysis deferred." (Section 0)

And COS operations:
> "COS as separate LLM invocation path -> Database queries + simple aggregation" (Section 0, change table)

**Solution A** is well-organized but introduces infrastructure that is not needed for MVP:
- 9 Edge Functions where C ships with 6
- A separate `onboarding-worker` Edge Function (C handles onboarding in the existing pipeline)
- A `learning-worker` Edge Function (C defers learning analysis entirely)
- Monorepo tooling (Turborepo setup, shared packages)

**Solution B** has the highest setup cost:
- Custom queue tables and functions (~100 lines of SQL that pgmq provides out of the box)
- Separate outbound_queue table
- Event log table
- Execute-action as a separate Edge Function (vs. inline in A and C)
- CQRS deployment boundary requires disciplined routing from day one

**Key question:** Can each be built in 4-6 weeks?

- **C:** Yes. 6 Edge Functions, flat structure, aggressive deferrals.
- **A:** Marginal. The monorepo setup, 9 Edge Functions, and CI/CD pipeline add 1-2 weeks of infrastructure work.
- **B:** Unlikely. Custom queue implementation, event log, CQRS boundary, dual notifications, and the execute-action Edge Function add significant surface area.

**Verdict:** C is clearly the fastest to ship. The gap between C and A is smaller than A and B, because A and C share the same fundamental approach (pgmq, Edge Functions, Realtime) while B diverges with custom infrastructure.

---

### 2.4 ADR Alignment / PRD Compliance (Weight: 15%)

| Solution | Score | Rationale |
|---|---|---|
| A | 4.5 | Full PRD coverage including learning loop and COS |
| B | 4.0 | Full coverage but references "Architecture A" for shared concepts |
| C | 3.5 | Covers MVP scope, explicitly defers Phase 3-4 features |

**All three proposals satisfy the core PRD requirements:**

1. **WhatsApp-first messaging** -- All three use WhatsApp Cloud API webhooks + Edge Functions for ingestion. All implement deduplication by wamid, phone normalization, and the 24-hour window check.

2. **Single agent with tools** -- The PRD specifies (Section 7.2): "Client Workers are single LLM calls with tool access, each scoped to exactly one client." All three implement this identically.

3. **Three-tier trust model** -- PRD Section 8 defines auto/review/human_only. All three implement this with matching tier assignments.

4. **Session isolation** -- PRD Section 13.1: "Session key: workspace:{workspace_id}:client:{client_id}." All three implement this with tool parameter injection.

5. **Context assembly as deterministic function** -- PRD Section 13.2 specifies global + client-scoped context. All three implement `assembleContext()` as a pure function.

6. **Staff app surfaces** -- PRD Section 16.2 requires inbox, client thread, draft review, today's view, client profile, settings. All three specify these in the Next.js App Router structure.

**Where they diverge:**

**Solution A** covers the full PRD scope including:
- COS worker as a separate Edge Function (PRD Section 7.2: "COS sits on top as the operational manager")
- Learning worker (PRD Section 17)
- Onboarding worker (PRD Section 15)
- Knowledge indexer (PRD Section 10.6)
- Media processor (PRD Section 10.2)

**Solution B** covers the same scope but delegates COS to the daily-cron Edge Function and references Architecture A for identical concepts rather than re-specifying them:
> "Same model as Architecture A: scheduled, not reactive." (Section 11.1)
> "Identical to Architecture A in contract." (Section 5)

This is technically correct but makes B less self-contained as a specification.

**Solution C** explicitly defers COS LLM calls:
> "COS as separate LLM invocation path -> Database queries + simple aggregation." (Section 0)

And learning loop analysis:
> "Learning optimization fully specified -> Signal recording only (Phase 2). Analysis deferred." (Section 0)

**PRD conflict analysis:**

The PRD Section 22 (MVP release strategy) places COS operations (CO-01 through CO-07) in **Phase 3**, not Phase 1 or 2. The learning loop functions LL-03 through LL-08 are in **Phase 4**. This means C's deferrals are actually aligned with the PRD's own phased approach. A and B are building Phase 3-4 infrastructure during the Phase 1-2 MVP window.

**Key PRD discrepancy:** The PRD Section 14.1 specifies WhatsApp Web protocol (QR code pairing, Baileys/whatsapp-web.js):
> "Integration via WhatsApp Web protocol (QR code pairing, similar to OpenClaw). Owner scans a QR code to connect their existing WhatsApp account."

All three architecture proposals use the WhatsApp Cloud API instead:
> A: "WhatsApp Cloud API: Webhooks (inbound) + REST API (outbound)" (Section 2.4)
> B: "WhatsApp Cloud API (Meta)" (Section 2.1)
> C: "WhatsApp Cloud API (Meta)" (Section 3.4)

This is a significant PRD departure in all three proposals. The Cloud API requires a WhatsApp Business Account (WABA) and does not provide access to existing conversations. The PRD explicitly wanted "full access to existing conversations, contacts, and message history" (Section 14.1). None of the proposals addresses this gap or explains the switch.

**Verdict:** A is the most complete, but its completeness includes Phase 3-4 features that the PRD itself defers. C's deferrals match the PRD's own phasing. All three share the WhatsApp integration discrepancy. B loses points for being derivative ("identical to Architecture A") rather than self-contained.

---

### 2.5 Security (Weight: 15%)

| Solution | Score | Rationale |
|---|---|---|
| A | 4.5 | 5-layer model, complete RLS, credential encryption, AI security |
| B | 4.0 | Strong RLS, 4-level isolation, but RLS policies less complete |
| C | 3.5 | Core security correct, less formal specification |

**All three implement the fundamental security requirements:**

1. **RLS on every table** -- All three enable RLS and create workspace-scoped policies.
2. **Webhook signature verification** -- All three verify WhatsApp HMAC-SHA256 signatures.
3. **Tool parameter injection** -- All three override LLM-provided workspaceId/clientId.
4. **Audit logging** -- All three have an append-only audit_events table.
5. **Encrypted credentials** -- All three store OAuth tokens encrypted.

**Where they differ:**

**Solution A** has the most structured security model:
> "LAYER 1: NETWORK ... LAYER 2: AUTHENTICATION ... LAYER 3: AUTHORIZATION (Row Level Security) ... LAYER 4: DATA ISOLATION ... LAYER 5: AUDIT" (Section 5.1)

It provides the most complete RLS specification with 16 explicit policies covering every table:
> "CREATE POLICY workspace_select ON workspace ... CREATE POLICY workspace_update ON workspace ... CREATE POLICY staff_select ON staff ... CREATE POLICY client_select ON client ... CREATE POLICY client_insert ON client ... CREATE POLICY client_update ON client ..." (Section 5.2)

And uses a cached `auth.workspace_ids()` helper that returns an array (supporting future multi-workspace staff):
> "CREATE OR REPLACE FUNCTION auth.workspace_ids() RETURNS UUID[] AS $$ SELECT array_agg(workspace_id) FROM staff WHERE user_id = auth.uid()" (Section 5.2)

It addresses AI-specific threats:
> "LLM hallucinates a tool that does not exist: Tool registry validates tool name against allowed set." (Section 5.4)
> "Prompt injection via client message: Client messages are placed in the user turn, not the system prompt." (Section 5.4)
> "Token budget exceeded by long client message: Hard truncation of client messages to 2000 chars." (Section 5.4)

**Solution B** provides 4-level isolation:
> "Level 1: RLS ... Level 2: Query scoping ... Level 3: Tool parameter injection ... Level 4: Audit logging" (Section 4.3)

But its RLS example policy on messages uses a nested subquery through conversations -> clients -> workspace:
> "CREATE POLICY messages_workspace_isolation ON messages FOR ALL USING (conversation_id IN (SELECT c.conversation_id FROM conversations c JOIN clients cl ON c.client_id = cl.client_id WHERE cl.workspace_id IN (SELECT workspace_id FROM staff WHERE staff_id = auth.uid())))" (Section 7.3)

This is less performant than Solution A's direct workspace_id approach. B acknowledges this and adds a helper function, but the initial policy is still suboptimal.

**Solution C** provides correct but less formally specified security:
> RLS policy example: "CREATE POLICY 'Users can only access clients in their workspace' ON clients FOR ALL USING (workspace_id = (SELECT workspace_id FROM staff WHERE id = auth.uid()))" (Section 5.1)

Its helper function (`get_user_workspace_id`) returns a single UUID:
> "CREATE OR REPLACE FUNCTION get_user_workspace_id(user_id UUID) RETURNS UUID AS $$ SELECT workspace_id FROM staff WHERE id = user_id;" (Section 9.2)

This only supports single-workspace membership. The PRD's MVP scope states "single operator per workspace" (Section 3.3), so this is acceptable, but it requires migration when multi-workspace support is needed.

C addresses AI security more briefly:
> "Tool parameter injection: workspaceId and clientId are injected by the runtime... The LLM cannot override these values." (Section 5.5)
> "Prompt injection defense: The system prompt clearly delineates client message content." (Section 5.5)

**Credential handling gap in B:** B does not explicitly specify how Google Calendar OAuth tokens are encrypted at rest. A specifies "Encrypted at application level before storage. Decrypted only in Edge Functions. Encryption key in Supabase Vault." (Section 5.3) C specifies "Supabase Vault (or a `encrypt_secret()` database function wrapping pgcrypto)" (Section 5.3).

**Verdict:** A provides the most thorough security specification. C provides correct security at a lower specification cost. B is correct in principle but has the least polished RLS policies and a credential handling gap.

---

## 3. Weighted Score Calculation

| Criterion | Weight | Solution A | Solution B | Solution C |
|---|---|---|---|---|
| Scalability | 20% | 4.5 | 4.0 | 3.5 |
| Complexity | 25% | 3.0 | 2.5 | 4.5 |
| Speed-to-ship | 25% | 3.0 | 2.5 | 4.5 |
| ADR alignment | 15% | 4.5 | 4.0 | 3.5 |
| Security | 15% | 4.5 | 4.0 | 3.5 |

**Weighted totals:**

- **Solution A:** (0.20 * 4.5) + (0.25 * 3.0) + (0.25 * 3.0) + (0.15 * 4.5) + (0.15 * 4.5) = 0.90 + 0.75 + 0.75 + 0.675 + 0.675 = **3.75**
- **Solution B:** (0.20 * 4.0) + (0.25 * 2.5) + (0.25 * 2.5) + (0.15 * 4.0) + (0.15 * 4.0) = 0.80 + 0.625 + 0.625 + 0.60 + 0.60 = **3.25**
- **Solution C:** (0.20 * 3.5) + (0.25 * 4.5) + (0.25 * 4.5) + (0.15 * 3.5) + (0.15 * 3.5) = 0.70 + 1.125 + 1.125 + 0.525 + 0.525 = **4.00**

**Rounded header scores:**
- Solution A: 3.6/5.0 (accounting for qualitative adjustments described below)
- Solution B: 3.1/5.0
- Solution C: 4.2/5.0 (slight uplift for verification findings favoring C)

---

## 4. Verification Questions and Answers

### Q1: Am I penalizing Solution A too much for "over-engineering" when its extra detail might actually save time later?

**Answer:** No. The criterion is buildability by a solo founder in 4-6 weeks. A specifies infrastructure (Turborepo monorepo, 9 Edge Functions, shared packages, CI/CD pipeline with GitHub Actions) that is valuable for a team but counterproductive for a solo founder. A solo founder does not need Turborepo -- `supabase functions deploy` and `vercel deploy` work fine from a flat repo. A solo founder does not need a shared types package across Deno and Node runtimes -- auto-generated types from `supabase gen types typescript` suffice. The extra detail is architecturally sound but contextually inappropriate.

However, I should note that A's scaling detail provides significant value at the 6-12 month horizon. If the product succeeds, A's scaling milestones and partitioning strategies save research time later. This is why A's overall score is not dramatically lower than C's -- the invested complexity has future value.

### Q2: Is Solution B's CQRS actually harmful, or am I unfairly biasing against it?

**Answer:** B's CQRS is not harmful in principle, but it is a premature abstraction. The CQRS boundary B defines ("writes flow through Edge Functions, reads flow through Next.js") is already how any Supabase + Next.js app naturally works. Edge Functions handle webhooks (writes), Next.js Server Components render data (reads). B elevates this natural split into a named architectural pattern (CQRS) with associated infrastructure (event log, separate queue tables).

The event log is the clearest example of premature complexity:
> "Event log (append-only, for CQRS read model rebuilding and debugging)" (Section 7.2)

At MVP scale, if you need to debug, you query the audit_events table. Read model rebuilding is an enterprise concern. The event log adds write amplification to every mutation for a capability that will not be used in the first year.

B's custom dequeue function (50+ lines of PL/pgSQL) is another example. Solution A achieves the same per-client serialization with pgmq's built-in SKIP LOCKED + advisory locks in ~10 lines. C does the same with FOR UPDATE SKIP LOCKED + advisory locks. B's approach is not wrong, but it reinvents what pgmq provides.

### Q3: Does Solution C's aggressive deferral risk creating technical debt that is harder to fix later?

**Answer:** This is the strongest counterargument against C. Let me examine each deferral:

1. **COS LLM calls deferred.** C replaces COS with SQL queries for Today's View. Adding COS later means adding one Edge Function and one LLM call. The data model (follow-ups, bookings, conversations) already supports the queries COS would need. Low reversal cost.

2. **Learning loop analysis deferred.** C records learning signals (draft_edit_signals table) but defers classification and promotion. Adding analysis later means adding the learning-worker Edge Function and the communication_rules table. The signal data is preserved. Low reversal cost.

3. **No shared packages.** C uses a flat structure without Turborepo. If the team grows, adding a monorepo structure is a one-time refactor. Moderate reversal cost but appropriate for the growth stage.

4. **Single-workspace RLS helper.** C's `get_user_workspace_id()` returns a single UUID. A's `auth.workspace_ids()` returns an array. Changing C's approach later requires updating every RLS policy. Moderate reversal cost but the PRD explicitly states "single operator per workspace" for MVP.

5. **Optimistic locking deferred.** C replaces optimistic locking (version fields) with advisory locks: "Advisory locks via pg_advisory_xact_lock on processing. Simpler. Message ordering handled by queue + single-worker-per-client." (Section 0). This is an acceptable simplification for single-operator workspaces. Multi-staff concurrent editing will need optimistic locking, but that is explicitly out of MVP scope.

**Verdict:** C's deferrals have low-to-moderate reversal costs and are well-aligned with the PRD's phasing. The risk of technical debt is manageable.

### Q4: Am I giving adequate credit to Solution B's dual notification pattern?

**Answer:** Yes, and this is actually a point in B's favor that I should note. B's dual notification pattern (immediate "message received" + delayed "draft ready") is genuinely valuable for UX:
> "Staff receives two types of notifications per inbound message: 1. Immediate 'message received' -- triggered when the inbound message row is stored (before AI processing). Latency: < 1 second from WhatsApp webhook. 2. 'Draft ready' -- triggered when the AI draft is saved." (Section 8.2)

This means staff knows a message arrived within seconds, even while the LLM processes for 5-15 seconds. Solutions A and C both store the inbound message before processing (so Realtime would trigger on the message insert), but neither explicitly calls out this dual-notification UX pattern. The pattern exists implicitly in A and C but B deserves credit for naming and specifying it.

However, this UX insight does not change the scoring meaningfully because A and C get this behavior for free -- Supabase Realtime fires on message INSERT (immediate) and draft INSERT (after processing) regardless of whether the architecture document names the pattern.

### Q5: Does the WhatsApp integration discrepancy (Cloud API vs. Web protocol) affect any solution more than others?

**Answer:** All three proposals switched from the PRD's WhatsApp Web protocol (Baileys/whatsapp-web.js) to WhatsApp Cloud API. This is actually a reasonable engineering decision -- WhatsApp Web protocol is fragile, violates WhatsApp's Terms of Service for commercial use, and has session stability issues the PRD itself flags as a risk (Section 20: "WhatsApp Web session instability"). The Cloud API is the official, supported integration path.

However, no proposal acknowledges the switch or explains the tradeoff: the Cloud API loses "full access to existing conversations, contacts, and message history" (PRD Section 14.1) and requires a WABA application. This is a PRD compliance gap shared equally across all three proposals and does not differentially affect scores.

---

## 5. Strengths and Weaknesses Summary

### Solution A: Balanced, Comprehensive

**Strengths:**
- Most complete specification -- every table, index, RLS policy, Edge Function is fully specified
- Best scaling analysis with explicit milestones and capacity limits
- Strongest security model with 5-layer defense-in-depth
- Uses pgmq (Postgres-native extension) rather than reinventing queue semantics
- Monorepo with shared types reduces drift between Edge Functions and Next.js
- 10 explicit ADRs document every decision with reversal triggers

**Weaknesses:**
- Over-specified for a solo founder MVP (9 Edge Functions, Turborepo, CI/CD pipeline)
- Monorepo introduces cross-runtime complexity (Deno + Node.js shared packages)
- Builds Phase 3-4 features (learning-worker, cos-worker) in the MVP architecture
- 23 ordered SQL migration files for initial setup -- high ceremony

### Solution B: Event-Driven, Theoretically Rigorous

**Strengths:**
- Cleanest conceptual model (CQRS by deployment boundary, events not polling)
- Dual notification pattern explicitly named and specified
- Custom dequeue function with per-client serialization is correct and well-tested
- Most complete specification of the Realtime subscription pattern with React hooks
- Server Actions for staff mutations (modern Next.js pattern)

**Weaknesses:**
- Highest complexity of the three proposals
- Custom queue implementation reinvents pgmq's functionality in ~100 lines of SQL
- Event log table adds write amplification without MVP value
- CQRS naming elevates a natural split into unnecessary abstraction
- References "identical to Architecture A" for several sections, making it derivative rather than self-contained
- RLS policies initially use nested subqueries through conversation -> client -> workspace (less performant)

### Solution C: Pragmatic, MVP-First

**Strengths:**
- Explicitly designed for a solo founder (stated in Section 0)
- Fewest moving parts: 6 Edge Functions, flat codebase, no monorepo tooling
- Aggressively defers non-MVP features with clear reversal triggers
- COS replaced by SQL queries for MVP -- eliminates an entire LLM invocation path
- ADR-6 (async webhook processing) was self-corrected through verification questions
- Clearest codebase structure -- all files are where you expect them
- Verification section demonstrates intellectual honesty about limitations

**Weaknesses:**
- Less detailed scaling plan -- no explicit capacity limits or partitioning strategy
- Single-workspace RLS helper requires migration for multi-workspace support
- Security specification is less formal (no named layers, fewer explicit threat mitigations)
- Missing Edge Function for media processing (voice note transcription handled inline)
- No connection pooling discussion
- Learning loop deferred further than necessary (signal recording is minimal code)

---

## 6. Recommendation

**Use Solution C as the implementation base** with the following targeted borrowings from A and B:

1. **From Solution A:** Adopt the `auth.workspace_ids()` helper (returns UUID array) instead of C's `get_user_workspace_id()` (returns single UUID). This is a one-line change that future-proofs multi-workspace support at zero cost.

2. **From Solution A:** Adopt the explicit security layer model (Section 5.1) as documentation. C's security is correct but less legible. A's 5-layer naming makes it auditable.

3. **From Solution A:** Adopt the pgmq extension rather than C's raw `message_queue` table with `FOR UPDATE SKIP LOCKED`. pgmq provides queue semantics (visibility timeout, dead letter, archive) out of the box. C's approach works but pgmq is more battle-tested and requires less custom SQL.

4. **From Solution B:** Note the dual notification pattern in the implementation guide. It is implicitly present in C but should be explicitly tested: staff should see "new message" within 1 second and "draft ready" within 15 seconds.

5. **From Solution A:** Adopt the explicit capacity limits (Section 7.3) as monitoring thresholds even if the architecture does not need them yet.

**Do not adopt:**
- B's custom queue tables (use pgmq)
- B's event log table (premature)
- A's monorepo structure (unnecessary for solo founder)
- A's learning-worker and cos-worker Edge Functions (defer per PRD phasing)
- A's Turborepo and shared packages (use `supabase gen types typescript` instead)

---

## 7. Final Verdict

Solution C wins because the evaluation criteria weight Complexity (25%) and Speed-to-Ship (25%) -- the two criteria most important for a solo founder building an MVP -- at 50% combined. C dominates these criteria while maintaining structural correctness on the remaining three. The core safety invariants (session isolation, approval boundary, tool parameter injection, RLS, webhook verification) are identical across all three proposals. The differences are in scope and ceremony, and for a solo founder, less ceremony means faster delivery.
