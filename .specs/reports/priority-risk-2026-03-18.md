# Technical Risk Prioritization — Agent B (De-risk First)

**Date:** 2026-03-18
**Lens:** Technical Risk — features with the highest risk should be built FIRST to surface problems early.
**Source documents:** Feature List v1.1, Architecture Specification v1.2, Phase 3 CLAUDE.md

---

## 1. Risk Assessment Table

Each feature is scored 1-5 per dimension (5 = highest risk). **Composite** is a weighted sum: External API (25%) + Integration Complexity (20%) + LLM Reliability (20%) + Data Integrity (15%) + Novelty (20%).

| # | Feature | External API | Integration | LLM Reliability | Data Integrity | Novelty | Composite | Rank |
|---|---------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| F-01 | Workspace Onboarding & Business Setup | 5 | 4 | 4 | 3 | 5 | **4.30** | 1 |
| F-02 | WhatsApp Message Pipeline | 5 | 5 | 1 | 4 | 5 | **4.15** | 2 |
| F-05 | Context Assembly & AI Draft Generation | 3 | 4 | 5 | 3 | 4 | **3.85** | 3 |
| F-07 | Booking & Scheduling | 5 | 4 | 3 | 4 | 3 | **3.85** | 4 |
| F-11 | Daily Memory Compaction | 2 | 3 | 4 | 5 | 4 | **3.50** | 5 |
| F-12 | COS Daily Operations & Today's View | 3 | 5 | 4 | 2 | 3 | **3.45** | 6 |
| F-15 | Learning Loop & Communication Rules | 2 | 3 | 5 | 4 | 4 | **3.55** | 7 |
| F-08 | Media Processing | 4 | 3 | 3 | 2 | 3 | **3.10** | 8 |
| F-13 | Intelligent Note Processing & Promise Tracking | 2 | 3 | 4 | 3 | 3 | **3.00** | 9 |
| F-06 | Approval Workflow & Governance | 1 | 4 | 2 | 3 | 3 | **2.60** | 10 |
| F-09 | Notes, Follow-ups & Knowledge Management | 2 | 3 | 1 | 4 | 2 | **2.35** | 11 |
| F-03 | Client Identity & Profile | 1 | 2 | 1 | 3 | 2 | **1.75** | 12 |
| F-04 | Staff Notifications & Audit Foundation | 1 | 2 | 1 | 2 | 2 | **1.60** | 13 |
| F-10 | Learning Signal Capture | 1 | 1 | 1 | 2 | 1 | **1.15** | 14 |
| F-14 | Draft Acceptance Metrics | 1 | 1 | 1 | 1 | 1 | **1.00** | 15 |

---

## 2. Risk Dimension Rationale

### External API (weight: 25%)
Dependency on third-party APIs that are outside our control: Baileys (unofficial WhatsApp Web protocol), Google Calendar OAuth, Instagram scraping, LLM provider APIs (Anthropic/OpenAI), Whisper transcription.

### Integration Complexity (weight: 20%)
Multi-service coordination across the three deployment targets (Railway + Supabase + Vercel). Features that require pgmq, pg_net, pg_cron, Supabase Realtime, and Edge Functions to work in concert score high.

### LLM Reliability (weight: 20%)
Prompt engineering difficulty, confidence scoring accuracy, tool-calling reliability, output quality variance, and cost predictability.

### Data Integrity (weight: 15%)
Risk of data corruption, loss, or inconsistency. Includes concurrency issues (advisory locks), compaction correctness (flush-before-compact), client merge safety, and queue processing guarantees.

### Novelty (weight: 20%)
Patterns that are unproven in the team's stack or have limited community precedent: pgmq as a production queue, Baileys for persistent WhatsApp Web sessions, advisory locks for per-client serialization, QR-code session pairing.

---

## 3. Ranked Priority Stack (De-risk Order)

### Tier 1: De-risk Immediately (Sprint 1)

