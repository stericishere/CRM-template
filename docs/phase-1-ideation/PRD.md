# PRD — WhatsApp-First AI Client Ops Manager (Platform Template)

**Version:** 2.1
**Date:** March 2026
**Status:** Final — ready for user story generation and implementation planning
**Nature:** This is a platform template. Each client deployment configures vertical-specific content (appointment types, custom fields, SOP rules) without code changes. The Supabase schema, message pipeline, agent runtime, and staff app are universal.

---

## Table of contents

1. Overview
2. Problem statement
3. Product goals
4. Target users
5. User jobs to be done
6. Product principles
7. AI role and behaviour specification
8. Trust and action model
9. User flows
10. Functional requirements
11. Vertical configuration layer
12. Data model (universal Supabase schema)
13. Session and context management
14. Integrations
15. Onboarding flow
16. Staff app and UX requirements
17. Learning loop
18. Security, privacy, and operations
19. Success metrics
20. Risks and mitigations
21. Function list
22. MVP release strategy
23. Future roadmap
24. Architecture decisions
25. Open questions

---

## 1. Overview

### 1.1 One-line description

A WhatsApp-first AI system for SMBs that turns client conversations into booked appointments, organized client context, and clear next steps.

### 1.2 Product vision

Small and medium businesses run on messy, informal communication. Client requests arrive through WhatsApp, details are remembered by staff instead of systems, follow-ups get lost, bookings are handled manually, and context disappears when another team member takes over.

This product acts as the client operations manager of the business. It does not replace human judgment. It keeps client context organized, helps schedule appointments, answers routine questions from trusted information, summarizes conversations, and ensures important notes and follow-ups are captured.

### 1.3 Core positioning

A staff copilot for WhatsApp-based client operations. Not a fully autonomous chatbot. Not a traditional CRM. The AI operates as an internal assistive layer: it drafts replies, suggests booking options, summarizes context, proposes follow-ups, and helps staff manage operations. All outbound client messages are reviewed by staff, optionally edited, and manually sent.

Primary business outcome: **revenue that doesn't fall through the cracks** — leads followed up, appointments confirmed before they go cold, client context preserved across every interaction.

### 1.4 Template model

This document is the platform template. It defines the core system that works across all verticals. Each client deployment adds:

- Custom client fields (measurements, preferences, health info, etc.)
- Appointment types with durations and sequencing rules
- Vertical-specific SOP rules
- Industry-appropriate knowledge base content

A new client is deployed by configuring these parameters during onboarding — not by modifying code. The Supabase schema, agent runtime, staff app, and message pipeline are identical for every deployment.

---

## 2. Problem statement

SMBs that rely heavily on WhatsApp face consistent operational pain points:

- Inbound messages are handled manually and inconsistently.
- Client information is fragmented across chat history, memory, spreadsheets, and calendars.
- Scheduling is time-consuming and error-prone.
- Important verbal promises and follow-ups are not reliably captured.
- When another staff member takes over, they lack context.
- Businesses respond slowly because staff must reconstruct the situation before acting.

Most existing tools solve only pieces of this problem. Very few systems turn messy client communication into operationally usable context and action.

### 2.1 Competitive landscape

Products such as Respond.io, WATI, Trengo, and Tidio operate in the WhatsApp-first SMB space but focus on multi-channel inbox management rather than operational client context, booking orchestration, and staff-assistive AI drafting. This product differentiates by treating WhatsApp conversations as the input to a structured client operations workflow, not just a messaging channel to manage.

---

## 3. Product goals

### 3.1 Primary goals

| Goal | Baseline (manual) | Target |
|---|---|---|
| Median response preparation time per inbound message | ~5 minutes | < 30 seconds |
| Time to book an appointment from first message | ~15 minutes | < 3 minutes |
| Percentage of interactions with usable client summary | ~10% | > 80% |
| Follow-ups captured vs. missed | ~30% captured | > 85% captured |
| Booking conversion rate from WhatsApp inquiry | Unmeasured | Measured and tracked from day 1 |

### 3.2 Secondary goals

- Lightweight AI-native alternative to traditional CRM for WhatsApp-heavy SMBs.
- Foundation for future multi-channel client operations.
- Reusable platform supporting vertical-specific workflows through configuration.

### 3.3 Non-goals for MVP

- Full CRM replacement.
- Complex sales pipeline management.
- Billing, invoicing, and payments.
- Autonomous client-facing AI communication.
- Multi-channel support beyond WhatsApp.
- Cross-timezone support.
- Multi-staff accounts (MVP: single operator per workspace).

---

## 4. Target users

### 4.1 Primary: business staff / operator

The person handling client communication, appointments, and day-to-day coordination. In MVP, typically the owner-operator.

### 4.2 Secondary: business manager / owner

Needs visibility into client activity, bookings, and operational follow-through. In MVP, often the same person as the primary user.

### 4.3 End client

The customer messaging the business on WhatsApp. Not the buyer of the product, but their experience is central to value. Always interacting with a human staff member — AI assists behind the scenes.

### 4.4 Ideal customer profile

SMBs with high WhatsApp usage, appointment-based workflows, repeat or ongoing client interactions, and weak or inconsistent CRM discipline.

Target verticals (each deployed as a vertical configuration):

| Vertical | Key characteristics |
|---|---|
| Bespoke tailoring / suit businesses | Long multi-step journeys, high context per client |
| Salons and beauty services | High booking volume, repeat clients, preference tracking |
| Clinics and wellness | Appointment-heavy, context-sensitive, follow-up critical |
| Tutoring and coaching | Session scheduling, progress tracking |
| Bridal and event vendors | Long lead times, date-driven urgency |
| Home services | Scheduling complexity, estimate follow-up |

---

## 5. User jobs to be done

### 5.1 Client-facing

- "I want to ask a question and get an answer quickly."
- "I want to book or reschedule without back-and-forth."
- "I want the business to remember my context."
- "I want to know when I'm getting a response."

### 5.2 Staff-facing

