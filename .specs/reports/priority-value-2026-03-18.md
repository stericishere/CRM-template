# Priority Analysis: User Value (RICE Score)

**Agent:** A -- User Value Lens
**Date:** 2026-03-18
**Method:** RICE Framework
**Source:** PRD v2.1 (sections 3, 5, 19), Feature List v1.1

---

## Scoring Methodology

### RICE Parameters

| Parameter | Scale | Interpretation |
|-----------|-------|----------------|
| **Reach** | 1--10 | How many users/interactions this feature touches per week. 10 = every single message/session; 1 = rare admin action. |
| **Impact** | 0.25 / 0.5 / 1 / 2 / 3 | Minimal / Low / Medium / High / Massive. How much this moves the five primary product goals (section 3.1). |
| **Confidence** | 20--100% | How certain we are that this delivers measurable value. Higher for features with clear metrics (section 19); lower for speculative or deferred-payoff features. |
| **Effort** | S=1 / M=2 / L=3 / XL=5 | Normalized from the feature list sizing guide (days to weeks). |

**RICE Score = (Reach x Impact x Confidence) / Effort**

### Product Goals Used for Impact Scoring (PRD section 3.1)

| # | Goal | Baseline | Target |
|---|------|----------|--------|
| G1 | Median response preparation time | ~5 min | < 30 sec |
| G2 | Time to book from first message | ~15 min | < 3 min |
| G3 | Interactions with usable client summary | ~10% | > 80% |
| G4 | Follow-ups captured vs. missed | ~30% | > 85% |
| G5 | Booking conversion rate | Unmeasured | Tracked day 1 |

### JTBDs Referenced (PRD section 5)

- **C1:** "Ask a question and get an answer quickly."
- **C2:** "Book or reschedule without back-and-forth."
- **C3:** "The business to remember my context."
- **C4:** "Know when I'm getting a response."
- **S1:** "Know who this client is without rereading the whole chat."
- **S2:** "Help responding quickly with the right information."
- **S3:** "See available times without checking calendars manually."
- **S4:** "Record important client notes without heavy admin."
- **S5:** "The next person to know what happened."
- **S6:** "Override or correct what the AI drafted."
- **S7:** "Control what the AI can and cannot say."
- **M1:** "Stop losing follow-ups and context."
- **M2:** "Consistent handling of inbound communication."
- **M3:** "Appointment scheduling to require less manual effort."
- **M4:** "Visibility into what happened and what is coming up."

---

## RICE Score Table

| Rank | Feature | R | I | C | E | RICE | Goals Hit | JTBDs |
|------|---------|---|---|---|---|------|-----------|-------|
| 1 | **F-05** Context Assembly & AI Draft Generation | 10 | 3 | 90% | 5 | **5.40** | G1, G3 | C1, S1, S2, S6 |
| 2 | **F-02** WhatsApp Message Pipeline | 10 | 3 | 95% | 3 | **9.50** | G1 | C4, S1 |
| 3 | **F-07** Booking & Scheduling | 8 | 3 | 80% | 5 | **3.84** | G2, G5 | C2, S3, M3 |
| 4 | **F-03** Client Identity & Profile | 10 | 2 | 95% | 2 | **9.50** | G3 | S1, C3 |
| 5 | **F-06** Approval Workflow & Governance | 9 | 2 | 90% | 3 | **5.40** | G1 | S7, M2 |
| 6 | **F-01** Workspace Onboarding & Business Setup | 10 | 2 | 85% | 5 | **3.40** | G1, G3 | S7, M2 |
| 7 | **F-12** COS Daily Operations & Today's View | 7 | 3 | 70% | 5 | **2.94** | G4, G5 | M1, M4 |
| 8 | **F-09** Notes, Follow-ups & Knowledge Mgmt | 7 | 2 | 85% | 3 | **3.97** | G4, G3 | S4, S5 |
| 9 | **F-04** Staff Notifications & Audit Foundation | 8 | 1 | 90% | 2 | **3.60** | G1 | S2, M4 |
| 10 | **F-10** Learning Signal Capture | 9 | 1 | 90% | 1 | **8.10** | G1 (indirect) | M2 |
| 11 | **F-11** Daily Memory Compaction | 6 | 2 | 75% | 3 | **3.00** | G3 | S1, S5 |
| 12 | **F-13** Intelligent Note Processing & Promise Tracking | 5 | 2 | 65% | 3 | **2.17** | G4 | S4, M1 |
| 13 | **F-08** Media Processing | 4 | 1 | 75% | 2 | **1.50** | G1 | S2 |
| 14 | **F-14** Draft Acceptance Metrics | 5 | 1 | 80% | 1 | **4.00** | G1 (indirect) | M2 |
| 15 | **F-15** Learning Loop & Communication Rules | 4 | 2 | 50% | 5 | **0.80** | G1 (deferred) | S6, M2 |