| Rank | Feature | Composite | Rationale |
|---:|---------|:---:|-----------|
| 1 | **F-01: Workspace Onboarding & Business Setup** | 4.30 | Stacks EVERY novel and external risk: Baileys QR pairing, Instagram scraping, LLM-generated SOPs, tone profile extraction, deep research for vertical config. If any of these fail, the entire product cannot onboard its first user. Must validate the full chain end-to-end before anything else. |
| 2 | **F-02: WhatsApp Message Pipeline** | 4.15 | The foundational prerequisite for 11 other features. Relies on Baileys (unofficial protocol, may break), pgmq (novel queue), pg_net (async trigger), advisory locks (per-client serialization), and Supabase Realtime (dual notification). If this pipeline is unreliable, everything downstream is blocked. |
| 3 | **F-05: Context Assembly & AI Draft Generation** | 3.85 | The core AI feature. Highest LLM reliability risk: prompt engineering for multi-tool calling, confidence scoring calibration, knowledge retrieval quality (pgvector), token budget management, and the tool execution loop. Every AI feature downstream (F-06, F-07, F-08, F-11, F-12, F-13, F-15) depends on the Client Worker being reliable. |

### Tier 2: De-risk Next (Sprint 2)

| Rank | Feature | Composite | Rationale |
|---:|---------|:---:|-----------|
| 4 | **F-07: Booking & Scheduling** | 3.85 | Google Calendar OAuth is a second external API dependency. Slot matching, conflict detection, and prerequisite validation add integration complexity. Booking errors have direct business impact (double-bookings, missed appointments). |
| 5 | **F-11: Daily Memory Compaction** | 3.50 | Highest data integrity risk. The flush-before-compact invariant is critical: if async extractions are not complete before compaction runs, data is permanently lost from the compact summary. Versioned memory writes and cron timing (per-workspace timezone) add complexity. LLM summarization quality directly affects all future context assembly. |
| 6 | **F-12: COS Daily Operations & Today's View** | 3.45 | Highest integration complexity: orchestrates across follow-ups, bookings, conversations, and the Client Worker. Requires cross-client queries, LLM-ranked urgency, and dispatching multiple Client Worker invocations. Heavy reliance on daily-cron Edge Function staying within the 150s timeout. |
| 7 | **F-15: Learning Loop & Communication Rules** | 3.55 | Highest combined LLM + novelty risk. Edit classification requires stable pattern keys across diverse edit types. Promotion threshold logic (3+ occurrences, 2+ clients, 30-day window) is novel. Injecting learned rules into context assembly creates a feedback loop that could degrade draft quality if rules are bad. |

### Tier 3: Moderate Risk (Sprint 3)

| Rank | Feature | Composite | Rationale |
|---:|---------|:---:|-----------|
| 8 | **F-08: Media Processing** | 3.10 | External dependency on Whisper API for voice transcription. Multimodal LLM image handling is newer and less predictable. Media download and storage pipeline adds integration surface. |
| 9 | **F-13: Intelligent Note Processing & Promise Tracking** | 3.00 | Async LLM categorization of unstructured notes is inherently unreliable. Promise extraction from conversation history requires nuanced NLP. Confirmation card generation for "implied" data updates could confuse staff if accuracy is low. |
| 10 | **F-06: Approval Workflow & Governance** | 2.60 | Moderate integration complexity: three-tier trust model, confirmation card lifecycle, and tool parameter injection. But the patterns are well-understood (deterministic code, not LLM). Risk is in getting the tier classification right for edge cases. |

### Tier 4: Low Risk (Sprint 4+)

| Rank | Feature | Composite | Rationale |
|---:|---------|:---:|-----------|
| 11 | **F-09: Notes, Follow-ups & Knowledge Management** | 2.35 | Mostly CRUD with some data integrity risk around client merge (soft-delete + record transfer). Knowledge embedding pipeline reuses the embed-knowledge Edge Function. |
| 12 | **F-03: Client Identity & Profile** | 1.75 | Standard find-or-create by phone number. E.164 normalization is a solved problem. Low external dependency. |
| 13 | **F-04: Staff Notifications & Audit Foundation** | 1.60 | Supabase Realtime for notifications is well-documented. Audit logging is append-only INSERTs. No LLM, no external API. |
| 14 | **F-10: Learning Signal Capture** | 1.15 | Pure database write at send time. No LLM, no external API, no concurrency issues. Structurally simple. |
| 15 | **F-14: Draft Acceptance Metrics** | 1.00 | SQL aggregation over existing data. Lowest risk feature in the entire stack. No LLM, no external API, no novelty. |

