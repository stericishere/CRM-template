# Feature List — WhatsApp-First AI Client Ops Manager

**Version:** 1.1
**Date:** March 2026
**Status:** Reviewed (CEO + Eng) — scope locked for user story generation
**Source documents:** PRD v2.1, Architecture Specification v1.0
**Review:** CEO review PASS, Eng review PASS after corrections applied

---

## Overview

This document groups the 78 PRD functions (§21) into 15 deliverable features, organized by MVP phase. Each feature is a cohesive unit of user value that maps to one or more architecture bounded contexts.

**Sizing guide:**

| Size | Meaning |
|------|---------|
| S | 1-2 days of engineering effort, limited integration surface |
| M | 3-5 days, moderate integration or LLM involvement |
| L | 1-2 weeks, significant integration, multiple bounded contexts |
| XL | 2+ weeks, complex orchestration, external API dependencies |

---

## Phase 1: Core Messaging and Onboarding

These features establish the foundation: WhatsApp connectivity, workspace creation, client identity, and the onboarding wizard that bootstraps knowledge and SOPs.

| # | Feature | Description | JTBD | PRD Functions | Architecture Module | Phase | Size | ADR Dependencies |
|---|---------|-------------|------|---------------|---------------------|-------|------|------------------|
| F-01 | **Workspace Onboarding & Business Setup** | Owner scans a QR code to connect their existing WhatsApp account. System creates workspace, collects business identity, scrapes Instagram for a draft knowledge base, runs deep research to generate vertical-specific SOPs (appointment types, custom fields, sequencing rules), and extracts a tone profile. Owner refines all outputs conversationally. Existing WhatsApp conversations are imported for context bootstrapping. | Staff: "I want to control what the AI can and cannot say." Manager: "I want consistent handling of inbound communication." | ON-01, ON-02, ON-03, ON-04, ON-05, ON-06 | workspace-knowledge, conversation | 1 | XL | ADR-1 (single agent — SOP generation is an LLM call, not a separate agent) |
| F-02 | **WhatsApp Message Pipeline** | Receives inbound messages from the connected WhatsApp Web session, deduplicates, enqueues to BullMQ, normalizes phone numbers, resolves session keys, and stores messages. Manages WhatsApp session health (detects disconnection, prompts QR re-scan). Imports existing conversation history on first connection. Tracks delivery status (sent/delivered/read/failed). | Client: "I want to know when I'm getting a response." Staff: "I want to know who this client is without rereading the whole chat." | MP-01, MP-02, MP-06, MP-07, MP-08, MP-09, CS-01 | conversation (ProcessInboundMessage, BullMQMessageQueue), integrations/whatsapp | 1 | L | ADR-2 (database-backed sessions — session key resolves to DB queries, not files) |
| F-03 | **Client Identity & Profile** | Matches inbound phone numbers to existing client records (exact E.164 match) or creates new client profiles. Maintains lifecycle status (open, chosen_service, upcoming_appointment, follow_up, review_complete, inactive). Stores vertical-specific custom fields in preferences JSON. | Staff: "I want to know who this client is without rereading the whole chat." Client: "I want the business to remember my context." | MP-03, CI-01, CI-02 | client-relationship (Client, ClientProfile, ClientRepository) | 1 | M | ADR-2 (all queries scoped by workspace_id + client_id) |
| F-04 | **Staff Notifications & Audit Foundation** | Push notifications on inbound messages, in-app unread badges, and foundational audit event logging for all system mutations (actor, action, before/after state, session key). This is the governance baseline that every later feature builds on. | Staff: "I want help responding quickly with the right information." Manager: "I want visibility into what happened and what is coming up." | NT-01, NT-02, AG-06 | agent-governance (AuditEvent), integrations (push notifications) | 1 | M | — |

---

## Phase 2: AI Drafting and Booking

These features activate the AI assistant: context assembly, draft generation, booking orchestration, approval workflows, and the staff review experience.

