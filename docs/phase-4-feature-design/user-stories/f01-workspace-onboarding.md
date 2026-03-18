# User Stories — F-01: Workspace Onboarding & Business Setup

**Feature:** F-01 Workspace Onboarding & Business Setup
**PRD Functions:** ON-01, ON-02, ON-03, ON-04, ON-05, ON-06
**Phase:** 1
**Size:** XL
**Architecture Modules:** workspace-knowledge, conversation

---

## US-F01-01: Connect WhatsApp and Create Workspace

**As a** business owner,
**I want** to scan a QR code to connect my existing WhatsApp account,
**So that** the system can create my workspace and access my existing conversations without requiring a separate business number or API application.

**Acceptance Criteria:**

```gherkin
Scenario: Successful QR code scan and workspace creation
  Given the owner has opened the staff app for the first time
  When the owner scans the displayed QR code with their WhatsApp mobile app
  Then the system establishes a WhatsApp Web session
  And a new workspace record is created with status "pending"
  And the WhatsApp session credentials are persisted in workspace.whatsapp_config
  And the owner is redirected to the business identity step

Scenario: QR code expires before scanning
  Given the owner has not scanned the QR code within the timeout window
  When the QR code expires
  Then the system displays a "QR code expired" message
  And provides a button to generate a fresh QR code

Scenario: WhatsApp session disconnects during onboarding
  Given the owner has successfully paired via QR code
  When the WhatsApp Web session disconnects unexpectedly
  Then the system displays a reconnection prompt
  And offers a new QR code for re-pairing
  And any onboarding progress already saved is preserved

Scenario: Existing conversation history is imported
  Given the owner has successfully paired via QR code
  When the WhatsApp session is established
  Then the system begins importing existing conversation history in the background
  And the import does not block progression to the next onboarding step
```

**Notes:**
- Uses WhatsApp Web protocol library (e.g., Baileys/whatsapp-web.js), not Meta Cloud API.
- No WABA application or separate business number required — owner connects their own WhatsApp.
- Session persistence via stored credentials enables reconnection without re-scanning.
- Conversation history import runs async; it feeds context bootstrapping but is not blocking for onboarding flow.
- Maps to PRD function ON-01 and partially MP-07 (history import).

---

## US-F01-02: Provide Business Identity

**As a** business owner,
**I want** to enter my business name, industry vertical, Instagram handle, and timezone,
**So that** the system can configure my workspace for my specific business context.

**Acceptance Criteria:**

```gherkin
Scenario: Owner completes business identity via form
  Given the owner has connected WhatsApp and is on the business identity step
  When the owner enters business name, selects a vertical type, provides an Instagram handle, and confirms timezone
  Then the workspace record is updated with the provided values
  And the onboarding status remains "pending" (unchanged until Instagram scrape completes)
  And the owner is advanced to the knowledge base step

Scenario: Owner skips Instagram handle
  Given the owner is on the business identity step
  When the owner leaves the Instagram handle field empty and submits
  Then the workspace is created without an instagram_handle
  And the knowledge base step presents manual entry instead of scraping
  And the owner can add an Instagram handle later in Settings

Scenario: Timezone is auto-detected
  Given the owner is on the business identity step
  When the form loads
  Then the timezone field is pre-filled with the detected browser/device timezone
  And the owner can override it with a different IANA timezone

Scenario: Vertical type selection
  Given the owner is on the business identity step
  When the owner selects a vertical type (e.g., "bespoke_tailor", "salon", "clinic")
  Then the selection is stored in workspace.vertical_type
  And this value is used to drive deep research SOP generation in the next step
```

**Notes:**
- All fields except Instagram handle are required.
- Vertical type drives SOP generation (ON-04) and determines the shape of `vertical_config`.
- Instagram handle is used for knowledge base scraping (ON-03) and tone extraction (ON-06). If absent, both fall back to manual paths.
- Maps to PRD function ON-02.

---

## US-F01-03: Bootstrap Knowledge Base from Instagram

**As a** business owner,
**I want** the system to scrape my public Instagram profile and generate a draft knowledge base,
**So that** I have a starting point for the AI's business knowledge without manually typing everything.

**Acceptance Criteria:**

