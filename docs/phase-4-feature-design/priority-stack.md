# Priority Stack — WhatsApp-First AI Client Ops Manager

**Version:** 1.0
**Date:** 2026-03-18
**Status:** Final (synthesized from three independent priority analyses)

---

## Synthesis Methodology

Three independent analyses were conducted, each applying a different prioritization lens:

- **Agent A (User Value / RICE):** Scored features on Reach, Impact, Confidence, and Effort. Optimizes for maximum user value per unit of engineering time. Favors high-confidence, high-reach features and penalizes XL effort.
- **Agent B (Technical Risk / De-risk First):** Scored features across five risk dimensions (External API, Integration Complexity, LLM Reliability, Data Integrity, Novelty). Prioritizes building the riskiest features first to surface failures early and avoid late-project surprises.
- **Agent C (Strategic Alignment):** Scored features across five strategic dimensions (Core Positioning, Revenue Protection, Time to Value, Competitive Moat, Template Potential). Optimizes for features that most sharply differentiate the product and deliver on its core promise.

**Weighting applied to resolve conflicts:**

1. **Unanimous agreement** (all three agents rank a feature in the same tier) is treated as a strong signal and adopted without modification.
2. **Two-of-three agreement** is adopted unless the dissenting agent raises a structural argument (e.g., dependency ordering, data integrity risk) that would make the majority position unviable.
3. **Three-way disagreement** is resolved by applying a decision rule: *dependency ordering first, then risk, then value*. A feature that is a prerequisite for others cannot be deferred regardless of its standalone score. A feature with existential risk must be validated before features that depend on it. Among features with equal dependency depth and risk, user value determines order.

Sprint sizing targets approximately 2-3 weeks of focused engineering work per sprint.

---

## Final Priority Stack

### Sprint 1: Messaging Foundation (Target: 2 weeks)

**Goal:** Validate the two existential risks (WhatsApp connectivity and message pipeline reliability) and establish the client identity substrate. Exit Sprint 1 with messages flowing end-to-end from WhatsApp to the staff app.

| Priority | Feature | Size | Rationale |
|----------|---------|------|-----------|
| 1 | **F-02: WhatsApp Message Pipeline** | L | All three agents rank this #1 or #2. It is the root of the dependency graph (11 of 13 remaining features depend on it), the second-highest technical risk (Baileys + pgmq + advisory locks are all novel), and scores 9.50 on RICE. Without reliable message flow, there is no product. |
| 2 | **F-03: Client Identity & Profile** | M | Unanimous agreement across all three agents that this is Sprint 1 material. Low technical risk (1.75 composite), high RICE (9.50), and a hard prerequisite for AI drafting -- every draft needs a resolved client entity. Deterministic E.164 matching makes this a high-confidence deliverable. |
| 3 | **F-04: Staff Notifications & Audit Foundation** | M | Agent A and Agent C place this in Sprint 1. Agent B ranks it low-risk (1.60), which actually supports Sprint 1 placement -- it is safe to build early and provides immediate staff value (push notifications on inbound messages). The audit trail is the governance baseline that F-06 builds on. |

**Sprint 1 Total Effort:** L + M + M (approximately 2 weeks)

**Sprint 1 Exit Criteria:**
- Inbound WhatsApp messages are received via Baileys, deduplicated by wamid, and stored in the messages table
- Phone numbers resolve to client records via find-or-create with E.164 normalization
- Staff receives a push notification within 2 seconds of an inbound message
- Audit events are logged for all data mutations (actor, action, before/after state)
- Baileys session survives a Railway container restart without message loss
- pgmq correctly retries a failed message processing attempt
- Advisory locks prevent concurrent processing of the same client's messages

---

### Sprint 2: First AI Draft (Target: 3 weeks)

**Goal:** Deliver the core product experience: an inbound WhatsApp message produces an AI-drafted reply that staff can review, edit, and send. This is the "first value" milestone for pilot clients.