| # | Feature | Description | JTBD | PRD Functions | Architecture Module | Phase | Size | ADR Dependencies |
|---|---------|-------------|------|---------------|---------------------|-------|------|------------------|
| F-05 | **Context Assembly & AI Draft Generation** | Assembles a read-only context window per client (global workspace config + client-scoped profile, compact summary, recent messages, active items) then invokes the Client Worker (single LLM call with tools). Classifies intent, generates a draft reply with knowledge source attribution, handles confidence-based escalation, and supports staff reprompting/regeneration. Includes knowledge semantic search (pgvector) against the workspace knowledge base. | Client: "I want to ask a question and get an answer quickly." Staff: "I want help responding quickly with the right information." Staff: "I want to override or correct what the AI drafted." | CS-02, CS-03, CS-04, AD-01, AD-02, AD-03, AD-04, AD-05, AD-06, AD-07 | conversation (GenerateReplyDraft, RegenerateDraft), workspace-knowledge (SearchKnowledge), client-relationship (AssembleClientContext), agent/ClientWorkerRuntime, agent/ContextAssembler | 2 | XL | ADR-1 (single agent with tools), ADR-2 (context assembly is DB queries), ADR-3 (fixed token budget, no reactive compaction) |
| F-06 | **Approval Workflow & Governance** | Evaluates every proposed action against a three-tier trust model (auto-allowed / suggest-for-review / human-only). Creates confirmation cards for review-tier actions. Processes staff approvals and rejections. Injects workspace_id and client_id into all tool calls at runtime so the LLM cannot override session scope. Sends draft-ready and escalation re-notifications. | Staff: "I want to control what the AI can and cannot say." Manager: "I want consistent handling of inbound communication." | AG-01, AG-02, AG-03, AG-04, AG-05, AG-07, NT-03, NT-04 | agent-governance (ProposedAction, ConfirmationRequest, ApprovalPolicy, EvaluateApprovalPolicy, ExecuteApprovedAction), agent/ToolParamInjector | 2 | L | ADR-1 (tools return ProposedAction, not direct writes) |
| F-07 | **Booking & Scheduling** | Full appointment lifecycle: queries Google Calendar for available slots, proposes 2-4 options in drafts, matches client slot selection, detects conflicts, validates appointment type prerequisites from vertical config, creates calendar events and booking records after staff approval. Includes Google Calendar OAuth connection flow. | Client: "I want to book or reschedule without back-and-forth." Staff: "I want to see available times without checking calendars manually." Manager: "I want appointment scheduling to require less manual effort." | BK-01, BK-02, BK-03, BK-04, BK-05, BK-06, BK-07, BK-08, BK-09, ON-07 | booking-operations (QueryAvailability, ProposeBooking, DetectConflict, GoogleCalendarGateway) | 2 | XL | ADR-1 (calendar is a tool, not a separate agent), ADR-4 (booking drafts go through Client Worker) |
| F-08 | **Media Processing** | Transcribes voice notes (Whisper or equivalent) before context assembly so transcribed text appears in the conversation. Passes images to the multimodal LLM within the Client Worker call. Stores media references and transcriptions in the message record. | Staff: "I want help responding quickly with the right information." | MP-04, MP-05 | conversation (ProcessInboundMessage — media pre-processing step), integrations/llm | 2 | M | ADR-1 (image processing happens within the single Client Worker LLM call) |
| F-09 | **Notes, Follow-ups & Knowledge Management** | Staff saves notes with instant write (no AI needed). Creates and tracks follow-up records with optional due dates and status (open/completed/pending/overdue). Staff uploads documents (PDFs, menus) which are chunked and embedded for knowledge search. Staff-initiated client merge transfers all records and soft-deletes the source. | Staff: "I want to record important client notes without heavy admin." Staff: "I want the next person to know what happened." | NF-01, NF-05, NF-06, ON-08, CI-03, CI-04 | follow-up-management (ProposeFollowUp), workspace-knowledge (IndexKnowledge), client-relationship (client merge) | 2 | L | ADR-2 (all records scoped by workspace + client) |
| F-10 | **Learning Signal Capture** | Records a structured signal every time staff acts on a draft: original draft, final version, staff action (sent_as_is / edited_and_sent / regenerated / discarded), intent classification, and scenario type. Pure database write at send time — no LLM required. This is the raw data foundation for the Phase 4 learning loop. | Manager: "I want consistent handling of inbound communication." | LL-01 | learning-optimization (RecordDraftEditSignal, DraftEditSignal) | 2 | S | — |

---

## Phase 3: Operational Memory and Follow-ups

These features add proactive operations: daily memory compaction, COS-driven follow-up surfacing, intelligent note processing, and acceptance tracking.