```gherkin
Scenario: Successful Instagram scrape and knowledge base generation
  Given the owner has provided a valid public Instagram handle
  When the system initiates the Instagram scrape
  Then the system extracts the bio, post captions, highlights metadata, and link-in-bio content
  And an LLM generates a structured markdown knowledge base from the extracted content
  And the draft is saved to workspace.knowledge_base
  And the onboarding status is updated to "instagram_scraped"
  And the owner is shown the draft for review

Scenario: Owner reviews and edits the draft knowledge base
  Given the system has generated a draft knowledge base from Instagram
  When the owner views the draft
  Then the owner can edit any section of the markdown directly
  And can add new sections not captured from Instagram
  And can delete irrelevant content
  And changes are saved to workspace.knowledge_base on confirmation

Scenario: Instagram profile is private or unavailable
  Given the owner has provided an Instagram handle
  When the system attempts to scrape and the profile is private, deleted, or unreachable
  Then the system displays a message explaining the profile could not be accessed
  And presents a blank knowledge base editor for manual entry
  And the onboarding flow continues without blocking
  And the onboarding status is updated to "instagram_scraped" after manual entry is confirmed

Scenario: Instagram scrape returns partial results
  Given the owner has provided a valid public Instagram handle
  When the system scrapes but only retrieves partial data (e.g., bio only, no posts)
  Then the system generates a draft from whatever content was available
  And clearly indicates sections that may need manual enrichment
  And the owner can supplement the draft before confirming

Scenario: Owner has no Instagram presence
  Given the owner did not provide an Instagram handle in step 2
  When the owner reaches the knowledge base step
  Then the system presents a blank knowledge base template guided by the vertical type
  And the owner can type or paste business information manually
  And the owner can upload documents (this upload capability ships in Phase 2 via ON-08)
```

**Notes:**
- Instagram scraping is a convenience, not a dependency. The system must gracefully handle all failure modes.
- Scraping is one-time at onboarding. Additional knowledge management happens in Settings post-onboarding.
- The LLM structures raw Instagram content into a useful markdown format (services, policies, FAQs, etc.).
- Rate limiting / anti-bot measures on Instagram are a known risk (PRD §20). The fallback is always manual entry.
- Maps to PRD function ON-03.

---

## US-F01-04: Generate Vertical-Specific SOPs via Deep Research

**As a** business owner,
**I want** the system to research my industry and generate standard operating procedures tailored to my vertical,
**So that** the AI assistant is pre-configured with sensible defaults for appointment types, client workflows, and business rules.

**Acceptance Criteria:**

```gherkin
Scenario: SOP generation from vertical type
  Given the owner has completed the knowledge base step
  And the workspace has a vertical_type set
  When the system initiates deep research SOP generation
  Then the system generates a draft vertical_config containing:
    | Component            | Example                                         |
    | Appointment types    | With labels, durations, buffers, prerequisites   |
    | Custom fields        | Vertical-relevant client data fields             |
    | Lifecycle stages     | Industry-standard client journey stages          |
    | SOP rules            | Communication guidelines for the AI agent        |
  And the draft is saved to workspace.vertical_config
  And the onboarding status is updated to "sop_configured"

Scenario: SOP generation completes with knowledge base context
  Given the owner has a populated knowledge base from Instagram scraping
  When SOP generation runs
  Then the LLM uses both the vertical type and the knowledge base content to inform the generated SOPs
  And the SOPs reflect business-specific details found in the knowledge base (e.g., specific service names, pricing tiers)

Scenario: SOP generation for unknown or niche vertical
  Given the owner has entered a vertical type that is uncommon
  When the system generates SOPs
  Then the system produces a reasonable generic starting point
  And clearly indicates which sections are generic defaults that need customization
  And the owner is prompted to refine via conversational editing

Scenario: Owner views the generated SOP summary
  Given SOP generation is complete
  When the owner is shown the results
  Then each SOP component is displayed in a reviewable format:
    - Appointment types with durations and sequencing rules
    - Custom fields with labels and data types
    - Lifecycle stages with descriptions
    - SOP rules as plain-language guidelines
  And the owner can proceed to conversational refinement or accept as-is
```

**Notes:**
- "Deep research" means the LLM uses its training knowledge (and optionally web search if available) to generate industry-standard SOPs. This is not a simple template lookup.
- The `vertical_config` JSON structure follows the schema in PRD section 11.1: `customFields`, `appointmentTypes`, `lifecycleStages`, `sopRules`.
- SOP generation is a single LLM call per ADR-1 (no separate agent).
- The generated config becomes the foundation for booking logic, context assembly, and AI drafting.
- Maps to PRD function ON-04.