- "I want to know who this client is without rereading the whole chat."
- "I want help responding quickly with the right information."
- "I want to see available times without checking calendars manually."
- "I want to record important client notes without heavy admin."
- "I want the next person to know what happened."
- "I want to override or correct what the AI drafted."
- "I want to control what the AI can and cannot say."

### 5.3 Manager-facing

- "I want my team to stop losing follow-ups and context."
- "I want consistent handling of inbound communication."
- "I want appointment scheduling to require less manual effort."
- "I want visibility into what happened and what is coming up."

---

## 6. Product principles

| Principle | Description |
|---|---|
| WhatsApp-first | Product starts where SMB communication already happens. |
| Context before generation | System retrieves trusted context before drafting. |
| System manager, not dictator | AI manages visibility and suggestions. Does not act without limits. All messages require staff review in MVP. |
| Structured facts over conversational memory | Important data lives in typed database fields, not only chat history. |
| Low-friction internal usage | Staff captures notes and follow-ups quickly. |
| Human trust is part of the product | Sensitive actions require review. System never over-trusts its own output. |
| Transparent about its nature | System does not impersonate a human. Assists staff. |
| Vertical through configuration | Business-specific workflows, fields, and rules are configured per workspace, not hardcoded. |

---

## 7. AI role and behaviour specification

### 7.1 AI role

The AI does not send messages directly to clients. It drafts replies, suggests booking options, summarizes context, proposes follow-ups, and helps staff manage operations. All outbound messages are staff-reviewed.

### 7.2 System architecture

**COS (chief of staff)** sits on top as the operational manager. Cross-client visibility. Runs daily crons, identifies clients needing attention, prioritizes staff queue, dispatches Client Worker invocations. Works from structured records only — never individual messages or memory.

**Client Workers** are single LLM calls with tool access, each scoped to exactly one client. Draft replies, propose bookings, summarize context, suggest follow-ups. Multiple can run concurrently; each sees only its own client's data.

**Global toolkit** — workspace-level resources shared by both:

| Resource | Type |
|---|---|
| Knowledge search (FAQs, pricing, policies) | Tool |
| Google Calendar (availability, events) | Tool |
| Learned communication preferences | Context (from learning loop) |
| Vertical fields / SOP | Context (appointment rules, custom fields) |
| Tone profile | Context (brand voice) |

**Per-client context** — isolated, never shared between workers:

| Resource | Loaded by |
|---|---|
| Client profile + notes | Context assembly (scoped by workspace_id + client_id) |
| Compact summary | Context assembly |
| Recent messages (~last 10) | Context assembly |
| Active bookings + follow-ups | Context assembly |

### 7.3 Agent tool inventory

| Tool | Purpose | Authority |
|---|---|---|
| `knowledge_search` | Search approved business knowledge | read |
| `calendar_query` | Check booking availability | read |
| `calendar_book` | Create confirmed booking | propose_write |
| `update_client_record` | Propose structured updates to client data | propose_write |
| `create_note` | Save internal note to client record | auto_write |
| `create_followup` | Log a follow-up or promise | propose_write |

All tools receive `workspaceId` and `clientId` as runtime-injected parameters that the LLM cannot override.

### 7.4 Behaviour guardrails

The agent must:
- Use structured client data before unstructured context.
- Use approved business knowledge before free-form inference.
- Distinguish between known and missing information.
- Avoid commitments that are not recorded or approved.
- Match workspace tone profile.
- Surface knowledge source attribution in drafts.

The agent must not:
- Present speculation as fact.
- Overwrite sensitive fields without review.
- Answer unsupported questions confidently.
- Mix one client's context with another's.
- Send any message without staff review.

---

## 8. Trust and action model

| Tier | Actions | Behaviour |
|---|---|---|
| **Auto-allowed** | Update last_contacted_at; append conversation summary; save AI-extracted note; attach low-risk tags; propose time slots (read-only) | Executes automatically. Audit logged. |
| **Suggest for review** | Change client name; change appointment details; add preference data; log promises with deadlines; modify lifecycle status; update sensitive notes; draft replies; propose follow-ups; create bookings | Proposes change. Staff sees confirmation card. Applied only after approval. |
| **Human-only** | Refunds; pricing changes; policy exceptions; negotiation; complaint handling; liability commitments | Flags and escalates. AI does not draft or propose. |

MVP trust model is fixed. All draft replies require staff review.

---

## 9. User flows

### 9.1 Client inbound conversation flow

1. Client sends WhatsApp message to business number.
2. Webhook received, enqueued to durable message queue.
3. Worker dequeues. Normalizes phone number. Matches or creates client record.
4. Context assembly runs (deterministic, no LLM): loads global toolkit (knowledge, vertical config, learned prefs, tone) + client-scoped data (profile, summary, messages, bookings, follow-ups).
5. Client Worker invoked (single LLM call with tools). Classifies intent, retrieves knowledge, checks calendar if booking-related, generates draft.
6. Draft saved. Staff notified (push + in-app badge).
7. Staff reviews, edits inline, sends. Or reprompts to regenerate.
8. Post-send: summary updated, message logged, notes/follow-ups recorded, learning signal captured. All actions audit-logged.

**Escalation:** Low confidence or human-only category → skip draft, flag for manual handling.

### 9.2 Booking flow

1. Booking intent classified.
2. Client Worker calls `calendar_query` for availability.
3. Draft proposes 2–4 valid slots (accounting for duration, buffers, provider).
4. Staff reviews and sends.
5. Client selects slot. System matches to proposed slot.
6. Confirmation draft generated. Staff reviews and sends.
7. Calendar event created. Booking written to client record.
8. If slots rejected: alternatives proposed. If silent: follow-up after timeout.

**Conflict handling:** Slots checked but not locked. Conflict detected at booking time → staff notified → alternatives proposed.

### 9.3 Staff note capture

1. Staff enters note in client thread. Saved immediately (no AI latency blocking).
2. Async: agent categorizes note (follow-up, preference update, promise).
3. If structured change implied: confirmation card shown.
4. Updated context available for next session.

### 9.4 Conversational context update

Staff updates via natural language (e.g., "update her preferred name to Liz"). System parses, shows confirmation card. Applied after staff confirms. Limited to predefined fields: name, phone, tags, preferences, notes, and vertical custom fields.