| # | Feature | Description | JTBD | PRD Functions | Architecture Module | Phase | Size | ADR Dependencies |
|---|---------|-------------|------|---------------|---------------------|-------|------|------------------|
| F-11 | **Daily Memory Compaction** | Daily cron per workspace timezone. For each client with activity since last compaction: verifies all async extractions are complete (flush-before-compact invariant), generates an updated compact summary via a dedicated LLM call, and writes a new versioned Memory record. Raw messages are summarized away; structured records (notes, follow-ups, bookings) survive intact. | Staff: "I want to know who this client is without rereading the whole chat." Staff: "I want the next person to know what happened." | CS-05, CS-06 | conversation (CompactConversation), jobs/DailyCompactionJob | 3 | L | ADR-3 (daily scheduled compaction, not reactive), ADR-2 (compaction reads/writes scoped to one client) |
| F-12 | **COS Daily Operations & Today's View** | The Chief of Staff (COS) runs as a daily cron and on-demand. It detects stale conversations, unconfirmed bookings, and overdue follow-ups across all clients (from structured records only — never reads messages). Ranks actions by urgency via LLM. Dispatches Client Worker invocations to generate contextually rich follow-up and confirmation reminder drafts. Aggregates today's bookings, follow-ups, and at-risk items into the Today's View for staff. | Manager: "I want my team to stop losing follow-ups and context." Manager: "I want visibility into what happened and what is coming up." | CO-01, CO-02, CO-03, CO-04, CO-05, CO-06, CO-07, NF-07 | agent/COSOperationsRuntime, follow-up-management (SurfaceOverdueFollowUps), booking-operations, jobs/DailyFollowUpJob | 3 | XL | ADR-4 (COS identifies clients, Client Worker drafts messages), ADR-1 (COS is a separate LLM invocation path, not multi-agent) |
| F-13 | **Intelligent Note Processing & Promise Tracking** | Async AI categorization of staff notes: extracts follow-ups, preference updates, and promises. Surfaces structured change proposals via confirmation cards when a note implies a data update (e.g., "update her name to Liz"). Parses conversational context updates from staff. Extracts promises from conversation history and auto-creates follow-up records with deadlines. | Staff: "I want to record important client notes without heavy admin." Manager: "I want my team to stop losing follow-ups and context." | NF-02, NF-03, NF-04, NF-08 | follow-up-management, client-relationship (ProposeClientUpdate), agent-governance (confirmation cards) | 3 | L | ADR-1 (note categorization is an async LLM call), ADR-4 (promise extraction dispatches through Client Worker path) |
| F-14 | **Draft Acceptance Metrics** | Aggregates learning signals into draft acceptance rate metrics: sent_as_is / edited_and_sent / regenerated / discarded counts per workspace. Tracks whether clients replied to sent messages and reply latency. Provides the quantitative foundation for Phase 4 pattern analysis. | Manager: "I want consistent handling of inbound communication." | LL-02, LL-09 | learning-optimization (DraftEditSignal aggregation) | 3 | S | — |

---

## Phase 4: Refinement and Learning

This feature closes the learning loop: analyzing staff edits, detecting recurring patterns, and promoting them into workspace-level communication rules that improve all future drafts.

| # | Feature | Description | JTBD | PRD Functions | Architecture Module | Phase | Size | ADR Dependencies |
|---|---------|-------------|------|---------------|---------------------|-------|------|------------------|
| F-15 | **Learning Loop & Communication Rules** | Async LearningWorker classifies staff edits by type (tone_softened, assumption_removed, upsell_removed, etc.) and assigns stable pattern keys. Tracks recurrence counts across clients. When a pattern meets the promotion threshold (3+ occurrences, 2+ distinct clients, 30-day window), it creates a CommunicationRule and adds it to the WorkspaceCommunicationProfile. Active rules are injected into context assembly for all future Client Worker calls. Staff can view, edit, and disable rules in Settings. | Staff: "I want to override or correct what the AI drafted." Manager: "I want consistent handling of inbound communication." | LL-03, LL-04, LL-05, LL-06, LL-07, LL-08 | learning-optimization (ClassifyDraftEdits, UpdatePatternRecurrence, PromoteToCommunicationRule, CommunicationRule, WorkspaceCommunicationProfile) | 4 | XL | ADR-1 (rules injected into single-agent context, not as a separate agent), ADR-3 (rules are part of global context assembled deterministically) |