---

## 4. Sprint 1 Recommendation

**Goal:** Validate the three highest-risk integrations end-to-end in a single vertical slice.

### Sprint 1 scope: F-02 + F-01 (core path) + F-05 (core path)

Build a thin vertical slice that exercises the full risk chain:

1. **Baileys QR pairing + persistent session** (F-01 / F-02) — Can we reliably connect, maintain, and reconnect a WhatsApp Web session? This is the single biggest existential risk. Baileys is an unofficial protocol that Meta could break at any time. Validate: QR scan works, messages flow in, session survives a Railway restart.

2. **pgmq inbound pipeline** (F-02) — Does pgmq + pg_net + advisory locks actually provide reliable ordered processing? Validate: messages enqueue, dequeue, retry on failure, and archive correctly. Advisory lock prevents duplicate processing.

3. **Context assembly + Client Worker** (F-05) — Can the LLM reliably classify intent, call tools, and produce usable drafts within the Edge Function timeout? Validate: end-to-end from inbound WhatsApp message to draft appearing in the staff app via Realtime.

**What to defer from F-01:** Instagram scraping, deep research SOP generation, tone profile extraction. These can be stubbed with manual input for Sprint 1. The QR pairing and session persistence are the critical path.

**What to defer from F-05:** Knowledge semantic search (stub with empty results), communication rules injection (empty initially). Focus on the core LLM call + tool loop + approval boundary.

**Sprint 1 exit criteria:**
- A staff member can scan a QR code on Railway and see their WhatsApp messages appear in the Next.js app within 2 seconds
- An inbound message produces an AI draft within 30 seconds
- The Baileys session survives a Railway container restart
- pgmq correctly retries a failed message processing attempt
- Advisory locks prevent duplicate processing of the same client's messages

---

## 5. Top 3 Riskiest Features — Detailed Analysis

### Risk #1: F-01 — Workspace Onboarding & Business Setup (Composite: 4.30)

**Why this is the riskiest feature in the system:**

This feature is a convergence point for nearly every novel and external dependency in the architecture. A failure here means the product cannot onboard a single user.

| Risk Dimension | Score | Detail |
|:---|:---:|:---|
| External API | 5/5 | **Baileys QR pairing** is the primary risk. The `@whiskeysockets/baileys` library uses an unofficial reverse-engineered WhatsApp Web protocol. Meta actively patches against unofficial clients. QR pairing requires a persistent WebSocket on Railway, and session credentials must be stored in Supabase and restored on restart. **Instagram scraping** is the secondary risk: scraping Instagram for business knowledge relies on undocumented endpoints or browser automation, both of which are fragile. |
| Integration | 4/5 | This feature spans all three deployment targets: Railway (Baileys), Supabase (Edge Functions for SOP generation, DB for workspace + knowledge storage), and Vercel (onboarding wizard UI). QR code streaming from Railway to the Next.js app requires SSE or WebSocket bridging. |
| LLM Reliability | 4/5 | LLM generates vertical-specific SOPs, appointment types, custom fields, and tone profiles from scraped data. This is open-ended generation with high variance. The prompts must produce structured, actionable output (not just prose) that the system can parse into `vertical_config` JSONB. Getting this wrong means every workspace starts with bad defaults. |
| Data Integrity | 3/5 | Conversation history import on first connection could be large and must not duplicate messages if the process is interrupted and restarted. Knowledge base embedding of scraped content must handle partial failures gracefully. |
| Novelty | 5/5 | No team precedent for: Baileys session management, QR code pairing flow, Instagram scraping pipeline, LLM-driven SOP generation, or conversational refinement of AI-generated configuration. Every sub-component is being built for the first time. |

**Mitigation strategy:**
- Prototype Baileys QR pairing in isolation FIRST (1-2 days). Validate session persistence across restarts before building anything else.
- Stub Instagram scraping with manual knowledge input for MVP. Add scraping as an enhancement once the core flow works.
- Use a rigid JSON schema for SOP generation prompts with Zod validation on the LLM output. Reject and retry if the output does not parse.
- Implement conversation history import as an idempotent batch job (deduplicate by wamid).