### 9.5 Handoff flow

When staff returns to a client thread: concise summary, recent messages, upcoming bookings, key notes, outstanding follow-ups, conversation state. Full context without rereading history.

### 9.6 Follow-up workflow

Daily cron (per workspace timezone). COS identifies clients needing follow-up: stale threads, unconfirmed appointments, pending promises. COS ranks by priority. Client Workers generate follow-up drafts (with full per-client context). Staff reviews and sends through normal inbox.

### 9.7 Appointment confirmation and no-show flow

Before appointment day: confirmation draft for staff to send. If unconfirmed: flagged at-risk. Staff decides action. MVP supports reminders and confirmation — not automated cancellation.

---

## 10. Functional requirements

### 10.1 Messaging

- Receive inbound WhatsApp messages via WhatsApp Web protocol (QR code paired session).
- Enqueue to durable message queue for ordered, deduplicated processing.
- Store raw inbound and outbound messages.
- Associate each message with a client record.
- Display conversation history chronologically.
- AI reply drafting for routine conversations.
- Handle delivery failures and retries.
- Manage WhatsApp Web session persistence and re-authentication (QR code re-scan when session expires).
- Import existing conversation history from connected WhatsApp account for context bootstrapping.

### 10.2 Media handling

| Tier | Types | Behaviour |
|---|---|---|
| AI-processed | Images, voice notes (transcribed) | Passed to multimodal LLM. Transcriptions stored alongside media. |
| Staff-visible only | Documents (PDFs), videos | Stored and displayed. Not processed by AI. |
| Acknowledged | Location pins, contacts, stickers | Stored as reference. AI acknowledges in draft. |

Voice note transcription happens before context assembly in the worker pipeline.

### 10.3 Client identity

- Find client by exact normalized phone number.
- Create new client if no match.
- Manual merge of duplicate records by staff.
- On merge: all related records transfer to target. Source soft-deleted.
- Persistent unique identity per workspace.

### 10.4 Scheduling

- Read availability from Google Calendar (MVP: single calendar via OAuth).
- Return valid slots accounting for appointment type duration, buffers, provider.
- Create confirmed event after staff approval.
- Write booking to client record.
- Show upcoming bookings per client.
- Detect conflicts at confirmation time and propose alternatives.
- All times UTC with workspace timezone reference.

### 10.5 Notes and follow-ups

- Immediate-save notes (no AI blocking).
- Promise and follow-up logging with optional due dates.
- Status: open, completed, pending, overdue.
- All visible in client context.
- Daily cron surfaces stale follow-ups.

### 10.6 Business knowledge management

- Markdown/plain text: pricing, FAQs, services, policies.
- Initialized from Instagram scraping during onboarding.
- Staff can upload additional documents at any time (PDFs, service menus, etc.).
- Chunked and embedded for semantic search (pgvector).
- Source attribution in AI drafts.
- Editable in settings page.

### 10.7 Notifications

- Push notification on new inbound message.
- In-app badge for unread/unreviewed conversations.
- MVP: all notifications to workspace operator.
- Post-MVP: routing based on assignment.

---

## 11. Vertical configuration layer

### 11.1 What a vertical configuration contains

```typescript
type VerticalConfig = {
  customFields: Array<{
    key: string;            // e.g., "chest_inches", "hair_type"
    label: string;
    type: "string" | "number" | "date" | "boolean" | "enum";
    enumValues?: string[];
    required: boolean;
    group?: string;         // UI grouping
  }>;

  appointmentTypes: Array<{
    key: string;            // e.g., "first_fitting"
    label: string;
    durationMinutes: number;
    bufferMinutes: number;
    prerequisite?: string;  // key of required prior appointment
  }>;

  lifecycleStages?: Array<{
    key: string;
    label: string;
    description: string;
  }>;

  sopRules?: string[];      // injected into agent system prompt

  knowledgeBaseTemplate?: string;  // guides knowledge entry during onboarding
};
```

### 11.2 How vertical config is used

- **Context assembly:** loaded from workspace record, included in global section of every Client Worker call.
- **Staff app:** custom fields render dynamically in client profile. Appointment picker shows configured types.
- **Booking logic:** durations and buffers from config.
- **Agent prompts:** SOP rules injected into system prompt.
- **Onboarding:** generated via deep research of the vertical, refined conversationally by the owner.

### 11.3 Stored in Supabase

Vertical config is stored in the `workspace.vertical_config` JSON column. Custom field values are stored in `client.preferences` JSON column keyed by `customFields[].key`. No schema changes per vertical — the same tables and columns serve every industry.

---

## 12. Data model (universal Supabase schema)

This schema is deployed identically for every client. It stores everything needed to run the platform across any industry. Vertical-specific data lives inside JSON columns (`vertical_config`, `preferences`), not dedicated tables.

### 12.1 Workspace

| Field | Type | Description |
|---|---|---|
| `workspace_id` | UUID | Primary key |
| `business_name` | String | Display name |
| `vertical_type` | String | Industry identifier (e.g., "bespoke_tailor", "salon") |
| `timezone` | String | IANA timezone |
| `business_hours` | JSON | Operating hours by day of week |
| `tone_profile` | Text | Tone and brand configuration for AI drafts |
| `knowledge_base` | Text | Business knowledge content (markdown) |
| `vertical_config` | JSON | Vertical-specific config (§11) |
| `communication_profile` | JSON | Learned communication rules from learning loop |
| `instagram_handle` | String (nullable) | Source for knowledge init |
| `whatsapp_config` | JSON | WhatsApp Web session credentials, connection status, last QR scan timestamp |
| `calendar_config` | JSON (nullable) | Google Calendar OAuth tokens, calendar ID (null until connected) |
| `onboarding_status` | Enum | `pending`, `instagram_scraped`, `sop_configured`, `tone_set`, `calendar_connected`, `complete` |
| `created_at` | Timestamp | |

### 12.2 Staff / User

