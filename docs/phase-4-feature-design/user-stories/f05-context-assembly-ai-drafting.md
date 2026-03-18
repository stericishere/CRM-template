# User Stories — F-05: Context Assembly & AI Draft Generation

**Feature:** F-05 Context Assembly & AI Draft Generation
**Phase:** 2 (AI Drafting & Booking)
**Size:** XL
**PRD Functions:** CS-02, CS-03, CS-04, AD-01, AD-02, AD-03, AD-04, AD-05, AD-06, AD-07
**Architecture Module:** conversation (GenerateReplyDraft, RegenerateDraft), workspace-knowledge (SearchKnowledge), client-relationship (AssembleClientContext), agent/ClientWorkerRuntime, agent/ContextAssembler
**ADR Dependencies:** ADR-1 (single agent with tools), ADR-2 (context assembly is DB queries), ADR-3 (fixed token budget, no reactive compaction)

---

## Context

This is the core product feature. When a client sends a WhatsApp message, the system must assemble a complete, read-only context window and invoke a single LLM call (the Client Worker) to classify intent, search knowledge, and generate a draft reply for staff review. The feature spans three bounded contexts: context assembly (deterministic code), knowledge retrieval (pgvector semantic search), and the Client Worker runtime (LLM invocation with tool loop).

**Context assembly is not an LLM operation.** It is a pure function `(workspaceId, clientId) -> ReadOnlyContext` executed before the LLM is invoked. The agent cannot influence what data it receives.

**Key architectural constraints:**
- Context is assembled in a fixed order with explicit per-section token budgets totaling ~12,000 tokens per invocation (architecture 3.3).
- Global sections (workspace config, vertical config, learned preferences, knowledge chunks) are the same for every client worker within a workspace and can be cached.
- Client-scoped sections (profile, compact summary, messages, bookings, follow-ups, notes) are assembled fresh per invocation and form the isolation boundary.
- The Client Worker is a single LLM API call with tool-calling capability. Tools return `ProposedAction` objects; they never commit writes directly (architecture 1.1 core rule).
- Tool parameters `workspaceId` and `clientId` are runtime-injected; the LLM cannot override them (architecture 4.4).
- Low confidence or human-only intent classification skips draft generation entirely.
- Reprompting creates a new LLM call with the staff instruction appended; it does not modify the original call.

**Prerequisite features:** F-02 (Message Pipeline), F-03 (Client Identity). F-01 (Workspace Onboarding) must have completed to populate workspace config, vertical config, and knowledge base.

---

## Stories

### F05-S01: Global Context Assembly

**Function:** CS-02

> **As a** system processing an inbound client message,
> **I want** the workspace-level context (workspace config, vertical config, learned communication preferences, and tone profile) assembled deterministically before the LLM is invoked,
> **so that** every Client Worker call receives the same business rules, SOP, and brand voice regardless of which client it is serving.

**Acceptance Criteria:**

```gherkin
Feature: Global context assembly

  Scenario: Workspace config loaded into context
    Given workspace "ws-abc" has timezone "Australia/Sydney", business_hours, and booking_rules configured
    And workspace "ws-abc" has tone_profile "professional, warm, concise"
    When context assembly runs for any client in workspace "ws-abc"
    Then the assembled context includes the full workspace config
    And the tone_profile is included in the system prompt section
    And the token usage for the system prompt section does not exceed ~1,500 tokens

  Scenario: Vertical config and SOP rules loaded
    Given workspace "ws-abc" has vertical_config with:
      | field            | value                                          |
      | customFields     | [chest_inches, fabric_preference, jacket_style] |
      | appointmentTypes | [first_fitting, second_fitting, final_fitting]  |
      | sopRules         | ["Always confirm fabric before second fitting"] |
    When context assembly runs
    Then the vertical config section includes custom field definitions, appointment type rules, and SOP rules
    And sopRules are injected into the system prompt as behavior instructions
    And the vertical config section does not exceed ~500 tokens

  Scenario: Learned communication preferences loaded
    Given workspace "ws-abc" has an active WorkspaceCommunicationProfile with 3 communication rules
    When context assembly runs
    Then the learned preferences section includes all active communication rules
    And the token usage for the learned preferences section does not exceed ~500 tokens

  Scenario: Empty communication profile handled gracefully
    Given workspace "ws-abc" has no WorkspaceCommunicationProfile (new workspace, no learning loop data)
    When context assembly runs
    Then the learned preferences section is omitted from the context
    And no error is raised
    And the saved token budget is not reallocated to other sections

  Scenario: Global context is identical across clients in the same workspace
    Given workspace "ws-abc" has clients "C-001" and "C-002"
    When context assembly runs for "C-001" and then for "C-002"
    Then the global sections (system prompt, tool definitions, vertical config, learned preferences) are byte-identical
    And only the client-scoped sections and knowledge chunks differ
```