**Fallback:** If Baileys proves unsustainable, the architecture documents Cloud API as the fallback. This eliminates QR pairing (uses WABA registration instead) and conversation history import (Cloud API has no history access), but the rest of the system remains intact.

---

### Risk #2: F-02 — WhatsApp Message Pipeline (Composite: 4.15)

**Why this is the second riskiest feature:**

This is the foundational pipeline that 11 of the remaining 13 features depend on. It introduces three novel infrastructure patterns simultaneously: pgmq as a production message queue, advisory locks for per-client serialization, and pg_net for async Edge Function triggering.

| Risk Dimension | Score | Detail |
|:---|:---:|:---|
| External API | 5/5 | **Baileys WebSocket** must maintain a persistent connection to WhatsApp. Disconnections, rate limiting by Meta, and protocol changes are all possible. Delivery status tracking depends on Baileys event listeners that may not fire reliably. The Baileys server on Railway is the ONLY persistent server in the stack, making it a single point of failure for all messaging. |
| Integration | 5/5 | This feature requires all three deployment targets working in concert: Railway (Baileys receives message) -> Supabase DB (INSERT to messages + pgmq enqueue) -> pg_net (async HTTP call to Edge Function) -> Edge Function (dequeue from pgmq) -> Supabase Realtime (push to staff app on Vercel). A failure at ANY point in this chain breaks the pipeline. The pg_cron safety net adds another layer that must be configured correctly. |
| LLM Reliability | 1/5 | No LLM involvement in the pipeline itself. |
| Data Integrity | 4/5 | Message deduplication (wamid-based), ordering guarantees (advisory locks), retry semantics (pgmq visibility timeout), and dead letter queue handling all carry data integrity risk. If advisory locks fail silently, two workers could process the same client's messages concurrently, producing duplicate drafts or race conditions on conversation state. |
| Novelty | 5/5 | **pgmq** has limited production precedent compared to Redis/BullMQ. The team has no prior experience with it. **Advisory locks** (`pg_try_advisory_lock`) for per-client serialization is a correct but uncommon pattern that is easy to misuse (forgetting to release, wrong lock granularity). **pg_net** for async Edge Function triggering is a Supabase-specific pattern with sparse documentation. |

**Mitigation strategy:**
- Build a load test harness that sends 100+ messages in rapid succession to a single workspace. Verify: no duplicates, correct ordering, advisory lock contention resolves cleanly, pgmq depth stays near zero.
- Implement the pg_cron safety net from day one. Do NOT rely solely on pg_net for triggering; pg_net failures should be expected, not exceptional.
- Add a monitoring query (pg_cron job) that alerts when pgmq depth > 10 or oldest message age > 2 minutes.
- Test Baileys reconnection by killing the Railway container mid-message-flow and verifying that: (a) the session restores, (b) no messages are lost, (c) pgmq retries any in-flight messages.

---

### Risk #3: F-05 — Context Assembly & AI Draft Generation (Composite: 3.85)

**Why this is the third riskiest feature:**

This is the central AI feature of the entire product. Every downstream AI capability (governance, booking, media, compaction, COS, learning loop) depends on the Client Worker being reliable. The risk is not in any single component but in the orchestration of many components into a single LLM call that must complete within the Edge Function timeout.