| Field | Type | Description |
|---|---|---|
| `staff_id` | UUID | Primary key |
| `workspace_id` | UUID | FK |
| `full_name` | String | |
| `email` | String | Login email |
| `phone_number` | String | WhatsApp number for this staff member |
| `role` | Enum | `owner`, `operator` |
| `created_at` | Timestamp | |

### 12.3 Client

| Field | Type | Description |
|---|---|---|
| `client_id` | UUID | Primary key |
| `workspace_id` | UUID | FK |
| `full_name` | String | |
| `phone_number` | String | Normalized E.164 |
| `email` | String (nullable) | |
| `lifecycle_status` | Enum | `open`, `chosen_service`, `upcoming_appointment`, `follow_up`, `review_complete`, `inactive` |
| `tags` | Array\<String\> | |
| `preferences` | JSON | Client preferences + all vertical custom field values |
| `last_contacted_at` | Timestamp | |
| `summary` | Text | Current compact summary (latest version) |
| `created_at` | Timestamp | |
| `updated_at` | Timestamp | |
| `deleted_at` | Timestamp (nullable) | Soft delete for merged records |

### 12.4 Conversation

| Field | Type | Description |
|---|---|---|
| `conversation_id` | UUID | Primary key |
| `client_id` | UUID | FK |
| `channel` | Enum | `whatsapp` (extensible) |
| `state` | Enum | `idle`, `booking_in_progress`, `awaiting_client_reply`, `awaiting_staff_review`, `follow_up_pending`, `payment_pending` |
| `version` | Integer | Optimistic locking |
| `last_message_at` | Timestamp | |
| `last_client_message_at` | Timestamp | WhatsApp 24h window tracking |

### 12.5 Message

| Field | Type | Description |
|---|---|---|
| `message_id` | UUID | Primary key |
| `conversation_id` | UUID | FK |
| `direction` | Enum | `inbound`, `outbound` |
| `content` | Text | Message text |
| `media_type` | Enum (nullable) | `image`, `voice_note`, `document`, `video`, `location`, `contact`, `sticker` |
| `media_url` | String (nullable) | Storage path |
| `media_transcription` | Text (nullable) | Voice note transcription |
| `timestamp` | Timestamp | |
| `sender_type` | Enum | `client`, `staff`, `system` |
| `delivery_status` | Enum | `sent`, `delivered`, `read`, `failed` |
| `draft_id` | UUID (nullable) | FK to Draft |

### 12.6 Draft

| Field | Type | Description |
|---|---|---|
| `draft_id` | UUID | Primary key |
| `conversation_id` | UUID | FK |
| `content` | Text | Full draft text |
| `intent_classified` | String | Intent label |
| `confidence_score` | Float | |
| `knowledge_sources_used` | Array\<String\> | |
| `staff_action` | Enum | `sent_as_is`, `edited_and_sent`, `regenerated`, `discarded` |
| `edited_content` | Text (nullable) | Final text if staff edited |
| `created_at` | Timestamp | |
| `reviewed_at` | Timestamp (nullable) | |
| `reviewed_by` | UUID (nullable) | Staff ID |

### 12.7 Booking

| Field | Type | Description |
|---|---|---|
| `booking_id` | UUID | Primary key |
| `client_id` | UUID | FK |
| `workspace_id` | UUID | FK |
| `provider_id` | UUID (nullable) | Staff/provider |
| `appointment_type` | String | Key from vertical_config.appointmentTypes |
| `start_time` | Timestamp (UTC) | |
| `end_time` | Timestamp (UTC) | |
| `calendar_event_id` | String (nullable) | Google Calendar event ID |
| `status` | Enum | `confirmed`, `at_risk`, `cancelled`, `completed`, `no_show` |
| `confirmation_status` | Enum | `pending`, `confirmed`, `unconfirmed` |
| `notes` | Text (nullable) | |
| `created_at` | Timestamp | |

### 12.8 Note

| Field | Type | Description |
|---|---|---|
| `note_id` | UUID | Primary key |
| `client_id` | UUID | FK |
| `content` | Text | |
| `source` | Enum | `staff_manual`, `ai_extracted`, `conversation_update`, `merge_history` |
| `created_by` | UUID | Staff or system |
| `created_at` | Timestamp | |

### 12.9 Follow-up / Promise

| Field | Type | Description |
|---|---|---|
| `followup_id` | UUID | Primary key |
| `client_id` | UUID | FK |
| `type` | Enum | `follow_up`, `promise`, `reminder` |
| `content` | Text | |
| `due_date` | Date (nullable) | |
| `status` | Enum | `open`, `completed`, `pending`, `overdue` |
| `created_by` | UUID | |
| `created_at` | Timestamp | |

### 12.10 Memory

| Field | Type | Description |
|---|---|---|
| `memory_id` | UUID | Primary key |
| `client_id` | UUID | FK |
| `type` | Enum | `daily_log`, `compact_summary` |
| `content` | Text | |
| `version` | Integer | For compact_summary versioning |
| `date` | Date | Date this memory covers |
| `created_at` | Timestamp | |

### 12.11 Knowledge chunk

| Field | Type | Description |
|---|---|---|
| `chunk_id` | UUID | Primary key |
| `workspace_id` | UUID | FK |
| `content` | Text | Chunk text |
| `source` | Enum | `instagram_scrape`, `manual_upload`, `settings_editor` |
| `source_ref` | String (nullable) | e.g., Instagram post URL, uploaded filename |
| `embedding` | vector(1536) | pgvector embedding |
| `created_at` | Timestamp | |
| `updated_at` | Timestamp | |

### 12.12 Message template

| Field | Type | Description |
|---|---|---|
| `template_id` | UUID | Primary key |
| `workspace_id` | UUID | FK |
| `category` | Enum | `confirmation`, `reminder`, `follow_up`, `payment`, `general` |
| `name` | String | Template identifier |
| `content` | Text | Body with variable placeholders |
| `whatsapp_template_id` | String (nullable) | Meta-approved ID |
| `status` | Enum | `draft`, `submitted`, `approved`, `rejected` |
| `created_at` | Timestamp | |

### 12.13 Audit event