---

## Summary

| Phase | Features | Total Functions | Sizing Distribution |
|-------|----------|-----------------|---------------------|
| Phase 1: Core Messaging & Onboarding | F-01 through F-04 | 19 | 1 XL, 1 L, 2 M |
| Phase 2: AI Drafting & Booking | F-05 through F-10 | 37 | 2 XL, 2 L, 1 M, 1 S |
| Phase 3: Operational Memory & Follow-ups | F-11 through F-14 | 16 | 1 XL, 2 L, 1 S |
| Phase 4: Refinement & Learning | F-15 | 6 | 1 XL |
| **Total** | **15 features** | **78 functions** | **4 XL, 5 L, 3 M, 2 S** |

### Function coverage

All 78 PRD functions (ON-01 through LL-09) are mapped to exactly one feature. No function is orphaned or duplicated.

### Architecture coverage

All 7 bounded contexts are exercised:

| Bounded Context | Features |
|-----------------|----------|
| client-relationship | F-03, F-05, F-09, F-13 |
| conversation | F-01, F-02, F-05, F-08, F-11 |
| booking-operations | F-07, F-12 |
| follow-up-management | F-09, F-12, F-13 |
| workspace-knowledge | F-01, F-05, F-09 |
| agent-governance | F-04, F-06, F-13 |
| learning-optimization | F-10, F-14, F-15 |

### Inter-feature dependencies

```
Phase 1:
  F-02 (Message Pipeline) ─→ prerequisite for F-01, F-03, F-04
  F-01 (Onboarding) ─→ depends on F-02 (QR code scan triggers via the app, but messages flow through F-02)
  F-03 (Client Identity) ─→ depends on F-02 (inbound phone numbers)

Phase 2:
  F-05 (AI Drafting) ─→ depends on F-02, F-03; prerequisite for F-06, F-07, F-08, F-10
  F-06 (Governance) ─→ depends on F-04 (audit foundation), F-05 (Client Worker produces ProposedActions)
  F-07 (Booking) ─→ depends on F-05 (Client Worker), F-06 (approval workflow for booking confirmation)
  F-08 (Media) ─→ depends on F-02 (pipeline), F-05 (Client Worker for image context)
  F-09 (Notes/Knowledge) ─→ depends on F-01 (knowledge indexing pipeline for doc upload)
  F-10 (Learning Signals) ─→ depends on F-05 (drafts must exist)

Phase 3:
  F-11 (Compaction) ─→ depends on F-05 (conversations must exist)
  F-12 (COS Operations) ─→ depends on F-11 (compact summaries for follow-up drafts), F-09 (follow-up records)
  F-13 (Note Processing) ─→ depends on F-06 (confirmation cards from governance module), F-09 (note infrastructure)
  F-14 (Acceptance Metrics) ─→ depends on F-10 (signal data)

Phase 4:
  F-15 (Learning Loop) ─→ depends on F-10 (signals), F-14 (metrics), F-05 (context assembly for rule injection)
```

### Critical path

F-02 (Message Pipeline) is the foundational prerequisite. F-05 (Context Assembly & AI Drafting) is the critical Phase 2 feature — F-06, F-07, F-08, and F-10 all depend on the Client Worker being operational. F-12 (COS Operations) depends on F-11 (Compaction) and F-09 (follow-up records). Build order within Phase 2 should be: F-05 first, then F-06, then F-07/F-08/F-09/F-10 in parallel.

### Review notes (applied)

- **JTBD mapping corrected:** F-05 now includes client JTBD "ask a question and get an answer quickly"; F-08 corrected to staff-facing JTBD only.
- **WhatsApp model updated:** QR code Web protocol (like OpenClaw), not Meta Cloud API. No WABA, no 24h window, no templates. History import on first connection.
- **Architectural note:** Async note categorization (NF-02 in F-13) needs a runtime home — recommend reusing Client Worker with a categorization tool set, or a lightweight `NoteProcessingJob` in `jobs/`.
- **Consider for late Phase 2:** A lightweight Today's View (today's bookings + open follow-ups, no LLM ranking) could provide proactive visibility earlier than Phase 3.