**Notes:**
- Global sections are defined in architecture 3.3, rows 1-4: system prompt (~1,500 tokens), tool definitions (~800 tokens), vertical config (~500 tokens), learned preferences (~500 tokens).
- The system prompt is composed dynamically from workspace config at assembly time (architecture 4.2), not from a static file.
- Communication rules come from the learning loop (F-15, Phase 4). Until then, this section is empty and omitted.

---

### F05-S02: Client-Scoped Context Assembly

**Function:** CS-03

> **As a** system processing an inbound client message,
> **I want** the client-specific data (profile, compact summary, recent messages, active bookings, active follow-ups, and recent notes) assembled with strict workspace and client scoping,
> **so that** the Client Worker sees only this client's data and never another client's information.

**Acceptance Criteria:**

```gherkin
Feature: Client-scoped context assembly

  Scenario: Client profile loaded with custom fields
    Given client "C-001" in workspace "ws-abc" has:
      | field              | value                |
      | name               | James Chen           |
      | phone              | +61412345678         |
      | lifecycle_status   | chosen_service       |
      | tags               | ["VIP", "wedding"]   |
      | preferences        | {"chest_inches": 42} |
    When context assembly runs for session key "workspace:ws-abc:client:C-001"
    Then the client profile section includes name, phone, lifecycle_status, tags, and all populated custom field values
    And the profile section does not exceed ~500 tokens
    And all database queries include WHERE workspace_id = "ws-abc" AND client_id = "C-001"

  Scenario: Compact summary loaded from latest Memory record
    Given client "C-001" has a Memory record with compact_summary from the last compaction run
    When context assembly runs for client "C-001"
    Then the compact summary section includes the latest compact_summary text
    And if the summary exceeds ~2,000 tokens, the oldest sections are truncated
    And if no Memory record exists (new client), the compact summary section is omitted

  Scenario: Recent messages loaded with hard cap
    Given client "C-001" has 25 messages in conversation history
    When context assembly runs
    Then exactly the last 10 messages are loaded in chronological order
    And each message includes direction (inbound/outbound), sender_type, content, and timestamp
    And the recent messages section does not exceed ~3,000 tokens

  Scenario: Active bookings and follow-ups loaded
    Given client "C-001" has 2 upcoming bookings (status "confirmed") and 3 open follow-ups
    When context assembly runs
    Then the active items section includes both bookings and all 3 follow-ups
    And bookings include appointment_type, start_time, and status
    And follow-ups include description, due_date, and status
    And items are capped at 5 most recent per category if there are more

  Scenario: Recent notes loaded
    Given client "C-001" has 8 notes
    When context assembly runs
    Then the active items section includes up to 5 most recent notes
    And notes include content, created_at, and source (staff vs. ai_extracted)

  Scenario: Conversation state included
    Given client "C-001" has conversation state "booking_in_progress"
    When context assembly runs
    Then the conversation state section includes the current state enum value
    And the state section does not exceed ~100 tokens

  Scenario: Cross-client isolation enforced
    Given workspace "ws-abc" has clients "C-001" and "C-002"
    When context assembly runs for "C-001"
    Then no data from client "C-002" appears in any section of the assembled context
    And every database query is scoped by both workspace_id AND client_id
```

**Notes:**
- Token budgets follow architecture 3.3: client profile (~500), compact summary (~2,000), active items (~1,000), conversation state (~100), recent messages (~3,000).
- Truncation strategies are deterministic: oldest sections of summary, most recent N per category for items, hard cap at 10 for messages.
- The inbound message being processed is appended separately (variable length, architecture 3.3 row 11).

---

### F05-S03: Knowledge Semantic Search

**Function:** CS-04

> **As a** system preparing context for the Client Worker,
> **I want** the inbound client message used to perform a semantic search against the workspace knowledge base (pgvector),
> **so that** the most relevant business knowledge (FAQs, pricing, policies) is pre-loaded into context and available for accurate, attributed draft generation.

**Acceptance Criteria:**