| Field | Type | Description |
|---|---|---|
| `event_id` | UUID | Primary key |
| `workspace_id` | UUID | FK |
| `actor_type` | Enum | `ai`, `staff`, `system` |
| `actor_id` | UUID (nullable) | |
| `action_type` | String | See audit action types below |
| `target_entity` | String | Entity type affected |
| `target_id` | UUID | |
| `metadata` | JSON | Before/after state, session key, etc. |
| `timestamp` | Timestamp | |

Audit action types: `draft_generated`, `message_sent`, `client_updated`, `booking_created`, `booking_cancelled`, `note_added`, `followup_created`, `followup_completed`, `draft_regenerated`, `client_merged`, `knowledge_updated`, `sop_updated`.

### 12.14 Learning signal

| Field | Type | Description |
|---|---|---|
| `signal_id` | UUID | Primary key |
| `workspace_id` | UUID | FK |
| `client_id` | UUID | FK |
| `draft_id` | UUID | FK |
| `staff_action` | Enum | `sent_as_is`, `edited_and_sent`, `regenerated`, `discarded` |
| `original_draft` | Text | |
| `final_version` | Text (nullable) | |
| `intent_classified` | String | |
| `scenario_type` | String | |
| `edit_categories` | Array\<String\> (nullable) | Filled by Phase 4 analysis |
| `pattern_key` | String (nullable) | Stable key for recurrence tracking |
| `created_at` | Timestamp | |
| `client_replied` | Boolean (nullable) | |
| `client_reply_latency_minutes` | Integer (nullable) | |

### 12.15 Communication rule (learned)

| Field | Type | Description |
|---|---|---|
| `rule_id` | UUID | Primary key |
| `workspace_id` | UUID | FK |
| `category` | String | Edit category that triggered this |
| `instruction` | Text | The rule (e.g., "Keep replies under 3 sentences") |
| `confidence` | Float | Based on recurrence count |
| `source_pattern_key` | String | |
| `recurrence_count` | Integer | |
| `active` | Boolean | Staff can disable |
| `promoted_at` | Timestamp | |

---

## 13. Session and context management

### 13.1 Session isolation

Each client conversation is isolated. No conversational memory shared across clients. Session key: `workspace:{workspace_id}:client:{client_id}`. Context assembly is a deterministic function run before the LLM — the agent cannot influence what data it receives.

### 13.2 Context window composition

**Global (workspace-level, same for every client worker):**
- Workspace config (timezone, business hours, tone profile)
- Vertical config / SOP rules
- Learned communication preferences
- Knowledge chunks (semantic search on inbound message)

**Client-scoped (isolation boundary):**
- Client profile + vertical custom field values
- Latest compact summary
- Recent messages (~last 10)
- Active bookings and follow-ups
- Recent notes
- Conversation state
- Inbound message

### 13.3 Isolation enforcement

Level 1: every database query scoped by `workspace_id + client_id`.
Level 2: tool parameters (`workspaceId`, `clientId`) injected by runtime, not LLM.
Level 3: every action audit-logged with session key.

### 13.4 Concurrency

Optimistic locking on Conversation (`version` field). BullMQ processes messages for same client sequentially (session key as queue group).

### 13.5 Compaction

Daily cron per workspace timezone. For each client with activity since last compaction: ensure async extractions complete (flush-before-compact), generate updated compact summary via LLM, write new Memory record.

### 13.6 Client lifecycle status

| Status | Description |
|---|---|
| `open` | New or active, no service selected |
| `chosen_service` | Service selected, not yet booked |
| `upcoming_appointment` | Confirmed booking exists |
| `follow_up` | Appointment completed, follow-up pending |
| `review_complete` | Follow-up cycle complete |
| `inactive` | No interaction for configurable period (default: 30 days) |

Vertical configs can override labels.

### 13.7 Conversation state machine

| State | Trigger | Timeout |
|---|---|---|
| `idle` | Resolved | — |
| `booking_in_progress` | Booking intent | 24h → follow_up_pending |
| `awaiting_client_reply` | Staff sent message | 24h (configurable) → follow_up_pending |
| `awaiting_staff_review` | Draft ready | 1h → re-send notification |
| `follow_up_pending` | Timeout or cron | Daily cron generates follow-up draft |
| `payment_pending` | Payment identified | Manual |

---

## 14. Integrations

### 14.1 WhatsApp (QR Code Web Login)

Integration via WhatsApp Web protocol (QR code pairing, similar to OpenClaw). Owner scans a QR code to connect their existing WhatsApp account. The system gains full access to existing conversations, contacts, and message history. No separate business number or WABA (WhatsApp Business API) application required. Uses a WhatsApp Web protocol library (e.g., Baileys/whatsapp-web.js). Media processing. Session persistence via stored credentials with periodic re-authentication.

### 14.2 Google Calendar

MVP: single calendar per workspace via OAuth. Connected during onboarding when owner is ready (system works without it). Availability lookup, event creation, booking visibility. All times UTC.

### 14.3 Instagram (onboarding only)

Public profile scraping to bootstrap knowledge base. One-time at onboarding. Bio, post captions, highlights, link in bio. Output is draft knowledge base for owner review.

### 14.4 Notion (optional export)

Optional daily cron sync. Visibility layer only, not relied upon for integrity.

---

## 15. Onboarding flow

### 15.1 Design philosophy

WhatsApp-first, low-friction. QR code scan connects the owner's existing WhatsApp. Knowledge base bootstrapped from Instagram. SOP generated via deep research. Google Calendar connected later. Everything is an initialization approach — owner can edit and upload more at any time.

### 15.2 Sequence

**Step 1: WhatsApp QR code connection.** Owner scans a QR code in the staff app to connect their existing WhatsApp account. Workspace created. System gains access to the owner's full WhatsApp — existing conversations, contacts, and history.

**Step 2: Business identity.** Business name, vertical type, Instagram handle, location/timezone. Conversational or via staff app form.

**Step 3: Knowledge base from Instagram.** System scrapes public Instagram (bio, posts, highlights, link in bio). Produces draft knowledge base (markdown). Owner reviews and edits. Additional documents can be uploaded anytime via settings.