---

## US-F01-05: Refine SOPs Conversationally

**As a** business owner,
**I want** to refine the generated SOPs through natural language conversation,
**So that** I can customize appointment types, business rules, and workflows without navigating complex configuration forms.

**Acceptance Criteria:**

```gherkin
Scenario: Owner modifies an appointment type duration
  Given the owner is viewing the generated SOPs
  When the owner types "Our fittings are 45 minutes, not 60"
  Then the system parses the instruction
  And updates the relevant appointment type duration in vertical_config to 45 minutes
  And displays the updated SOP with the change highlighted

Scenario: Owner adds a new appointment type
  Given the owner is in conversational SOP editing
  When the owner types "Add a rush order type, 30 minutes, no prerequisite"
  Then the system creates a new appointment type entry in vertical_config
  And displays the updated list of appointment types for confirmation

Scenario: Owner modifies custom fields
  Given the owner is in conversational SOP editing
  When the owner types "Add a field for fabric preference, it should be a dropdown with cotton, silk, linen, and wool"
  Then the system adds a custom field with type "enum" and the specified values
  And displays the updated custom fields list

Scenario: Owner edits SOP rules
  Given the owner is in conversational SOP editing
  When the owner types "Never mention competitor brands in replies"
  Then the system adds the rule to sopRules in vertical_config
  And displays the updated rules list

Scenario: Owner confirms and finalizes SOPs
  Given the owner has made all desired edits
  When the owner indicates they are satisfied (e.g., "Looks good" or clicks a confirm button)
  Then the final vertical_config is persisted
  And the onboarding advances to the tone profile step

Scenario: Multiple rounds of editing
  Given the owner is in conversational SOP editing
  When the owner provides several sequential instructions
  Then each instruction is parsed and applied incrementally
  And the system maintains the conversation context across rounds
  And the owner can see a running summary of all changes made
```

**Notes:**
- Conversational editing is LLM-powered: the system parses natural language instructions and maps them to structured `vertical_config` mutations.
- The chat interface should show the current state of the SOP after each edit so the owner has a clear picture of the cumulative result.
- Owners can also return to SOP editing post-onboarding via Settings.
- This is the same editing mechanism that will be available in the Settings > SOP editor surface (PRD section 16.2).
- Maps to PRD function ON-05.

---

## US-F01-06: Extract and Adjust Tone Profile

**As a** business owner,
**I want** the system to analyze my Instagram content and propose a tone profile for the AI assistant,
**So that** AI-generated drafts match my brand voice from day one.

**Acceptance Criteria:**

```gherkin
Scenario: Tone profile generated from Instagram content
  Given the system has scraped Instagram content during onboarding
  When the tone profile extraction step is reached
  Then the LLM analyzes the Instagram bio, captions, and any scraped content
  And generates a tone profile describing the brand's communication style
  And saves the proposed profile to workspace.tone_profile
  And displays the profile to the owner for review

Scenario: Owner adjusts the tone profile
  Given the system has proposed a tone profile
  When the owner provides feedback (e.g., "Make it more formal" or "We're actually more casual than that")
  Then the system updates the tone profile based on the feedback
  And displays the revised profile for further review or acceptance

Scenario: Owner accepts the tone profile
  Given the owner has reviewed (and optionally adjusted) the tone profile
  When the owner confirms the profile
  Then the tone profile is persisted to workspace.tone_profile
  And the onboarding status is updated to "tone_set"
  And the owner is advanced to the final onboarding summary

Scenario: Tone extraction without Instagram data
  Given the owner did not provide an Instagram handle or the scrape failed
  When the tone profile step is reached
  Then the system presents a default tone profile based on the vertical type
  And invites the owner to describe their preferred communication style
  And generates a tone profile from the owner's description

Scenario: Tone profile describes actionable attributes
  Given tone profile extraction is complete
  When the profile is displayed to the owner
  Then it includes concrete attributes such as:
    - Formality level (casual, professional, formal)
    - Warmth and friendliness indicators
    - Use of emojis or colloquialisms
    - Industry-specific communication norms
    - Example phrases that reflect the tone
  And the profile is written as instructions the AI can follow when drafting messages
```