> **Note on F-02 and F-03 raw scores:** These score very high on raw RICE because they are small/medium effort with universal reach and high confidence. However, they are infrastructure -- their user value is only unlocked when combined with F-05 (AI drafting). The ranked priority stack below accounts for this by treating them as mandatory prerequisites rather than standalone value deliverers.

---

## Ranked Priority Stack

| Priority | Feature | RICE | Phase | Size | Rationale |
|----------|---------|------|-------|------|-----------|
| **1** | **F-02** WhatsApp Message Pipeline | 9.50 | 1 | L | Every feature depends on messages flowing. Universal reach, near-certain value. Zero product exists without this. |
| **2** | **F-03** Client Identity & Profile | 9.50 | 1 | M | Resolves "who is this client?" for every inbound message. Direct enabler for G3 (usable summaries) and prerequisite for all AI features. |
| **3** | **F-05** Context Assembly & AI Draft Generation | 5.40 | 2 | XL | The core value proposition. Directly attacks G1 (response time from 5 min to 30 sec). Highest-impact feature in the entire product. Despite XL effort, this is where the product becomes differentiated. |
| **4** | **F-01** Workspace Onboarding & Business Setup | 3.40 | 1 | XL | Gateway to all value -- users cannot enter the product without it. Reach is 100% of new users. Lower RICE due to XL effort, but non-negotiable. |
| **5** | **F-06** Approval Workflow & Governance | 5.40 | 2 | L | Trust layer that makes AI drafting safe to use. Without governance, staff cannot confidently send AI-generated content. Directly supports S7 and M2. |
| **6** | **F-07** Booking & Scheduling | 3.84 | 2 | XL | Directly attacks G2 (time to book) and G5 (booking conversion). High impact on the most concrete success metric. Appointment-based verticals cannot get full value without this. |
| **7** | **F-04** Staff Notifications & Audit Foundation | 3.60 | 1 | M | Foundation for responsiveness (push notifications) and governance (audit trail). Medium effort, high confidence. Every approval and governance feature builds on this. |
| **8** | **F-10** Learning Signal Capture | 8.10 | 2 | S | Extremely cheap (S-sized) pure data capture. Installing the instrumentation early means richer data for F-14 and F-15 later. High RICE due to minimal effort. |
| **9** | **F-09** Notes, Follow-ups & Knowledge Mgmt | 3.97 | 2 | L | Directly attacks G4 (follow-up capture from 30% to 85%). Staff-facing JTBD for note-taking and knowledge management. Prerequisite for COS operations (F-12). |
| **10** | **F-14** Draft Acceptance Metrics | 4.00 | 3 | S | Cheap aggregation layer (S-sized) that provides the first quantitative feedback loop. Enables data-driven iteration on draft quality. |
| **11** | **F-11** Daily Memory Compaction | 3.00 | 3 | L | Required for G3 (usable summaries at scale). Without compaction, context windows bloat and draft quality degrades over time. Operational necessity. |
| **12** | **F-12** COS Daily Operations & Today's View | 2.94 | 3 | XL | Proactive operations: the system surfaces what staff should do today. High impact on G4 (follow-up capture) and M4 (visibility). XL effort limits RICE score. |
| **13** | **F-13** Intelligent Note Processing & Promise Tracking | 2.17 | 3 | L | AI-assisted note categorization and promise extraction. Valuable but speculative -- 65% confidence reflects uncertainty about extraction accuracy. |
| **14** | **F-08** Media Processing | 1.50 | 2 | M | Voice notes and images are real but not the primary interaction pattern. Only ~20-30% of messages include media. Nice-to-have for MVP. |
| **15** | **F-15** Learning Loop & Communication Rules | 0.80 | 4 | XL | Highest long-term value, lowest short-term certainty. Requires weeks of accumulated signal data to even begin pattern detection. 50% confidence reflects genuine uncertainty about whether automated rule promotion will work well in practice. |