**Step 4: SOP via deep research.** Based on vertical type, system researches standard operating procedures for that industry. Generates draft: appointment types with durations/sequencing, client lifecycle stages, follow-up triggers, custom fields, knowledge gaps. Owner refines conversationally ("our fittings are 45 min, not 60", "add a rush order type"). Stored as `vertical_config`.

**Step 5: Tone profile.** Proposed from Instagram analysis. Owner adjusts.

**Step 6: Google Calendar (deferred).** Connected via OAuth when ready. Booking flows activate at connection.

**Step 7: First real client message.** System live. Full pipeline runs.

### 15.3 Progressive enhancement

| Connected | Capabilities |
|---|---|
| WhatsApp (QR paired) | Messages, client identity, existing conversation history import |
| + Instagram scraped | Knowledge-grounded drafts |
| + SOP configured | Vertical-aware drafting, appointment types |
| + Tone set | Brand-voice drafts |
| + Calendar | Full booking flow |
| + Learning loop data | Progressively better drafts |

---

## 16. Staff app and UX requirements

### 16.1 Overview

Mobile-first responsive web. Conversation-centric, inbox-centric. PWA-capable.

### 16.2 Core surfaces

| Surface | Contents |
|---|---|
| **Inbox** | Conversations by recency/priority. Unread badges. Filter by state. |
| **Client thread** | History. AI draft panel. Client snapshot sidebar (profile, lifecycle, bookings, notes, follow-ups, vertical custom fields). |
| **Draft review** | Draft with edit-in-place. Send. Reprompt field. Knowledge attribution. |
| **Today's view** | Today's appointments. Pending follow-ups. At-risk bookings. |
| **Client profile** | Full record. History. Bookings. Notes. Follow-ups. Custom fields. |
| **Settings** | Knowledge editor + document upload. Tone config. SOP editor (conversational). Calendar connection. WhatsApp config. Learned rules (view/toggle). |

### 16.3 Latency targets

| Operation | Target |
|---|---|
| New message notification | < 5 seconds |
| Context loading | < 2 seconds |
| AI draft generation | < 5 minutes (internal SLA) |
| Note save | < 1 second |

---

## 17. Learning loop

### 17.1 Signal capture (Phase 2)

Every staff action on a draft recorded immediately: original draft, final version, staff action, intent, scenario type. No LLM needed — structured database write.

### 17.2 Diff classification (Phase 4)

Async LLM classifies edit types: tone (softened, warmed, formalized), content (assumption removed, fact corrected, personalization added), style (CTA adjusted, scheduling options added, upsell removed). Each classification gets a stable `patternKey`.

### 17.3 Recurrence and promotion

Pattern meets threshold (3+ occurrences, 2+ clients, 30-day window) → promoted to CommunicationRule → injected into global context for all future drafts. Staff can view, edit, disable in Settings.

### 17.4 Phases

| Phase | Ships |
|---|---|
| Phase 2 | Signal recording. Raw data. |
| Phase 3 | Acceptance rate metrics. |
| Phase 4 | Diff analysis. Recurrence. Rule promotion. Settings UI. |
| Post-MVP | Scenario-specific rules. Quality feedback. |

---

## 18. Security, privacy, and operations

### 18.1 Security baseline

- Encrypted in transit (TLS) and at rest.
- Tenant isolation by `workspace_id` at application and query level.
- Staff access restricted to own workspace.
- Audit logging for all mutations.
- OAuth tokens and credentials stored encrypted.

### 18.2 Backup

Managed Supabase with automated daily snapshots and point-in-time recovery.

### 18.3 Error handling

| Failure | Behaviour |
|---|---|
| Calendar API | Booking paused. Messaging continues. |
| LLM API | Manual responses. Drafts queued for retry. |
| Webhooks | Retry with exponential backoff. |
| Database | Degraded state. Recovery from backups. |

### 18.4 Rate limiting

- Max 20 messages/minute per sender.
- Block/mute for spam.
- Soft limit: 5 regenerations per thread.

### 18.5 Pipeline

`Webhook → BullMQ → worker → agent → draft → notification`

Ordering, deduplication, no message loss.

---

## 19. Success metrics

### 19.1 Primary

| Metric | Target | Measurement |
|---|---|---|
| Median draft prep time | < 5 min | Webhook → draft ready |
| Booking conversion | Tracked day 1 | Bookings / booking-intent conversations |
| Time to book | < 3 min staff time | Intent → calendar event |
| Usable summary rate | > 80% | Non-empty summary / total conversations |
| Follow-up capture | > 85% | Records / signals detected |
| Draft acceptance rate | Tracked day 1 | sent_as_is + minor_edit / total |

### 19.2 Pilot outcomes

| Metric | Measurement |
|---|---|
| Bookings recovered | Bookings preceded by follow_up_pending state |
| No-shows prevented | Confirmed after reminder vs. baseline |
| Staff time saved | Self-reported weekly |

### 19.3 Business-level

- Active at 30/60/90 days.
- Time to first value (onboarding → first AI draft).
- NPS.

---

## 20. Risks and mitigations

| Category | Risk | Mitigation |
|---|---|---|
| Product | Too broad | Strict MVP scope. Anchor to pilot vertical. |
| Product | AI drafts not good enough | Staff edit/regenerate. Track acceptance. Iterate. Learning loop. |
| Product | Staff don't capture notes | One-tap. Conversational updates. Cron surfaces missed items. |
| Product | "Another CRM" resistance | Position as copilot. Minimal setup. Immediate value. |
| Technical | Identity errors | Exact phone match. Manual merge. No fuzzy. |
| Technical | Scheduling naive | Vertical config: types, durations, buffers, sequences. Conflicts. |
| Technical | Sources of truth conflict | Hierarchy: structured > summary > raw. Knowledge authoritative. |
| Technical | LLM cost | Per-message tracking. Regeneration limits. |
| Technical | Instagram scrape unreliable | Fallback to manual knowledge entry. Scrape is convenience, not dependency. |
| Trust | Incorrect info | Staff review. Knowledge attribution. Confidence scoring. |
| Trust | Robotic tone | Tone profile. Edits. Reprompt. Learning loop. |
| Trust | Sensitive data | Three-tier model. Confirmation cards. Audit. |
| Platform | WhatsApp Web session instability | Session persistence with stored creds. Re-auth flow with QR re-scan. |
| Platform | WhatsApp protocol changes | Pin library version. Monitor upstream for breaking changes. |