**Notes:**
- The tone profile is injected into every Client Worker context assembly call (PRD section 11.2), so it directly shapes all AI-generated draft replies.
- Tone extraction uses the same Instagram content already scraped in ON-03; no second scrape is needed.
- If Instagram data is unavailable, the system bootstraps from the vertical type and owner's self-description.
- The tone profile is stored as free-form text in `workspace.tone_profile`, not as structured JSON.
- Post-onboarding, the tone profile can be edited in Settings > Tone config.
- Maps to PRD function ON-06.

---

## US-F01-07: Complete Onboarding and Activate Workspace

**As a** business owner,
**I want** to see a summary of my onboarding configuration and activate my workspace,
**So that** I can confirm everything is set up correctly before the AI begins handling real client conversations.

**Acceptance Criteria:**

```gherkin
Scenario: Onboarding summary displayed
  Given the owner has completed all onboarding steps (WhatsApp, identity, knowledge base, SOPs, tone)
  When the final onboarding summary screen is displayed
  Then the owner sees:
    - WhatsApp connection status (connected, with phone number)
    - Business name and vertical type
    - Knowledge base summary (word count or section count)
    - SOP highlights (number of appointment types, custom fields, rules)
    - Tone profile summary
    - Google Calendar status (not yet connected, with option to connect now or later)
  And a prominent "Go Live" or "Activate" action

Scenario: Owner activates workspace
  Given the owner is viewing the onboarding summary
  When the owner confirms activation
  Then the onboarding status is updated to "complete"
  And the full message pipeline is activated for the workspace
  And the owner is redirected to the staff app inbox
  And any imported WhatsApp conversation history is available for context

Scenario: Owner defers Google Calendar connection
  Given the owner is on the onboarding summary
  When the owner chooses to skip Google Calendar for now
  Then the workspace activates without calendar integration
  And booking-related features remain dormant
  And the owner can connect Google Calendar later in Settings

Scenario: Owner revisits a completed step
  Given the owner is on the onboarding summary
  When the owner taps on any completed section (e.g., knowledge base, SOPs, tone)
  Then the owner is taken back to that step for editing
  And returning to the summary preserves all other configuration

Scenario: Progressive capability based on onboarding completion
  Given the workspace is activated
  When the system processes inbound messages
  Then capabilities reflect what was configured during onboarding:
    | Configured          | Capability enabled                        |
    | WhatsApp connected  | Messages received, client identity, history |
    | Knowledge base set  | Knowledge-grounded AI drafts               |
    | SOPs configured     | Vertical-aware drafting, appointment types  |
    | Tone set            | Brand-voice AI drafts                      |
    | Calendar connected  | Full booking flow (Phase 2)                |
```

**Notes:**
- This story covers the "wrap-up" of onboarding, not a new PRD function. It ties together ON-01 through ON-06 into a completed state.
- The progressive enhancement model (PRD section 15.3) means the workspace is functional at any level of completeness -- each additional configuration layer adds capability.
- Google Calendar connection (ON-07) is Phase 2 and not part of F-01, but the onboarding summary should acknowledge it as a future step.
- The `onboarding_status` enum tracks: `pending` -> `instagram_scraped` -> `sop_configured` -> `tone_set` -> `complete`.

---

## Story Map

| Story | PRD Functions | Core Flow | Fallback Path |
|-------|--------------|-----------|---------------|
| US-F01-01 | ON-01, MP-07 (partial) | QR scan -> workspace + WhatsApp session | QR expiry, session disconnect |
| US-F01-02 | ON-02 | Business identity form | Skip Instagram handle |
| US-F01-03 | ON-03 | Instagram scrape -> draft KB | Private profile, no handle, partial data -> manual entry |
| US-F01-04 | ON-04 | Deep research -> vertical_config | Niche vertical -> generic defaults |
| US-F01-05 | ON-05 | Conversational SOP refinement | N/A (owner always has edit option) |
| US-F01-06 | ON-06 | Instagram -> tone profile | No Instagram -> vertical default + owner description |
| US-F01-07 | Composite | Summary + activation | Defer calendar, revisit steps |

## Dependencies

- **F-02 (WhatsApp Message Pipeline):** F-01 creates the WhatsApp session that F-02 uses. History import (MP-07) is triggered during F-01 onboarding but the import pipeline infrastructure belongs to F-02.
- **ADR-1 (Single Agent):** SOP generation and tone extraction are LLM calls, not separate agents.
- **ADR-2 (Database-backed sessions):** Workspace and WhatsApp session state stored in Supabase, not files.