```gherkin
Feature: Knowledge semantic search via pgvector

  Scenario: Relevant knowledge chunks retrieved by semantic similarity
    Given workspace "ws-abc" has 50 indexed knowledge chunks covering FAQs, pricing, and policies
    And client "C-001" sends the message "How much does a two-piece suit cost?"
    When the context assembler performs semantic search against the knowledge base
    Then the inbound message is embedded using the same embedding model used for indexing
    And the top-K most relevant chunks are retrieved ranked by cosine similarity
    And each retrieved chunk includes its source attribution (document name, section)
    And the knowledge chunks section does not exceed ~2,000 tokens

  Scenario: Top-K selection respects token budget
    Given a semantic search returns 8 matching chunks totaling 3,500 tokens
    When the context assembler applies the ~2,000 token budget
    Then chunks are included in descending relevance score order
    And chunks are added until the budget would be exceeded
    And remaining lower-relevance chunks are excluded

  Scenario: No relevant knowledge found
    Given workspace "ws-abc" has knowledge chunks about suits and tailoring
    And client "C-001" sends the message "What's the weather like today?"
    When semantic search runs
    Then zero chunks meet the minimum similarity threshold
    And the knowledge chunks section is empty but present (no error)
    And the Client Worker proceeds without pre-loaded knowledge context

  Scenario: Search scoped to workspace
    Given workspace "ws-abc" and workspace "ws-def" each have indexed knowledge
    When semantic search runs for a client in workspace "ws-abc"
    Then only knowledge chunks belonging to workspace "ws-abc" are searched
    And no chunks from workspace "ws-def" appear in results

  Scenario: Knowledge chunk attribution preserved
    Given a knowledge chunk was indexed from document "Pricing Guide 2026.pdf", section "Two-Piece Suits"
    When that chunk is retrieved by semantic search
    Then the chunk result includes source_document = "Pricing Guide 2026.pdf" and source_section = "Two-Piece Suits"
    And this attribution is available for the Client Worker to cite in draft generation
```

**Notes:**
- Knowledge search runs as part of context assembly, before LLM invocation. It is deterministic code, not an LLM tool call during the conversation.
- The `knowledge_search` tool in the Client Worker's tool inventory (architecture 4.3) allows the LLM to perform additional searches during the tool loop if needed. This story covers the pre-retrieval done at assembly time.
- Embedding model must match between indexing (F-09) and search. Use the same model gateway for both.
- pgvector similarity search uses cosine distance with a configurable minimum threshold.

---

### F05-S04: Client Worker Invocation

**Function:** AD-01

> **As a** system that has assembled a complete read-only context,
> **I want** the Client Worker invoked as a single LLM API call with tool-calling capability and a tool execution loop,
> **so that** the model can classify intent, search knowledge, propose actions, and generate a draft reply within one coherent invocation.

**Acceptance Criteria:**

```gherkin
Feature: Client Worker invocation

  Scenario: Single LLM call with assembled context
    Given context assembly has completed for session key "workspace:ws-abc:client:C-001"
    And the assembled context totals approximately 10,500 tokens
    When the Client Worker runtime invokes the LLM
    Then exactly one LLM API call is made
    And the system prompt is composed from workspace config (tone, behavior rules, SOP)
    And the user message section includes the assembled client context and the inbound message
    And the tool definitions for all available tools are included in the API call

  Scenario: Tool execution loop processes tool calls
    Given the LLM response includes a tool call to "knowledge_search" with query "suit pricing"
    When the Client Worker runtime processes the tool call
    Then the tool is executed with runtime-injected workspaceId and clientId
    And the tool result is appended to the conversation
    And the LLM is called again to continue processing with the tool result
    And this loop continues until the LLM produces a text response (the draft) with no further tool calls

  Scenario: Tool parameter injection prevents scope override
    Given the Client Worker is processing for session key "workspace:ws-abc:client:C-001"
    And the LLM outputs a tool call with arguments including clientId = "C-999"
    When the runtime processes the tool call
    Then the clientId is overridden with "C-001" from the session context
    And the workspaceId is set to "ws-abc" from the session context
    And the LLM-provided clientId "C-999" is discarded
    And the override is logged in the audit trail

  Scenario: LLM-provided parameters validated against tool schema
    Given the LLM outputs a tool call to "calendar_query" with invalid arguments
    When the runtime validates the arguments against the tool input schema
    Then a validation error is returned as the tool result
    And the LLM receives the error and can retry with corrected arguments

  Scenario: Client Worker respects conversation version lock
    Given conversation "conv-001" has version 5 when context assembly began
    When the Client Worker completes and writes results (draft, state transition)
    Then the write includes WHERE version = 5
    And if the version has changed, the write fails and the worker retries with fresh context
```