---

## 21. Function list

Every function the system performs, mapped to its MVP phase, the user flow it supports, and whether it requires an LLM call.

### 21.1 Onboarding functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| ON-01 | WhatsApp QR code workspace creation | 1 | No | Owner scans QR code to connect WhatsApp account, workspace record created |
| ON-02 | Business identity capture | 1 | No | Collect name, vertical, Instagram handle, timezone |
| ON-03 | Instagram scrape → draft knowledge base | 1 | Yes | Scrape public profile, extract content, generate markdown KB |
| ON-04 | Deep research SOP generation | 1 | Yes | Research vertical SOPs, generate appointment types, custom fields, rules |
| ON-05 | Conversational SOP editing | 1 | Yes | Owner prompts edits to SOP; system parses and updates vertical_config |
| ON-06 | Tone profile extraction | 1 | Yes | Analyze Instagram content for tone, propose profile |
| ON-07 | Google Calendar OAuth connection | 2 | No | OAuth flow to connect calendar. Booking features activate. |
| ON-08 | Document upload to knowledge base | 2 | No | Staff uploads PDFs, menus, etc. System chunks and embeds. |

### 21.2 Message processing functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| MP-01 | Message receipt and queue enqueue | 1 | No | Receive WhatsApp Web protocol messages, deduplicate, enqueue to BullMQ |
| MP-02 | Phone number normalization | 1 | No | Normalize to E.164 format |
| MP-03 | Client find-or-create | 1 | No | Exact phone match or create new record |
| MP-04 | Voice note transcription | 2 | Yes | Transcribe before context assembly |
| MP-05 | Image processing for context | 2 | Yes | Pass to multimodal LLM within Client Worker |
| MP-06 | WhatsApp session health check | 1 | No | Verify WhatsApp Web session is active before sending; prompt QR re-scan if expired |
| MP-07 | Conversation history import | 1 | No | Import existing WhatsApp conversation history for context bootstrapping on first connection |
| MP-08 | Delivery status tracking | 1 | No | Track sent/delivered/read/failed via WhatsApp Web protocol events |
| MP-09 | Message storage | 1 | No | Store inbound and outbound messages in Message table |

### 21.3 Context and session functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| CS-01 | Session key resolution | 1 | No | Resolve workspace:{id}:client:{id} from inbound message |
| CS-02 | Context assembly (global) | 2 | No | Load workspace config, vertical config, learned prefs, tone |
| CS-03 | Context assembly (client-scoped) | 2 | No | Load profile, summary, messages, bookings, follow-ups, notes |
| CS-04 | Knowledge semantic search | 2 | No | pgvector search on inbound message against knowledge chunks |
| CS-05 | Daily memory compaction | 3 | Yes | Summarize recent messages into compact_summary |
| CS-06 | Flush-before-compact check | 3 | No | Ensure async extractions complete before compacting |

### 21.4 AI drafting functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| AD-01 | Client Worker invocation | 2 | Yes | Single LLM call with assembled context + tools |
| AD-02 | Intent classification | 2 | Yes | Classify intent (within Client Worker tool loop) |
| AD-03 | Draft generation | 2 | Yes | Generate reply draft (Client Worker output) |
| AD-04 | Confidence-based escalation | 2 | No | Skip draft if low confidence or human-only category |
| AD-05 | Draft storage | 2 | No | Save draft with intent, confidence, knowledge sources |
| AD-06 | Reprompt / regeneration | 2 | Yes | New LLM call with staff instruction appended |
| AD-07 | Knowledge source attribution | 2 | No | Attach source references to draft for staff verification |

### 21.5 Booking functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| BK-01 | Calendar availability query | 2 | No | Query Google Calendar for available slots |
| BK-02 | Slot proposal in draft | 2 | Yes | Client Worker proposes 2–4 slots in draft |
| BK-03 | Slot matching from client reply | 2 | Yes | Match client selection to proposed slot |
| BK-04 | Booking confirmation draft | 2 | Yes | Generate confirmation message |
| BK-05 | Calendar event creation | 2 | No | Create Google Calendar event after staff approval |
| BK-06 | Booking record creation | 2 | No | Write to Booking table with all details |
| BK-07 | Conflict detection | 2 | No | Check for conflicts at confirmation time |
| BK-08 | Alternative slot proposal | 2 | Yes | Propose new slots when original rejected or conflicted |
| BK-09 | Appointment type validation | 2 | No | Check prerequisite rules from vertical_config |

### 21.6 Notes and follow-up functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| NF-01 | Immediate note save | 2 | No | Staff saves note, instant write to Note table |
| NF-02 | Async note categorization | 3 | Yes | AI parses note for follow-ups, preference updates, promises |
| NF-03 | Structured change proposal | 3 | No | Show confirmation card if note implies data change |
| NF-04 | Conversational context update | 3 | Yes | Parse "update her name to Liz" → confirmation card |
| NF-05 | Follow-up creation | 2 | No | Write follow-up record with optional due date |
| NF-06 | Follow-up status update | 2 | No | Mark open/completed/pending/overdue |
| NF-07 | Daily follow-up surfacing (COS) | 3 | Yes | COS identifies overdue items, ranks, queues Client Worker drafts |
| NF-08 | Promise tracking | 3 | Yes | AI extracts promises from conversations, creates follow-up records |

### 21.7 COS operations functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| CO-01 | Daily cron trigger | 3 | No | Run at workspace timezone each day |
| CO-02 | Stale conversation detection | 3 | No | Query conversations past timeout thresholds |
| CO-03 | Unconfirmed booking detection | 3 | No | Query bookings with pending confirmation |
| CO-04 | Priority ranking | 3 | Yes | COS ranks action list by urgency |
| CO-05 | Follow-up draft dispatch | 3 | No | Queue Client Worker invocations per client |
| CO-06 | Today's view generation | 3 | No | Aggregate today's bookings, follow-ups, at-risk items |
| CO-07 | Confirmation reminder draft | 3 | No | Queue Client Worker for pre-appointment confirmation |