---

## Sprint 1 Recommendation

**Goal:** Establish the messaging foundation so that the first AI draft can be generated end-to-end.

| Sprint 1 Deliverables | Size | Justification |
|------------------------|------|---------------|
| **F-02** WhatsApp Message Pipeline | L | Messages must flow before anything else works. |
| **F-03** Client Identity & Profile | M | Every message needs a resolved client. |
| **F-04** Staff Notifications & Audit Foundation | M | Staff must know a message arrived; audit trail starts day 1. |

**Total Sprint 1 effort:** L + M + M = approximately 1.5-2 weeks

**Sprint 1 exit criteria:**
- Inbound WhatsApp messages are received, deduplicated, and stored
- Phone numbers resolve to client records (find-or-create)
- Staff receives push notification on inbound message
- Audit events are logged for all mutations
- WhatsApp session health is monitored with re-scan flow

**Why not F-01 (Onboarding) in Sprint 1?** F-01 is XL and includes LLM-dependent flows (Instagram scraping, SOP generation, tone profiling). Sprint 1 should focus on deterministic infrastructure. F-01 can be started in parallel but should be Sprint 2 alongside F-05, since the onboarding wizard output (knowledge base, SOPs, tone profile) is primarily consumed by the AI draft generation pipeline.

**Sprint 2 preview:** F-01 (Onboarding) + F-05 (AI Drafting) -- the "first AI draft" milestone.

---

## Justification: Top 5

### 1. F-02 -- WhatsApp Message Pipeline (RICE: 9.50)

- **Reach: 10** -- Every single interaction in the product starts with an inbound message. 100% of users, 100% of sessions.
- **Impact: 3 (Massive)** -- Without message flow, the product is a blank screen. This is the foundation that enables G1, G2, G3, G4, and G5.
- **Confidence: 95%** -- Message ingestion pipelines are well-understood engineering. BullMQ, phone normalization, and session management are proven patterns.
- **Effort: L (3)** -- Significant integration with WhatsApp Web protocol, session health management, and history import. But bounded scope.
- **Why #1:** The entire dependency graph roots here. F-01, F-03, F-04, and everything downstream depends on messages flowing. Highest-confidence, highest-reach feature in the product.

### 2. F-03 -- Client Identity & Profile (RICE: 9.50)

- **Reach: 10** -- Every inbound message triggers client resolution. Universal.
- **Impact: 2 (High)** -- Directly enables G3 (usable client summaries). Every downstream feature that references "this client" depends on identity being resolved.
- **Confidence: 95%** -- Exact E.164 phone matching is deterministic. No AI uncertainty.
- **Effort: M (2)** -- Straightforward CRUD with lifecycle status and custom fields.
- **Why #2:** Tied with F-02 on raw RICE. Ranked second because it depends on F-02 (needs inbound phone numbers). Together with F-02, these two features establish the "who said what" foundation.