**Notes:**
- The Client Worker is architecturally equivalent to OpenClaw's single-turn agent runtime: context assembly, LLM call, tool execution loop, response (architecture 4.1).
- Tools never commit writes directly. Mutation tools (calendar_book, update_client_record, create_followup) return `ProposedAction` objects routed to the approval boundary (F-06).
- The tool loop must have a maximum iteration cap (recommend 5 iterations) to prevent runaway tool calling.
- Only `create_note` with authority `auto_write` bypasses the approval boundary.

---

### F05-S05: Intent Classification

**Function:** AD-02

> **As a** staff member reviewing a draft,
> **I want** the Client Worker to classify the client's intent (e.g., booking_inquiry, pricing_question, general_question, follow_up, complaint, greeting),
> **so that** I can quickly understand what the client wants and the system can route escalation-required intents appropriately.

**Acceptance Criteria:**

```gherkin
Feature: Intent classification within the Client Worker

  Scenario: Booking intent classified
    Given client "C-001" sends the message "I'd like to book a fitting for next week"
    When the Client Worker processes the message
    Then the intent is classified as "booking_inquiry"
    And the intent label is included in the draft metadata

  Scenario: Pricing intent classified
    Given client "C-001" sends the message "How much would a three-piece suit cost?"
    When the Client Worker processes the message
    Then the intent is classified as "pricing_question"
    And the Client Worker searches knowledge for pricing information

  Scenario: General question classified
    Given client "C-001" sends the message "Do you have parking available?"
    When the Client Worker processes the message
    Then the intent is classified as "general_question"

  Scenario: Complaint intent classified and flagged for escalation
    Given client "C-001" sends the message "I'm very unhappy with the quality of the stitching"
    When the Client Worker processes the message
    Then the intent is classified as "complaint"
    And the complaint intent maps to a human-only trust tier
    And escalation handling is triggered (see F05-S07)

  Scenario: Multiple intents in a single message
    Given client "C-001" sends "What's the price for alterations? Also, can I reschedule my Thursday appointment?"
    When the Client Worker processes the message
    Then the primary intent is classified (the most actionable one, e.g., "booking_inquiry")
    And secondary intents are noted in the draft so staff can address both

  Scenario: Intent stored with the draft
    Given the Client Worker has classified the intent as "pricing_question"
    When the draft is saved
    Then the Draft.intent_classified field is set to "pricing_question"
    And the intent label is visible to staff in the draft review UI
```

**Notes:**
- Intent classification is performed within the Client Worker LLM call, not as a separate model invocation. It is part of the system prompt instructions.
- The intent taxonomy should be configurable per workspace in the vertical config but have sensible defaults: booking_inquiry, pricing_question, general_question, follow_up, greeting, complaint, cancellation, reschedule, out_of_scope.
- Intent feeds into confidence-based escalation (F05-S07) and learning signal capture (F-10).

---

### F05-S06: Draft Generation with Knowledge Attribution

**Functions:** AD-03, AD-07

> **As a** staff member reviewing a draft reply,
> **I want** the AI-generated draft to be accurate, match our business tone, and cite which knowledge sources it used,
> **so that** I can verify the information is correct before sending and trust the AI's recommendations.

**Acceptance Criteria:**