### 21.8 Approval and governance functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| AG-01 | Approval policy evaluation | 2 | No | Classify ProposedAction → auto/review/human-only |
| AG-02 | Confirmation card creation | 2 | No | Generate staff-facing confirmation UI for review-tier actions |
| AG-03 | Staff approval processing | 2 | No | Execute action after staff confirms |
| AG-04 | Staff rejection processing | 2 | No | Mark ProposedAction rejected, log audit |
| AG-05 | Human-only escalation | 2 | No | Flag conversation for manual handling |
| AG-06 | Audit event logging | 1 | No | Log every mutation with actor, action, before/after |
| AG-07 | Tool parameter injection | 2 | No | Inject workspaceId/clientId into tool calls |

### 21.9 Learning loop functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| LL-01 | Draft edit signal recording | 2 | No | Save original draft + final version + action at send time |
| LL-02 | Draft acceptance rate calculation | 3 | No | Aggregate sent_as_is / edited / discarded counts |
| LL-03 | Diff classification | 4 | Yes | LLM classifies edit type (tone, content, style categories) |
| LL-04 | Pattern key assignment | 4 | Yes | Assign stable pattern key for recurrence tracking |
| LL-05 | Recurrence count update | 4 | No | Increment count, update distinct_clients |
| LL-06 | Promotion threshold check | 4 | No | 3+ occurrences, 2+ clients, 30-day window |
| LL-07 | Communication rule creation | 4 | No | Create rule from promoted pattern |
| LL-08 | Rule injection into context | 4 | No | Include active rules in global context assembly |
| LL-09 | Client reply tracking | 3 | No | Record whether client replied, latency |

### 21.10 Client identity functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| CI-01 | Phone number matching | 1 | No | Exact E.164 match against Client table |
| CI-02 | New client creation | 1 | No | Create record with phone number |
| CI-03 | Client merge | 2 | No | Staff-initiated. Transfer all records. Soft-delete source. |
| CI-04 | Merge history note | 2 | No | Append historical notes from source record |

### 21.11 Notification functions

| ID | Function | Phase | LLM | Description |
|---|---|---|---|---|
| NT-01 | Push notification on inbound | 1 | No | Push to staff after webhook receipt |
| NT-02 | In-app badge update | 1 | No | Unread/unreviewed count |
| NT-03 | Draft ready notification | 2 | No | Notify staff that draft is ready for review |
| NT-04 | Escalation re-notification | 2 | No | Re-send if staff hasn't reviewed within 1h |

---

## 22. MVP release strategy

### Week 0: Parallel track

| Activity | Why now |
|---|---|
| Set up WhatsApp Web protocol library (Baileys/whatsapp-web.js) | Foundation for all messaging |
| Test QR code pairing flow and session persistence | Critical path for onboarding |
| Build Instagram scraping pipeline | Knowledge init at onboarding |
| Research SOPs for pilot vertical | Feed deep research agent |

### Phase 1: Core messaging and onboarding

Functions: ON-01 through ON-06, MP-01 through MP-03, MP-06 through MP-09, CS-01, CI-01, CI-02, NT-01, NT-02, AG-06. (MP-06 = session health check, MP-07 = history import.)

### Phase 2: AI drafting and booking

Functions: ON-07, ON-08, MP-04, MP-05, CS-02 through CS-04, AD-01 through AD-07, BK-01 through BK-09, NF-01, NF-05, NF-06, AG-01 through AG-05, AG-07, LL-01, CI-03, CI-04, NT-03, NT-04.

### Phase 3: Operational memory and follow-ups

Functions: CS-05, CS-06, NF-02 through NF-04, NF-07, NF-08, CO-01 through CO-07, LL-02, LL-09.

### Phase 4: Refinement and learning

Functions: LL-03 through LL-08.

---

## 23. Future roadmap

- Multi-staff accounts with RBAC and conversation routing.
- Multi-channel (Instagram DM, SMS, email).
- Cross-timezone support.
- Conditional auto-send for earned routine interactions.
- Stronger identity resolution across channels.
- Additional vertical templates.
- Advanced analytics.
- GDPR/LGPD consent management.
- Multiple calendars per workspace.
- Scenario-specific drafting rules.
- Draft quality feedback (thumbs up/down).
- Knowledge version history.

---

## 24. Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| AI role | Staff-assistive, not autonomous | De-risks trust, compliance, quality. |
| Agent architecture | Single agent + tools (Client Worker). COS separate. | Simpler, cheaper, debuggable. |
| WhatsApp | QR code Web protocol (like OpenClaw) | Access owner's existing WhatsApp — full history, contacts, no WABA needed. |
| Staff app | Mobile-first responsive web | Real operational tool. |
| MVP accounts | Single operator per workspace | Simplifies everything. |
| Session isolation | DB-scoped (workspace_id + client_id) | Multi-tenant safe. |
| Memory | Daily scheduled compaction | Simpler than reactive. |
| Trust | Three-tier (auto/review/human-only) | Conservative default. |
| Learning | Self-improving-agent pattern | Structured signals, recurrence, promotion. |
| Verticals | JSON configuration, not code | New client = new config. |
| Knowledge | Instagram init + pgvector search | Low-friction onboarding. |
| Schema | Universal Supabase, vertical in JSON columns | Same migration every client. |
| SOP | Deep research + conversational editing | Informed starting point, owner refinement. |

---

## 25. Open questions

| # | Question |
|---|---|
| 1 | LLM provider and model selection (multimodal required) |
| 2 | Embedding model for pgvector |
| 3 | Hosting/deployment model |
| 4 | Per-message cost estimate |
| 5 | Instagram scraping: public API vs. scraping, rate limits, compliance |
| 6 | Deep research agent: model and cost for one-time SOP generation |
| 7 | WhatsApp Web session stability at scale (multiple connected workspaces) |
| 8 | Vertical migration (client switching from one config to another) |
| 9 | Knowledge chunk update strategy (re-embed on edit vs. incremental) |