| Priority | Feature | Size | Rationale |
|----------|---------|------|-----------|
| 4 | **F-01: Workspace Onboarding & Business Setup** | XL | Agent B ranks this as the single riskiest feature (4.30 composite). Agent C scores it 4.30 on strategic alignment (the template model requires zero-friction onboarding). Agent A places it Sprint 1-2. The conflict: Agent A defers it from Sprint 1 due to XL size; Agent B wants it Sprint 1 for de-risking. Resolution: Sprint 2 placement with a de-scoped Sprint 1 spike. The QR pairing and session persistence should be validated as part of F-02 in Sprint 1. Sprint 2 builds the full onboarding wizard (Instagram scraping, SOP generation, tone profiling) with known-working connectivity. Instagram scraping and deep research are stubbed with manual fallbacks if they prove unreliable. |
| 5 | **F-05: Context Assembly & AI Draft Generation** | XL | Perfect strategic score (5.00 from Agent C). Highest LLM risk (5/5 from Agent B). RICE of 5.40 despite XL effort (Agent A). All three agents agree this is the product's core value proposition -- the feature that transforms a message relay into an AI copilot. Placed after F-01 because the knowledge base and SOPs from onboarding feed directly into context assembly. However, F-05 development should start in parallel with F-01: context assembly queries can be built against seed data while onboarding is completed. |
| 6 | **F-06: Approval Workflow & Governance** | L | The sharpest disagreement among agents. Agent C ranks it #3 overall (4.45 strategic score, calling it "the feature that makes 'not a chatbot' real"). Agent A ranks it #5 (RICE 5.40). Agent B ranks it #10 (2.60 risk composite, meaning low technical risk). Resolution: Agent C's argument is compelling -- governance is positioning, not overhead. Without F-06, F-05 cannot be safely deployed to pilot clients. The three-tier trust model is what differentiates this product from chatbot competitors. It must ship with F-05 as a paired deliverable. Its low technical risk (deterministic code, not LLM) makes it a reliable Sprint 2 item. |
| 7 | **F-10: Learning Signal Capture** | S | All three agents agree this should ship alongside F-05. Agent A ranks it #8 (RICE 8.10 -- highest score-to-effort ratio). Agent C explicitly states "F-10 must ship with F-05, not after it." Agent B confirms minimal risk (1.15). At S-sized effort, there is no reason to defer. Every draft-edit pair before signal capture is live is a permanently lost learning opportunity. |

**Sprint 2 Total Effort:** XL + XL + L + S (approximately 3 weeks with parallelization: F-01 and F-05 can develop concurrently since F-01 feeds knowledge base while F-05 builds the context assembly pipeline)

**Sprint 2 Exit Criteria:**
- A new workspace can be created via QR code scan with auto-generated knowledge base and SOPs
- An inbound WhatsApp message produces an AI-drafted reply within 30 seconds
- Drafts include knowledge source attribution and confidence scores
- Staff can approve, edit, reject, or regenerate drafts via confirmation cards
- The three-tier trust model correctly routes actions (auto-allowed, suggest-for-review, human-only)
- Learning signals are captured for every staff action on a draft
- The full pipeline (message -> client resolution -> context assembly -> AI draft -> staff review -> send) works end-to-end

---

### Sprint 3: Booking & Operational Depth (Target: 3 weeks)

**Goal:** Add the most tangible revenue-protection feature (booking) and the operational data layer (notes, follow-ups) that powers proactive operations later.

| Priority | Feature | Size | Rationale |
|----------|---------|------|-----------|
| 8 | **F-07: Booking & Scheduling** | XL | Agent A ranks it #6 (RICE 3.84, directly attacks G2 and G5). Agent C ranks it #6 (4.25 strategic score, "the most tangible revenue event"). Agent B ranks it #4 on risk (3.85, Google Calendar OAuth is a second external API dependency). All three agree it belongs in the sprint immediately after core AI drafting. For appointment-based verticals -- which are every target vertical in the PRD -- booking is the revenue moment. |
| 9 | **F-09: Notes, Follow-ups & Knowledge Management** | L | Agent A ranks it #9 (RICE 3.97). Agent C ranks it #9 (3.65 strategic). Agent B ranks it #11 (low risk, 2.35). Strong consensus on mid-priority. Placed here because F-09 is a prerequisite for F-12 (COS needs follow-up records) and F-13 (note processing needs note infrastructure). The follow-up tracking system (due dates, status, overdue detection) is the operational backbone for proactive operations. |
| 10 | **F-08: Media Processing** | M | The most consistent "deprioritize" signal across all three agents. Agent A ranks it #14 (RICE 1.50). Agent C ranks it #14 (2.80 strategic). Agent B ranks it #8 on risk (3.10 -- moderate due to Whisper API dependency). Resolution: despite low priority scores, M-sized effort and Sprint 3 timing make it a reasonable inclusion. Voice notes are 20-30% of WhatsApp messages in some markets. Building media processing here means the AI copilot handles the full message spectrum before pilot expansion. If Sprint 3 is capacity-constrained, this is the first item to defer to Sprint 4. |