```gherkin
Feature: Draft generation with knowledge attribution

  Scenario: Draft generated from knowledge base content
    Given client "C-001" asks "What fabrics do you offer for summer suits?"
    And the knowledge base contains a chunk from "Fabric Guide.pdf" section "Summer Collection" covering linen, cotton, and tropical wool
    When the Client Worker generates a draft
    Then the draft text answers the question using information from the knowledge chunk
    And the draft is written in the workspace tone profile (professional, warm, concise)
    And the draft is written in the voice of the business, not as an AI assistant
    And the Draft.knowledge_sources_used includes ["Fabric Guide.pdf - Summer Collection"]

  Scenario: Draft uses client context for personalization
    Given client "C-001" has preferences {"fabric_preference": "linen"} and lifecycle_status "chosen_service"
    And client "C-001" asks "When can I come in for my fitting?"
    When the Client Worker generates a draft
    Then the draft references the client's existing context (e.g., "your linen suit")
    And the draft proposes next steps appropriate to the lifecycle stage

  Scenario: Draft distinguishes known from unknown information
    Given client "C-001" asks "Do you offer leather jackets?"
    And the knowledge base contains no information about leather jackets
    When the Client Worker generates a draft
    Then the draft does not fabricate an answer
    And the draft acknowledges the information is not available (e.g., "Let me check with the team and get back to you")
    And the Draft.knowledge_sources_used is empty
    And the Draft.confidence_score reflects lower confidence

  Scenario: Multiple knowledge sources cited
    Given client "C-001" asks "How much is a three-piece suit and how long does it take?"
    And the knowledge base has relevant chunks from "Pricing Guide.pdf" and "Production Timeline.pdf"
    When the Client Worker generates a draft
    Then the draft incorporates information from both sources
    And Draft.knowledge_sources_used includes both source documents

  Scenario: Draft stored with complete metadata
    Given the Client Worker has generated a draft
    When the draft is saved to the database
    Then the Draft record includes:
      | field                  | value                                          |
      | draft_id               | <generated UUID>                               |
      | conversation_id        | <FK to active conversation>                    |
      | content                | <full draft text>                              |
      | intent_classified      | <intent label from classification>             |
      | confidence_score       | <float between 0 and 1>                        |
      | knowledge_sources_used | <array of source references>                   |
      | staff_action           | null (pending review)                          |
      | created_at             | <current timestamp>                            |

  Scenario: Knowledge attribution visible to staff
    Given a draft has been generated with knowledge_sources_used = ["Pricing Guide.pdf - Two-Piece Suits"]
    When staff opens the draft for review
    Then the knowledge source references are displayed alongside the draft
    And staff can verify the cited source matches the draft content
```

**Notes:**
- The draft is the Client Worker's text response, not a tool call (architecture 4.5).
- Tone matching uses the workspace.tone_profile injected into the system prompt.
- Knowledge attribution supports staff trust and verification. Sources come from the pre-retrieved chunks (F05-S03) and any additional `knowledge_search` tool calls made during the tool loop.
- The draft schema follows PRD 12.6 exactly.

---

### F05-S07: Confidence-Based Escalation

**Function:** AD-04

> **As a** staff member,
> **I want** the system to skip draft generation when the AI has low confidence or the client's intent falls into a human-only category,
> **so that** I am immediately flagged to handle sensitive situations personally rather than receiving an unreliable draft.

**Acceptance Criteria:**

```gherkin
Feature: Confidence-based escalation

  Scenario: Low confidence skips draft generation
    Given client "C-001" sends a message that is ambiguous or in a language not well-supported
    When the Client Worker assigns a confidence_score below the configured threshold (e.g., < 0.4)
    Then no draft is generated
    And the conversation is flagged for manual handling
    And staff is notified with the message "Low confidence — manual response recommended"
    And the notification includes the classified intent and confidence score

  Scenario: Human-only intent category skips draft generation
    Given client "C-001" sends "I want a refund for the jacket, the quality is unacceptable"
    When the Client Worker classifies the intent as "complaint" or "refund"
    And the intent maps to the human-only trust tier (PRD 8)
    Then no draft is generated
    And the conversation is flagged as "escalated"
    And staff is notified with the message "Escalated — human-only category: complaint"
    And the reason for escalation is recorded in the audit trail

  Scenario: Confidence above threshold proceeds to draft
    Given client "C-001" sends "What are your opening hours?"
    When the Client Worker assigns a confidence_score of 0.92
    And the intent "general_question" is not in the human-only category
    Then a draft is generated normally
    And the draft is saved with confidence_score = 0.92
    And staff is notified that a draft is ready for review

  Scenario: Escalation preserves all context for staff
    Given client "C-001" sends a message that triggers escalation
    When the conversation is flagged for manual handling
    Then the assembled context (client profile, summary, recent messages) remains accessible to staff
    And the inbound message is displayed prominently in the conversation view
    And the intent classification is shown even though no draft was generated

  Scenario: Human-only categories are workspace-configurable
    Given workspace "ws-abc" has configured human-only intents: ["complaint", "refund", "legal", "pricing_negotiation"]
    When a different workspace "ws-def" has configured human-only intents: ["complaint", "refund"]
    Then each workspace's escalation rules are evaluated independently
    And "pricing_negotiation" triggers escalation only in workspace "ws-abc"
```