### 3. F-05 -- Context Assembly & AI Draft Generation (RICE: 5.40)

- **Reach: 10** -- Every client conversation that triggers a draft. Once active, this is the primary staff interaction.
- **Impact: 3 (Massive)** -- This IS the product's core value proposition. Directly attacks G1 (response time from 5 min to 30 sec). Delivers on C1 ("get an answer quickly"), S2 ("help responding quickly"), and S1 ("know who this client is").
- **Confidence: 90%** -- LLM-based drafting with retrieved context is a proven pattern (RAG). Knowledge attribution and confidence scoring add reliability. Risk is in draft quality, which is mitigated by staff review (F-06).
- **Effort: XL (5)** -- Context assembly, pgvector search, Client Worker runtime, reprompting/regeneration. Most complex single feature.
- **Why #3:** Despite XL effort dragging RICE below F-02/F-03, this is the feature that transforms the product from "a message viewer" into "an AI assistant." Without F-05, there is no product differentiation. The 10x improvement on G1 is the single most impactful metric movement in the entire PRD.

### 4. F-01 -- Workspace Onboarding & Business Setup (RICE: 3.40)

- **Reach: 10** -- Every new workspace must go through onboarding. 100% of users experience this exactly once, and the quality of onboarding determines the quality of all subsequent AI output.
- **Impact: 2 (High)** -- The knowledge base, SOPs, tone profile, and vertical config generated here feed directly into F-05 (AI drafting). Poor onboarding means poor drafts means low acceptance rate.
- **Confidence: 85%** -- Instagram scraping is explicitly called out as unreliable (PRD section 20: "Fallback to manual knowledge entry"). Deep research SOP generation is LLM-dependent. Slightly lower confidence due to these dependencies.
- **Effort: XL (5)** -- QR code connection, Instagram scraping, deep research, conversational editing, tone extraction, history import. Broad scope.
- **Why #4:** Non-negotiable gateway feature. Lower RICE than F-06 due to XL effort, but logically must precede meaningful AI drafting. The quality of every downstream AI interaction depends on the knowledge base and SOPs bootstrapped here.

### 5. F-06 -- Approval Workflow & Governance (RICE: 5.40)

- **Reach: 9** -- Every AI-proposed action (drafts, bookings, data updates) passes through the approval workflow. Slightly below 10 because some actions are auto-allowed in the trust model.
- **Impact: 2 (High)** -- Without governance, AI drafting (F-05) cannot be safely used. This is the trust layer that makes the product viable for real business communication. Directly addresses S7 ("control what the AI can and cannot say") and M2 ("consistent handling").
- **Confidence: 90%** -- Three-tier trust model is well-specified. Confirmation cards are a standard UI pattern. Parameter injection for scope enforcement is deterministic.
- **Effort: L (3)** -- Trust evaluation, confirmation cards, approval/rejection flows, scope injection. Moderate complexity.
- **Why #5:** The product principle "Human trust is part of the product" (section 6) makes this non-optional for any deployment. Staff will not use AI drafting if they cannot control and review what gets sent. F-06 is what converts F-05 from a demo into a production tool.

---

## Justification: Bottom 3

### 13. F-13 -- Intelligent Note Processing & Promise Tracking (RICE: 2.17)

- **Reach: 5** -- Only triggered when staff writes notes (not every interaction) and when conversations contain explicit promises (subset of messages).
- **Impact: 2 (High)** -- When it works, automatically extracting follow-ups from notes and promises from conversations is genuinely valuable for G4. But the impact depends entirely on extraction accuracy.
- **Confidence: 65%** -- AI-based note categorization and promise extraction are the least certain AI features in the product. False positives (extracting non-promises) erode trust. False negatives (missing real promises) defeat the purpose. The PRD acknowledges this risk indirectly by placing it in Phase 3.
- **Effort: L (3)** -- Async LLM categorization, confirmation cards for data updates, promise extraction pipeline.
- **Why bottom 3:** High-value concept with significant execution risk. The manual alternative (F-09 basic notes and follow-ups) captures 70%+ of the value at lower risk. F-13 is an enhancement, not a necessity.