**Sprint 3 Total Effort:** XL + L + M (approximately 3 weeks)

**Sprint 3 Exit Criteria:**
- Google Calendar OAuth connects successfully and queries available slots
- The AI proposes 2-4 booking options in draft replies when a client requests an appointment
- Conflict detection prevents double-bookings
- Staff can approve booking drafts via confirmation cards, creating calendar events and booking records
- Staff can save notes, create follow-ups with due dates, and upload documents for knowledge search
- Voice notes are transcribed and included in context assembly (if F-08 is included)

---

### Sprint 4: Proactive Operations (Target: 3 weeks)

**Goal:** Transform the product from reactive (respond to messages) to proactive (surface what staff should do today). This is the "operations manager" milestone.

| Priority | Feature | Size | Rationale |
|----------|---------|------|-----------|
| 11 | **F-11: Daily Memory Compaction** | L | Agent B ranks this #5 on risk (3.50, highest data integrity risk due to flush-before-compact invariant). Agent C ranks it #10 (3.50 strategic). Agent A ranks it #11 (RICE 3.00). The risk-value tension: F-11 has high data integrity risk but is an infrastructure feature with no direct user value. Resolution: Sprint 4 placement gives the team real production data to understand context window sizes before building compaction. F-11 must be operational before F-12 (COS needs compact summaries for cross-client operations). |
| 12 | **F-12: COS Daily Operations & Today's View** | XL | The biggest disagreement across agents. Agent C ranks it #4 overall (4.45 strategic, tied with F-06, calling it "the aha moment feature"). Agent A ranks it #12 (RICE 2.94, penalized by XL effort). Agent B ranks it #6 on risk (3.45, high integration complexity). Resolution: Agent C is right about strategic importance -- COS is the "operations manager" in the product name. But Agent A and Agent B are right about practical constraints: it depends on F-11, F-09, and F-05 all being stable, and it has XL effort with high orchestration complexity. Sprint 4 is the earliest viable placement. The North Star framing is adopted: Sprints 1-3 build toward the COS milestone. |
| 13 | **F-14: Draft Acceptance Metrics** | S | All three agents agree this is low priority. Agent A: #10 (RICE 4.00). Agent B: #15 (1.00 risk -- lowest in the stack). Agent C: #15 (2.30 strategic). S-sized effort makes it trivial to include. Placed in Sprint 4 because it requires accumulated signal data from F-10 (running since Sprint 2) to be meaningful, and it feeds F-15 in Sprint 5. |

**Sprint 4 Total Effort:** L + XL + S (approximately 3 weeks)

**Sprint 4 Exit Criteria:**
- Daily compaction runs per workspace timezone without data loss (flush-before-compact verified)
- Compact summaries accurately preserve client context across conversation boundaries
- COS daily cron identifies stale conversations, unconfirmed bookings, and overdue follow-ups
- Today's View shows staff a prioritized list of clients needing attention
- COS-generated follow-up drafts are contextually appropriate (leverage compact summaries)
- Draft acceptance metrics are visible in workspace settings (acceptance rate, edit rate, discard rate)

---

### Sprint 5: Intelligence & Learning (Target: 3 weeks)

**Goal:** Close the feedback loop. The system learns from staff behavior and gets measurably better over time.