**Notes:**
- The confidence threshold should be configurable per workspace with a sensible default (e.g., 0.4).
- Human-only categories align with the trust model in PRD 8: refunds, pricing changes, policy exceptions, negotiation, complaint handling, liability commitments.
- Escalation is a skip-draft-and-flag action, not a separate workflow. The conversation moves to `awaiting_staff_review` state but without a draft attached.
- Escalation notifications reuse the notification infrastructure from F-04 (NT-03, NT-04 are in F-06 scope, but the underlying push/badge mechanism is F-04).

---

### F05-S08: Draft Storage with Metadata

**Function:** AD-05

> **As a** system persisting the output of the Client Worker,
> **I want** every generated draft saved with its full metadata (intent, confidence, knowledge sources, timestamps),
> **so that** the draft is available for staff review and the metadata supports learning signal capture, audit, and analytics downstream.

**Acceptance Criteria:**

```gherkin
Feature: Draft storage with metadata

  Scenario: Draft saved with all required fields
    Given the Client Worker has generated a draft for client "C-001" in conversation "conv-001"
    When the draft is persisted
    Then a Draft record is created with:
      | field                  | constraint                                |
      | draft_id               | Non-null UUID, primary key                |
      | conversation_id        | FK to conversation "conv-001"             |
      | content                | Non-empty text, the full draft             |
      | intent_classified      | Non-null string (e.g., "pricing_question")|
      | confidence_score       | Float between 0.0 and 1.0                 |
      | knowledge_sources_used | Array of strings (may be empty)            |
      | staff_action           | Null (pending review)                      |
      | edited_content         | Null (no edit yet)                         |
      | created_at             | Current UTC timestamp                      |
      | reviewed_at            | Null (not yet reviewed)                    |
      | reviewed_by            | Null (not yet reviewed)                    |

  Scenario: Draft linked to conversation with version check
    Given conversation "conv-001" is at version 7
    When the draft is saved
    Then the conversation state is updated to "awaiting_staff_review"
    And the conversation version is incremented to 8
    And both writes occur within the same database transaction

  Scenario: Multiple drafts for the same conversation preserved
    Given conversation "conv-001" already has a draft "draft-001" with staff_action = "regenerated"
    When the Client Worker generates a new draft via reprompt
    Then a new Draft record "draft-002" is created
    And the previous draft "draft-001" remains in the database for audit purposes
    And the conversation references the latest draft for staff review

  Scenario: Draft without knowledge sources stored correctly
    Given the Client Worker generated a draft without using any knowledge sources
    When the draft is saved
    Then knowledge_sources_used is an empty array []
    And no error is raised for the empty array

  Scenario: Escalated conversation has no draft record
    Given client "C-001" sent a message that triggered escalation (F05-S07)
    When the escalation is processed
    Then no Draft record is created for this inbound message
    And the conversation state is "awaiting_staff_review" with no associated draft
```

**Notes:**
- The Draft table schema follows PRD 12.6 exactly.
- `staff_action` is set later when staff acts on the draft (sent_as_is, edited_and_sent, regenerated, discarded). At creation time it is always null.
- Draft records are never deleted; previous drafts from reprompts are preserved for the audit trail and learning loop (F-10).
- The conversation version check ensures that if another process modified the conversation while the Client Worker was running, the draft write fails and the worker retries.

---

### F05-S09: Staff Reprompt and Regeneration

**Function:** AD-06

> **As a** staff member reviewing a draft,
> **I want** to provide a natural language instruction (e.g., "make it shorter", "include the Saturday option", "use a more casual tone") and have the system regenerate the draft incorporating my feedback,
> **so that** I can steer the AI's output without writing the entire reply myself.

**Acceptance Criteria:**