### 14. F-08 -- Media Processing (RICE: 1.50)

- **Reach: 4** -- Industry data suggests 20-30% of WhatsApp messages contain media. Voice notes are more common in some markets, but text dominates business inquiries. Not every interaction involves media.
- **Impact: 1 (Medium)** -- Incremental improvement to draft quality when media is present. Does not independently move any primary goal metric. The AI can still draft useful responses based on text context even without media processing.
- **Confidence: 75%** -- Whisper transcription is reliable for clear audio. Image understanding via multimodal LLM is decent but not perfect. Some loss in translation is expected.
- **Effort: M (2)** -- Integration with Whisper API, multimodal LLM routing, media storage.
- **Why bottom 3:** Useful but not critical. Text messages are the primary interaction pattern for business inquiries. The product delivers its core value (G1, G2, G4) without media processing. This is a "make it better" feature, not a "make it work" feature.

### 15. F-15 -- Learning Loop & Communication Rules (RICE: 0.80)

- **Reach: 4** -- Only affects workspaces with sufficient accumulated signal data (3+ occurrences, 2+ distinct clients, 30-day window). In early deployment, few workspaces will have enough data to trigger rule promotion.
- **Impact: 2 (High)** -- When the learning loop works, it is transformative: the system gets measurably better over time without manual intervention. Long-term, this is possibly the most valuable feature in the product.
- **Confidence: 50%** -- The lowest confidence score in the entire list. Automated pattern detection from staff edits is novel and unproven. The classification taxonomy (tone_softened, assumption_removed, upsell_removed) may not capture real edit patterns. Promotion thresholds are guesses. The rules, once injected into context, may have unintended effects on draft quality.
- **Effort: XL (5)** -- LearningWorker, pattern classification, recurrence tracking, rule promotion, context injection, staff management UI. The most architecturally complex feature.
- **Why dead last:** Maximum effort, minimum short-term confidence. This feature cannot deliver value until F-10 (signal capture) and F-14 (metrics) have been running for weeks in production. It is the right feature to build last because (a) it needs data that only exists after extensive usage, (b) the team will have learned from real usage patterns what "good" looks like, and (c) the risk of building it wrong is highest when you have the least production data. Build it when you know what you are building.

---

## Summary View

```
MUST SHIP FIRST (Sprint 1-2):
  F-02 Message Pipeline .......... 9.50  [L]   -- messages flow
  F-03 Client Identity ........... 9.50  [M]   -- clients resolve
  F-04 Notifications & Audit ..... 3.60  [M]   -- staff alerted, audit starts
  F-01 Onboarding ................ 3.40  [XL]  -- workspace bootstrapped
  F-05 AI Draft Generation ....... 5.40  [XL]  -- core value unlocked

HIGH VALUE (Sprint 3-4):
  F-06 Governance ................ 5.40  [L]   -- trust layer
  F-07 Booking ................... 3.84  [XL]  -- appointment conversion
  F-10 Learning Signals .......... 8.10  [S]   -- cheap instrumentation
  F-09 Notes & Follow-ups ....... 3.97  [L]   -- follow-up capture

OPERATIONAL MATURITY (Sprint 5-6):
  F-14 Acceptance Metrics ........ 4.00  [S]   -- quantitative feedback
  F-11 Memory Compaction ......... 3.00  [L]   -- context sustainability
  F-12 COS Daily Ops ............. 2.94  [XL]  -- proactive operations

ENHANCEMENT (Sprint 7+):
  F-13 Note Processing ........... 2.17  [L]   -- AI note extraction
  F-08 Media Processing .......... 1.50  [M]   -- voice/image support
  F-15 Learning Loop ............. 0.80  [XL]  -- self-improving AI
```