| Priority | Feature | Size | Rationale |
|----------|---------|------|-----------|
| 14 | **F-13: Intelligent Note Processing & Promise Tracking** | L | Agent C ranks it highest (#8, 3.75 strategic, citing promise tracking as "a deep moat feature"). Agent A ranks it #13 (RICE 2.17, 65% confidence). Agent B ranks it #9 (3.00 risk). Resolution: the feature is genuinely novel and strategically differentiating, but Agent A's 65% confidence reflects real uncertainty about extraction accuracy. Sprint 5 placement gives the team 2-3 sprints of production note data to understand real note patterns before building automated categorization. |
| 15 | **F-15: Learning Loop & Communication Rules** | XL | All three agents agree this is last. Agent A: #15 (RICE 0.80). Agent B: #7 on risk (3.55 -- high LLM + novelty risk). Agent C: #11 (3.45 strategic, "long-term moat"). Unanimous that it requires extensive accumulated data (500+ signals per Agent C) and cannot deliver value until the learning signal pipeline has been running for weeks. The feedback loop risk (bad rules degrading draft quality) also demands caution. Sprint 5 is the earliest viable placement, and only if signal data volume is sufficient. |

**Sprint 5 Total Effort:** L + XL (approximately 3 weeks)

**Sprint 5 Exit Criteria:**
- Staff notes are automatically categorized (follow-up extraction, preference updates, promise detection)
- Promise tracking creates follow-up records from conversational commitments with confirmation cards
- The LearningWorker classifies staff edits into stable pattern types
- Patterns meeting promotion threshold (3+ occurrences, 2+ clients, 30-day window) are promoted to CommunicationRules
- Active rules are injected into context assembly and measurably improve draft acceptance rate
- Staff can view, edit, and disable communication rules in Settings

---

## Consensus Analysis

### Features Where All 3 Agents Agreed on Priority Tier

| Feature | Consensus | Notes |
|---------|-----------|-------|
| **F-02: WhatsApp Message Pipeline** | Top 2, Sprint 1 | Universal agreement. Root dependency, high risk, high value. No debate. |
| **F-05: Context Assembly & AI Draft Generation** | Top 3, Sprint 2 | All agents identify this as the core product. Placement after F-02/F-03 is unanimous due to dependency ordering. |
| **F-03: Client Identity & Profile** | Sprint 1 | All agents agree: low risk, high reach, hard prerequisite. |
| **F-10: Learning Signal Capture** | Ship with F-05 | Cheap (S-sized), zero risk, permanently lost data if deferred. All agents agree it pairs with F-05. |
| **F-14: Draft Acceptance Metrics** | Low priority, late sprint | All agents rank it bottom 3-5. Included only because it is S-sized. |
| **F-15: Learning Loop** | Last | Unanimous. Maximum effort, maximum uncertainty, needs months of data. |

### Features Where Agents Disagreed and How Conflicts Were Resolved

| Feature | Agent A (Value) | Agent B (Risk) | Agent C (Strategy) | Resolution |
|---------|----------------|----------------|-------------------|------------|
| **F-06: Governance** | #5 (RICE 5.40) | #10 (low risk, build later) | #3 (4.45, "positioning weapon") | **Adopted Agent C's position.** Agent B's low-risk score actually supports early inclusion -- it is safe to build and ship. Agent C's argument that governance IS the competitive positioning is structurally sound. F-06 is paired with F-05 in Sprint 2. |
| **F-01: Onboarding** | #4 (Sprint 2) | #1 (highest risk, Sprint 1) | #5 (Sprint 1-2) | **Compromised.** Agent B wants Sprint 1 for de-risking; Agent A wants Sprint 2 due to XL size. Resolution: QR pairing risk is validated within F-02 (Sprint 1). Full onboarding wizard ships Sprint 2 with Instagram scraping stubbed if needed. |
| **F-12: COS Daily Ops** | #12 (RICE 2.94) | #6 (risk 3.45) | #4 (4.45, "aha moment") | **Agent C's strategic framing adopted, Agent A's timeline accepted.** COS is the North Star but cannot ship before Sprint 4 due to dependencies on F-11, F-09, and F-05. It is the goal Sprints 1-3 build toward, not a Sprint 1-2 deliverable. |
| **F-04: Notifications** | #7 (Sprint 1) | #13 (low risk, defer) | #12 (3.25, "table stakes") | **Adopted Agent A's position.** Agent B's low risk score means it is safe for Sprint 1. Agent A correctly identifies it as a Sprint 1 deliverable: staff must know a message arrived. The audit trail is the governance foundation. |
| **F-11: Compaction** | #11 (Sprint 5-6) | #5 (risk 3.50, Sprint 2) | #10 (Sprint 3) | **Placed Sprint 4.** Agent B's risk concern is valid (flush-before-compact is a data integrity hazard), but building it before there is real production data to compact is premature. Sprint 4 gives the team 2 sprints of production context size data. It must precede F-12. |
| **F-08: Media Processing** | #14 (RICE 1.50) | #8 (risk 3.10) | #14 (2.80) | **Placed Sprint 3 as a stretch goal.** All three agents agree it is low priority. M-sized effort and Sprint 3 timing make it a reasonable inclusion, but it is the first item cut if Sprint 3 is capacity-constrained. |

### Key Trade-offs Made

1. **Risk de-scoping vs. sprint overload:** Agent B's recommendation to build F-01 + F-02 + F-05 as a thin vertical slice in Sprint 1 was rejected. Three features totaling XL + L + XL in a single sprint is unrealistic for a 2-week target. Instead, Sprint 1 validates the highest-risk infrastructure (Baileys, pgmq) within F-02, and Sprint 2 adds the AI layer. The de-risking is staged, not crammed.

2. **Governance timing:** Shipping F-06 in Sprint 2 alongside F-05 adds scope to an already heavy sprint. The trade-off is accepted because deploying AI drafting without governance to pilot clients is a positioning risk that outweighs the schedule risk. F-06 is L-sized (not XL) and uses deterministic code (not LLM), making it a reliable Sprint 2 deliverable.

3. **COS as North Star vs. COS as deliverable:** Agent C's strong argument for F-12's strategic importance is adopted as framing -- Sprints 1-3 are explicitly building toward the COS milestone. But F-12 itself ships in Sprint 4 because its dependency chain (F-05 + F-09 + F-11) must be stable first. Attempting to build COS on unstable foundations would produce a fragile feature.

4. **Media processing inclusion:** F-08 is placed in Sprint 3 despite ranking #14 from two agents. The rationale: M-sized effort is modest, Sprint 3 has capacity alongside F-07 and F-09, and handling voice notes makes the copilot feel complete for WhatsApp-native users. However, it is explicitly marked as the first item to defer if Sprint 3 is capacity-constrained.

5. **Learning loop last despite long-term moat:** F-15 is the product's strongest long-term differentiator but ships last. This is not a strategic de-prioritization -- it is a data dependency. The learning loop needs 500+ accumulated signals to be meaningful. Shipping it in Sprint 5 (after 3 sprints of signal capture) is the earliest it can deliver value.

---

## Sprint 1 Definition of Done

Sprint 1 is complete when the following are all true:

### Functional Requirements
- [ ] A workspace owner can scan a QR code and connect their WhatsApp account (Baileys session established)
- [ ] Inbound WhatsApp messages are received, deduplicated by wamid, and stored in the messages table
- [ ] Phone numbers are normalized to E.164 and matched to existing client records or new client profiles are created
- [ ] Client lifecycle status is set to "open" on first contact
- [ ] Staff receives a push notification within 2 seconds of an inbound message
- [ ] In-app unread badge counts are accurate
- [ ] Audit events are logged for all data mutations with actor, action, and before/after state

### Infrastructure Requirements
- [ ] Baileys WebSocket session survives a Railway container restart and auto-reconnects
- [ ] pgmq message queue processes inbound messages with correct ordering per client
- [ ] Advisory locks prevent concurrent processing of the same client's messages
- [ ] Failed message processing retries via pgmq visibility timeout
- [ ] Dead letter queue captures messages that fail after maximum retries
- [ ] Supabase Realtime delivers message events to the Next.js staff app

### Observability Requirements
- [ ] pgmq queue depth is monitored; alert triggers when depth > 10 or oldest message age > 2 minutes
- [ ] Baileys session health is monitored; disconnection triggers QR re-scan prompt in the staff app
- [ ] Message delivery status tracking (sent/delivered/read/failed) is functional

### What Sprint 1 Does NOT Include
- AI draft generation (Sprint 2)
- Instagram scraping or SOP generation (Sprint 2)
- Tone profile extraction (Sprint 2)
- Approval workflow or governance (Sprint 2)
- Booking or calendar integration (Sprint 3)
- Any LLM-dependent features

Sprint 1 is a deterministic infrastructure sprint. Every deliverable is testable without an LLM API key.