```gherkin
Feature: Staff reprompt and regeneration

  Scenario: Staff reprompts with a specific instruction
    Given staff is reviewing draft "draft-001" for client "C-001"
    And draft "draft-001" has content "We offer two-piece suits starting at $2,500..."
    When staff enters the reprompt instruction "Make it shorter and mention the current promotion"
    Then a new LLM call is made to the Client Worker
    And the new call includes the same assembled context as the original invocation
    And the previous draft content is included in the conversation history
    And the staff instruction "Make it shorter and mention the current promotion" is appended as a user message
    And the LLM generates a new draft incorporating the instruction

  Scenario: Regenerated draft replaces the active draft
    Given the reprompt LLM call produces new draft content
    When the new draft is saved
    Then a new Draft record "draft-002" is created with the regenerated content
    And the previous draft "draft-001" has its staff_action set to "regenerated"
    And the conversation's active draft reference points to "draft-002"
    And "draft-001" remains in the database for audit

  Scenario: Regenerated draft includes updated metadata
    Given the reprompt produces a new draft
    When "draft-002" is saved
    Then it has its own intent_classified (which may differ from the original)
    And it has its own confidence_score
    And it has its own knowledge_sources_used (may include different sources if the LLM made new tool calls)
    And created_at reflects the time of the regeneration

  Scenario: Multiple sequential reprompts supported
    Given staff has already reprompted once (draft-001 → draft-002)
    When staff reprompts again with "Also add a greeting"
    Then a new LLM call is made with the latest draft (draft-002) in the conversation history
    And the new staff instruction is appended
    And a new Draft record "draft-003" is created
    And draft-002 staff_action is set to "regenerated"

  Scenario: Reprompt uses fresh context assembly
    Given 5 minutes have passed since the original draft was generated
    And a new message arrived from the same client during that time
    When staff reprompts
    Then context assembly runs again to capture the latest state
    And the recent messages section includes the newly arrived message
    And the Client Worker sees up-to-date context

  Scenario: Reprompt respects escalation rules
    Given staff reprompts with an instruction for a conversation that was previously escalated
    When the Client Worker processes the reprompt
    Then the same confidence and escalation checks apply
    And if the regenerated draft falls below the confidence threshold, the escalation flag is re-raised
```

**Notes:**
- Reprompting is architecturally described in section 4.6: new LLM call with same context plus staff instruction appended. The previous draft appears in conversation history.
- The old draft is preserved in the database (staff_action = "regenerated") but is no longer the active draft for review.
- Context is reassembled fresh on reprompt to capture any state changes since the original draft.
- There is no limit on sequential reprompts, but each one is a full LLM API call with cost implications. Consider surfacing call count to staff in future iterations.

---

### F05-S10: Token Budget Management

**Function:** Cross-cutting (CS-02, CS-03, CS-04, AD-01 — architecture 3.3)

> **As a** system operator,
> **I want** the context assembly to enforce a fixed ~12,000 token budget with deterministic per-section allocations and truncation strategies,
> **so that** the Client Worker LLM call stays within cost and latency targets regardless of how much data exists for a given client.

**Acceptance Criteria:**

```gherkin
Feature: Token budget management

  Scenario: Total context stays within budget for a data-rich client
    Given client "C-001" has:
      | data               | volume                        |
      | messages           | 200 messages in history       |
      | compact summary    | 3,500 tokens of summary text  |
      | notes              | 15 notes                      |
      | bookings           | 8 booking records             |
      | follow-ups         | 6 follow-up records           |
      | knowledge matches  | 8 relevant chunks             |
    When context assembly runs for client "C-001"
    Then the total assembled context does not exceed approximately 12,000 tokens (excluding the inbound message)
    And each section respects its individual budget allocation

  Scenario: Recent messages hard-capped at 10
    Given client "C-001" has 200 messages
    When context assembly runs
    Then exactly the last 10 messages are included
    And the messages section does not exceed ~3,000 tokens
    And older messages are not loaded from the database

  Scenario: Compact summary truncated if oversized
    Given client "C-001" has a compact_summary of 3,500 tokens
    When context assembly runs
    Then the compact summary is truncated to ~2,000 tokens
    And the oldest sections of the summary are removed first
    And the most recent summary content is preserved

  Scenario: Knowledge chunks selected by relevance within budget
    Given semantic search returns 8 chunks totaling 3,200 tokens
    When context assembly applies the ~2,000 token knowledge budget
    Then chunks are included in descending relevance score order
    And inclusion stops before exceeding the budget
    And lower-relevance chunks are excluded

  Scenario: Active items capped per category
    Given client "C-001" has 8 bookings, 6 follow-ups, and 15 notes
    When context assembly runs
    Then at most 5 bookings, 5 follow-ups, and 5 notes are included
    And items are sorted by recency (most recent first)
    And the active items section does not exceed ~1,000 tokens

  Scenario: New client with minimal data assembles well under budget
    Given client "C-002" is brand new with:
      | data               | volume               |
      | messages           | 1 (the inbound)      |
      | compact summary    | none                 |
      | notes              | none                 |
      | bookings           | none                 |
      | follow-ups         | none                 |
      | knowledge matches  | 2 chunks             |
    When context assembly runs
    Then the total context is well under 12,000 tokens
    And omitted sections (compact summary, active items) do not produce errors
    And the LLM call proceeds normally with the available context

  Scenario: Fixed sections are never truncated
    Given the system prompt is 1,450 tokens and tool definitions are 780 tokens
    When context assembly runs
    Then the system prompt and tool definitions are included in full
    And no truncation is applied to fixed sections
```