| Risk Dimension | Score | Detail |
|:---|:---:|:---|
| External API | 3/5 | LLM provider API (Claude/OpenAI) is the dependency. API rate limits, latency spikes, and outages are risks. The direct SDK approach (no abstraction layer) means switching providers is a code change, not a config change. |
| Integration | 4/5 | Context assembly requires 10+ database queries (workspace config, vertical config, communication rules, knowledge search, client profile, compact summary, recent messages, bookings, follow-ups, notes). These must all complete before the LLM call. The tool execution loop then makes additional database writes (via ProposedAction). The entire pipeline must fit within the 150s Edge Function timeout (Pro tier) or 60s (free tier). |
| LLM Reliability | 5/5 | **This is the highest LLM risk in the system.** The Client Worker must: (a) correctly classify intent from a short WhatsApp message, (b) decide which tools to call and in what order, (c) generate a draft reply that matches the workspace tone profile, (d) produce a meaningful confidence score, (e) attribute knowledge sources, and (f) handle edge cases (unknown intent, out-of-scope requests, abusive messages). Prompt engineering for all of these simultaneously is hard. Tool-calling reliability varies by model and by prompt structure. Confidence scoring is notoriously difficult to calibrate — there is no ground truth until staff feedback accumulates. |
| Data Integrity | 3/5 | Context assembly is read-only (safe). But the tool execution loop writes ProposedActions and potentially auto-executes low-risk actions. If the Edge Function crashes after the LLM call but before archiving the pgmq message, the retry will produce a duplicate LLM call (wasted cost) and potentially duplicate ProposedActions. The idempotency guard (check if draft already exists) mitigates this but must be implemented correctly. |
| Novelty | 4/5 | The "single agent with tools" pattern is well-documented by Anthropic/OpenAI, but the specific orchestration (context assembly -> LLM -> tool loop -> approval eval -> save) with pgvector semantic search and ProposedAction wrapping is custom. The fixed token budget with deterministic truncation rules is also novel and must be tuned empirically. |

**Mitigation strategy:**
- Build an evaluation harness with 50+ test messages spanning common intents (greeting, booking request, question, complaint, follow-up). Measure: intent classification accuracy, tool selection accuracy, draft quality (human-rated), and confidence score calibration.
- Start with a conservative confidence threshold for escalation (e.g., escalate if confidence < 0.7). Adjust down as data accumulates.
- Implement the idempotency guard (draft existence check) before any other logic in the process-message function.
- Profile the full pipeline latency: context assembly queries, LLM call, tool execution. Identify the bottleneck and optimize. Target: < 20s total for a simple intent, < 30s for a booking-related intent with calendar queries.
- Hardcode the token budget initially. Do not make it configurable until you understand the real-world distribution of context sizes.

---

## 6. Risk Dependency Map

```
                    F-02 (Pipeline) ──── RISK: Baileys + pgmq + advisory locks
                    /        |        \
                   /         |         \
             F-01 (Onboard)  F-03      F-04
             RISK: QR +      (low)     (low)
             Instagram +
             LLM SOPs
                   \         |
                    \        |
                     F-05 (AI Drafting) ──── RISK: LLM reliability + tool loop
                    / |  \      \
                   /  |   \      \
             F-06   F-07   F-08   F-10
             (mod)  RISK:  RISK:  (low)
                    GCal   Whisper
                    OAuth  + multi-
                           modal
                      |
                      |
                    F-09 ─── F-11 (Compaction) ──── RISK: data integrity
                              |                      (flush-before-compact)
                              |
                            F-12 (COS) ──── RISK: orchestration complexity
                              |
                            F-13 ──── RISK: LLM note categorization accuracy
                              |
                            F-14 (low)
                              |
                            F-15 (Learning Loop) ──── RISK: LLM classification
                                                       + feedback loop stability
```

The risk compounds along the critical path: F-02 -> F-05 -> F-11 -> F-12. A failure in F-02 cascades to everything. A failure in F-05 blocks all AI features. This is why Sprint 1 must validate these three features (F-02, F-01, F-05) end-to-end before investing in downstream features.

---

## 7. Summary Position

**Build the scariest things first.** The three features that could kill this product are:

1. **Baileys WhatsApp connectivity** (F-01/F-02) — if the unofficial protocol breaks or sessions are unreliable, there is no product.
2. **The AI drafting pipeline** (F-05) — if the LLM cannot reliably draft replies with tools, the product is just a WhatsApp relay.
3. **Daily memory compaction** (F-11) — if compaction corrupts or loses client context, the AI gets progressively worse over time.

Everything else is either standard CRUD (F-03, F-04, F-09, F-10, F-14), well-understood integration (F-06, F-07), or can be deferred until the foundation proves stable (F-12, F-13, F-15).

Sprint 1 should be a thin vertical slice through F-02 + F-01 + F-05 that validates: QR pairing works, messages flow reliably, and the AI can draft a response. If this slice works, the rest is execution. If it does not, you discover it in week 1 instead of week 8.