**Notes:**
- Token budgets from architecture 3.3: system prompt ~1,500, tool definitions ~800, vertical config ~500, learned preferences ~500, knowledge chunks ~2,000, client profile ~500, compact summary ~2,000, active items ~1,000, conversation state ~100, recent messages ~3,000. Total ~12,000.
- Token counting should use a fast tokenizer (e.g., tiktoken for OpenAI models) appropriate to the LLM provider configured in ModelGateway.
- The budget is a target, not a hard wall. Slight overages (e.g., 12,200 tokens) are acceptable. The goal is cost and latency predictability.
- Per ADR-3, there is no reactive compaction. If a client has too much data, sections are truncated deterministically. The daily compaction job (F-11) keeps the compact summary manageable over time.

---

## Story Map

| Story | PRD Function | Priority | Dependencies |
|-------|-------------|----------|--------------|
| F05-S01: Global Context Assembly | CS-02 | Must-have | F-01 (workspace config, vertical config, tone profile) |
| F05-S02: Client-Scoped Context Assembly | CS-03 | Must-have | F-02 (messages), F-03 (client profile) |
| F05-S03: Knowledge Semantic Search | CS-04 | Must-have | F-01 (knowledge base indexed), pgvector extension |
| F05-S04: Client Worker Invocation | AD-01 | Must-have | F05-S01, F05-S02, F05-S03 |
| F05-S05: Intent Classification | AD-02 | Must-have | F05-S04 |
| F05-S06: Draft Generation with Attribution | AD-03, AD-07 | Must-have | F05-S04, F05-S03 |
| F05-S07: Confidence-Based Escalation | AD-04 | Must-have | F05-S05 |
| F05-S08: Draft Storage with Metadata | AD-05 | Must-have | F05-S06 |
| F05-S09: Staff Reprompt and Regeneration | AD-06 | Must-have | F05-S08 |
| F05-S10: Token Budget Management | Cross-cutting | Must-have | F05-S01, F05-S02, F05-S03 |

## Suggested Build Order

```
F05-S01 (Global Context Assembly)          ── loads workspace-level data
F05-S02 (Client-Scoped Context Assembly)   ── loads client-level data
F05-S10 (Token Budget Management)          ── enforces budgets on S01 + S02
    |
    v
F05-S03 (Knowledge Semantic Search)       ── pgvector search, feeds into context
    |
    v
F05-S04 (Client Worker Invocation)        ── LLM call + tool loop, depends on full context
    |
    v
F05-S05 (Intent Classification)           ── within the Client Worker call
F05-S06 (Draft Generation + Attribution)   ── the Client Worker's primary output
    |          (S05 and S06 are part of the same LLM call, built together)
    v
F05-S07 (Confidence-Based Escalation)     ── post-classification routing
F05-S08 (Draft Storage with Metadata)      ── persists the draft or escalation
    |          (S07 and S08 can be built in parallel)
    v
F05-S09 (Staff Reprompt / Regeneration)   ── built last, depends on full draft lifecycle
```

## Definition of Done (Feature Level)

- [ ] All 10 stories pass acceptance criteria in integration tests.
- [ ] Context assembly produces a valid `ClientSessionContext` for clients with no history, partial data, and full data.
- [ ] Global context sections are identical across different clients in the same workspace.
- [ ] Client-scoped context never includes data from another client (verified by isolation tests).
- [ ] All database queries in context assembly include `WHERE workspace_id = $1 AND client_id = $2`.
- [ ] pgvector semantic search returns relevant knowledge chunks within the ~2,000 token budget.
- [ ] The Client Worker makes exactly one LLM API call (plus tool loop iterations) per inbound message.
- [ ] Tool parameter injection overrides any LLM-provided workspaceId or clientId.
- [ ] Intent classification is present on every generated draft.
- [ ] Knowledge source attribution is present on drafts that used knowledge base content.
- [ ] Low-confidence or human-only messages skip draft generation and flag the conversation.
- [ ] Draft records include all PRD 12.6 fields and are never deleted.
- [ ] Staff reprompt produces a new draft with fresh context, preserving the old draft for audit.
- [ ] Total assembled context does not exceed ~12,000 tokens for any client regardless of data volume.
- [ ] End-to-end latency from inbound message to draft-ready notification is under 10 seconds for 95th percentile.
