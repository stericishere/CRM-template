# User Stories — F-13: Intelligent Note Processing & Promise Tracking

**Feature:** F-13 Intelligent Note Processing & Promise Tracking
**Phase:** 3 (Operational Memory & Follow-ups)
**Size:** L
**PRD Functions:** NF-02, NF-03, NF-04, NF-08
**Architecture modules:** `follow-up-management`, `client-relationship` (ProposeClientUpdate), `agent-governance` (confirmation cards)
**ADR dependencies:** ADR-1 (note categorization is an async LLM call), ADR-4 (promise extraction dispatches through Client Worker path)
**Depends on:** F-06 (confirmation cards / approval workflow), F-09 (note and follow-up infrastructure)
**Last updated:** March 2026

---

## Context

F-09 established the immediate-write note infrastructure: staff saves a note, it hits the database in under a second, no AI in the critical path. F-13 picks up where F-09 left off by adding the async intelligence layer that runs *after* the note is saved.

When a staff member saves a note like "She changed her name to Liz, prefers mornings, and I promised her 10% off next visit," three distinct things are buried in that single sentence: a profile data change (name), a preference update (morning appointments), and a business promise (10% discount). Today, all three stay trapped in free text. F-13 extracts them into structured, actionable records.

The extraction pipeline has four capabilities:

1. **Async note categorization (NF-02):** An LLM call parses each saved note and classifies its contents into follow-ups, preference updates, and promises. Results are written as structured records (FollowUp, proposed client updates) linked back to the source note.

2. **Structured change proposals (NF-03):** When categorization identifies a data change (name, phone, tags, preferences, lifecycle status, or vertical custom fields), the system creates a `ProposedAction` with a confirmation card — reusing the F-06 approval flow. Staff sees the before/after diff and approves or rejects.

3. **Conversational context updates (NF-04):** Staff can issue direct update commands ("update her name to Liz") that bypass the note flow and go straight to intent parsing plus confirmation card. This is the fast path for explicit data corrections.

4. **Promise tracking (NF-08):** The system scans conversation history for commitments made by staff or the business ("I'll send you the quote by Friday," "we'll hold the appointment for you"). Each detected promise is auto-created as a FollowUp record with `type = "promise"` and an inferred deadline where possible.

Additionally, the system detects **buying signals** in conversations — questions about pricing, availability, or services that indicate lead warmth — and auto-creates follow-up suggestions so staff can nurture potential leads toward bookings.

A critical invariant: **categorization failure must never block note saving.** The note is already persisted (by F-09) before categorization begins. If the LLM call fails, the note remains intact as raw text — the system retries later, and staff is never blocked. The `extraction_status` field on the Note record tracks whether categorization is `pending`, `complete`, or `failed`, and the daily compaction job (F-11) checks this field before compacting (flush-before-compact invariant per Architecture section 6.3).

### Data model references

**Note** (PRD section 12.8): `note_id`, `client_id`, `content`, `source` (enum: `staff_manual`, `ai_extracted`, `conversation_update`, `merge_history`), `created_by`, `created_at`. Extended with `extraction_status` (enum: `pending`, `complete`, `failed`, `not_applicable`) for the async categorization pipeline.

**Follow-up / Promise** (PRD section 12.9): `followup_id`, `client_id`, `type` (enum: `follow_up`, `promise`, `reminder`), `content`, `due_date` (nullable), `status` (enum: `open`, `completed`, `pending`, `overdue`), `created_by`, `created_at`.

**Client** (PRD section 12.3): `full_name`, `phone_number`, `email`, `lifecycle_status`, `tags`, `preferences` (JSON — holds all vertical custom field values).

**ProposedAction** (F-06): `proposed_action_id`, `actionType`, `payload` (with `before_state` / `after_state`), `status` (pending/approved/rejected), `tier` (always "review" for data changes).

### Predefined updatable fields (per PRD section 9.4)

Conversational context updates and structured change proposals are limited to these fields: `full_name`, `phone_number`, `email`, `tags`, `preferences` (including vertical custom fields defined in `workspace.vertical_config.customFields`). Lifecycle status changes are also supported but follow the same confirmation card flow.

---

## Story US-F13-01 — Async AI Note Categorization (NF-02)

**As a** staff member who just saved a note in a client thread,
**I want** the system to automatically analyze my note in the background and extract any follow-ups, preference updates, or promises it contains,
**so that** actionable items are surfaced as structured records without me having to manually create each one.

### Acceptance criteria

```gherkin
Feature: Async AI note categorization

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And a client record exists with client_id "client-abc" in workspace "WS-001"
    And the client's current preferences are { "preferred_time": "afternoons" }

  Scenario: Note is categorized after save without blocking the save path
    When staff saves a note "Client now prefers mornings. Follow up about wedding quote by Friday."
    Then the Note record is created immediately with extraction_status = "pending"
    And the save completes in under 1 second (no LLM call on the save path)
    And an async categorization job is enqueued for the new note_id

  Scenario: Categorization extracts a follow-up
    Given a note exists with content "Follow up about wedding quote by Friday"
    And extraction_status = "pending"
    When the async categorization job processes this note
    Then a FollowUp record is created with:
      | field      | value                                |
      | client_id  | "client-abc"                         |
      | type       | "follow_up"                          |
      | content    | "Follow up about wedding quote"      |
      | status     | "open"                               |
      | created_by | system (AI-extracted)                |
    And the note's extraction_status is updated to "complete"

  Scenario: Categorization extracts a preference update as a ProposedAction
    Given a note exists with content "Client now prefers mornings"
    And extraction_status = "pending"
    When the async categorization job processes this note
    Then a ProposedAction is created with:
      | field        | value                                                    |
      | actionType   | "client_update"                                          |
      | before_state | { "preferred_time": "afternoons" }                       |
      | after_state  | { "preferred_time": "mornings" }                         |
      | tier         | "review"                                                 |
      | status       | "pending"                                                |
    And a confirmation card is shown to staff (via F-06 flow)

  Scenario: Categorization extracts a promise
    Given a note exists with content "I promised her 10% off next visit"
    When the async categorization job processes this note
    Then a FollowUp record is created with:
      | field      | value                              |
      | client_id  | "client-abc"                       |
      | type       | "promise"                          |
      | content    | "10% off next visit"               |
      | status     | "open"                             |
      | created_by | system (AI-extracted)              |

  Scenario: A single note with multiple items extracts all of them
    Given a note exists with content "She changed her name to Liz, prefers mornings, and I promised her 10% off next visit. Follow up about dress fitting next week."
    When the async categorization job processes this note
    Then the following records are created:
      | record type    | content / field                    |
      | ProposedAction | full_name change to "Liz"          |
      | ProposedAction | preferred_time change to "mornings"|
      | FollowUp       | "10% off next visit" (promise)     |
      | FollowUp       | "dress fitting" (follow_up)        |
    And extraction_status is set to "complete"

  Scenario: Note with no actionable content is marked complete without creating records
    Given a note exists with content "Had a nice chat, she seems happy with the service"
    When the async categorization job processes this note
    Then no FollowUp or ProposedAction records are created
    And the note's extraction_status is updated to "complete"

  Scenario: Extraction results are linked to the source note
    When the categorization job creates FollowUp or ProposedAction records
    Then each record includes a source_note_id reference back to the original note
    And staff can trace any extracted item to the note that generated it

  Scenario: Staff is notified when extraction produces actionable items
    When the categorization job extracts one or more follow-ups, promises, or change proposals
    Then staff receives an in-app notification indicating new items were extracted from their note
    And the notification links to the client thread where the confirmation cards or follow-ups appear
```

### Notes

- The categorization job runs as an async LLM call enqueued immediately after the note save. Per the architecture review note, the recommended runtime is either a lightweight `NoteProcessingJob` in `jobs/` or the Client Worker with a categorization-specific tool set.
- The LLM receives the note content, the client's current profile (for before/after diffs on proposed changes), and the workspace's vertical config (to understand custom fields).
- Extracted follow-ups are created with `created_by` set to a system/AI identifier, not the staff member, to distinguish AI-extracted items from manually created ones.
- The `extraction_status` field is critical for the flush-before-compact invariant (F-11): the daily compaction job will not compact a client's messages if any notes have `extraction_status = "pending"`.
- Notes with `source = "merge_history"` should have `extraction_status = "not_applicable"` — they are audit records, not categorizable content.

---

## Story US-F13-02 — Structured Change Proposal via Confirmation Card (NF-03)

**As a** staff member,
**I want** the system to show me a confirmation card with a clear before/after diff whenever my note implies a change to client data,
**so that** I can verify the AI understood my intent correctly before any profile data is modified.

### Acceptance criteria

```gherkin
Feature: Structured change proposal via confirmation card

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And client "client-abc" has the following profile:
      | field           | value              |
      | full_name       | "Elizabeth Chen"   |
      | phone_number    | "+447700900001"    |
      | tags            | ["VIP"]            |
      | preferences     | { "hair_type": "2C", "preferred_time": "afternoons" } |
    And the workspace has vertical custom fields: ["hair_type", "preferred_time", "skin_type"]

  Scenario: Name change proposal shows before/after diff
    Given the categorization job extracted a name change from a note
    When a ProposedAction is created with actionType "client_update"
    Then a confirmation card appears in the client thread with:
      | element      | content                                    |
      | summary      | "Update client name"                        |
      | field        | "full_name"                                 |
      | before       | "Elizabeth Chen"                             |
      | after        | "Liz Chen"                                  |
    And the card displays "Approve" and "Reject" buttons

  Scenario: Preference update proposal shows the specific field changed
    Given the categorization job extracted a preference change from a note
    When a ProposedAction is created for a preferences field change
    Then the confirmation card shows:
      | element      | content                                    |
      | summary      | "Update client preference: preferred_time"  |
      | field        | "preferences.preferred_time"                |
      | before       | "afternoons"                                |
      | after        | "mornings"                                  |

  Scenario: Tag addition proposal shows current tags and proposed addition
    Given the categorization job detected a tag mention in a note: "She's a bride-to-be"
    When a ProposedAction is created to add a tag
    Then the confirmation card shows:
      | element      | content                                    |
      | summary      | "Add tag: bride-to-be"                      |
      | before       | ["VIP"]                                     |
      | after        | ["VIP", "bride-to-be"]                      |

  Scenario: Staff approves a change proposal
    Given a confirmation card is visible for a name change to "Liz Chen"
    When staff taps "Approve"
    Then the client's full_name is updated to "Liz Chen"
    And the ProposedAction status changes to "approved"
    And an AuditEvent is logged with actor = "staff-001", action = "client_updated"
    And the confirmation card is marked as resolved

  Scenario: Staff rejects a change proposal
    Given a confirmation card is visible for a preference change
    When staff taps "Reject"
    Then no client data is modified
    And the ProposedAction status changes to "rejected"
    And an AuditEvent is logged with action = "proposal_rejected"
    And the confirmation card is marked as resolved with a "Rejected" indicator

  Scenario: Multiple change proposals from one note are independently actionable
    Given a note produced two ProposedActions (name change and preference update)
    Then two separate confirmation cards appear in the client thread
    And staff can approve one and reject the other
    And each card's approval/rejection is processed independently

  Scenario: Change proposal for a vertical custom field
    Given the note contains "Her skin type is combination"
    And "skin_type" is a defined custom field in workspace vertical_config
    When a ProposedAction is created
    Then the confirmation card shows:
      | field  | "preferences.skin_type"   |
      | before | null (not previously set) |
      | after  | "combination"             |

  Scenario: Change proposal for a field not in the updatable list is not created
    Given the note contains "She owes us $500"
    When the categorization job processes the note
    Then no ProposedAction is created for a financial balance field
    And the note content remains as free text for staff reference
```

### Notes

- Change proposals reuse the F-06 confirmation card infrastructure entirely. The `ProposedAction` has the same shape; the `ConfirmationRequest` renders the same card UI. The only difference is that the action originates from note categorization rather than from the Client Worker during conversation processing.
- The set of updatable fields is fixed per PRD section 9.4: `full_name`, `phone_number`, `email`, `tags`, `preferences` (including vertical custom fields), and `lifecycle_status`. The categorization LLM prompt must constrain proposals to these fields.
- When a note implies a change to a field that does not exist in the updatable list (e.g., pricing, balances, internal IDs), the system must not create a ProposedAction. The information stays as note text only.

---

## Story US-F13-03 — Conversational Context Update Parsing (NF-04)

**As a** staff member,
**I want to** type a natural-language update command like "update her name to Liz" in the note input field and have the system parse it into a structured change proposal with a confirmation card,
**so that** I can correct or update client data quickly without navigating to a profile edit form.

### Acceptance criteria

```gherkin
Feature: Conversational context update parsing

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And client "client-abc" has:
      | field           | value              |
      | full_name       | "Elizabeth Chen"   |
      | phone_number    | "+447700900001"    |
      | tags            | ["VIP"]            |
      | preferences     | { "hair_type": "2C" } |

  Scenario: Staff issues a name update command
    When staff types "update her name to Liz Chen" in the note input
    And submits it
    Then the system detects this as a conversational context update (not a regular note)
    And a Note record is created with source = "conversation_update"
    And a ProposedAction is created with:
      | field        | value              |
      | actionType   | "client_update"    |
      | before_state | { "full_name": "Elizabeth Chen" } |
      | after_state  | { "full_name": "Liz Chen" }      |
    And a confirmation card appears in the client thread

  Scenario: Staff issues a phone number update command
    When staff types "change phone to +447700900055"
    Then a confirmation card shows:
      | before | "+447700900001" |
      | after  | "+447700900055" |
    And the new phone number is normalized to E.164 format before display

  Scenario: Staff issues a tag update command
    When staff types "add tag wedding-party"
    Then a confirmation card shows:
      | before | ["VIP"]                    |
      | after  | ["VIP", "wedding-party"]   |

  Scenario: Staff issues a preference update command
    When staff types "set her hair type to 3A"
    Then a confirmation card shows:
      | field  | "preferences.hair_type" |
      | before | "2C"                    |
      | after  | "3A"                    |

  Scenario: Staff issues a tag removal command
    When staff types "remove VIP tag"
    Then a confirmation card shows:
      | before | ["VIP"]  |
      | after  | []       |

  Scenario: Ambiguous input is saved as a regular note
    When staff types "She mentioned she might change her number soon"
    Then the system does NOT detect this as a context update command
    And the input is saved as a regular note with source = "staff_manual"
    And async note categorization (US-F13-01) processes it normally

  Scenario: Update to an unsupported field is rejected gracefully
    When staff types "update her account balance to $0"
    Then no ProposedAction is created
    And the input is saved as a regular note with source = "staff_manual"
    And a subtle inline message indicates "account balance is not an updatable field"

  Scenario: Confirmation card must be approved before data changes
    Given a confirmation card was created from "update her name to Liz Chen"
    When staff has not yet approved the card
    Then the client's full_name remains "Elizabeth Chen"
    And the data only changes after staff taps "Approve"

  Scenario: Multiple update commands in one input
    When staff types "update name to Liz Chen and set preferred time to mornings"
    Then two separate confirmation cards are created:
      | card | field                      | before            | after      |
      | 1    | full_name                  | "Elizabeth Chen"   | "Liz Chen" |
      | 2    | preferences.preferred_time | null               | "mornings" |
    And each card is independently actionable
```

### Notes

- The system must distinguish between conversational update commands and regular notes. Reliable intent classification is critical here: "update her name to Liz" is a command; "She mentioned wanting to go by Liz" is an observation best handled by async categorization (US-F13-01).
- The classification heuristic should look for imperative verbs targeting known fields: "update," "change," "set," "add tag," "remove tag," etc. When confidence is low, the system should default to treating input as a regular note rather than misinterpreting a command.
- Conversation updates create a Note with `source = "conversation_update"` for audit trail purposes. The note content is the raw command text. The actual data change only happens if staff approves the confirmation card.
- Phone number normalization follows the same E.164 logic used in F-02/F-03.

---

## Story US-F13-04 — Promise Extraction from Conversation History (NF-08)

**As a** manager,
**I want** the system to automatically detect promises made by staff to clients in conversation history and create trackable follow-up records with deadlines,
**so that** no commitment falls through the cracks and my team delivers on every promise.

### Acceptance criteria

```gherkin
Feature: Promise extraction from conversation history

  Background:
    Given workspace "WS-001" exists with staff members "staff-001" and "staff-002"
    And client "client-abc" has an active conversation session
    And today's date is "2026-03-18"

  Scenario: Promise with explicit deadline is extracted
    Given a staff-sent message exists: "I'll send you the revised quote by Friday"
    And today is Wednesday, 2026-03-18
    When promise extraction runs for client "client-abc"
    Then a FollowUp record is created with:
      | field      | value                                  |
      | client_id  | "client-abc"                           |
      | type       | "promise"                              |
      | content    | "Send revised quote to client"         |
      | due_date   | "2026-03-20"                           |
      | status     | "open"                                 |
      | created_by | system (AI-extracted)                  |

  Scenario: Promise without explicit deadline is extracted with no due date
    Given a staff-sent message exists: "We'll hold your preferred slot for you"
    When promise extraction runs for client "client-abc"
    Then a FollowUp record is created with:
      | field    | value                                    |
      | type     | "promise"                                |
      | content  | "Hold client's preferred appointment slot"|
      | due_date | null                                     |
      | status   | "open"                                   |

  Scenario: Promise is extracted from a note as well as from messages
    Given staff saved a note: "Told her we'd match the competitor's price"
    When async categorization processes the note (US-F13-01)
    Then a FollowUp record is created with type = "promise" and content describing the price-matching commitment

  Scenario: Duplicate promise is not re-extracted
    Given a FollowUp with type "promise" already exists with content "Send revised quote to client"
    And a message exists: "I'll send you the revised quote by Friday"
    When promise extraction runs again
    Then no new duplicate FollowUp is created
    And the existing promise record is unchanged

  Scenario: Promise made by the business via AI draft is also detected
    Given an approved AI draft was sent: "We'll have the alterations ready by next Tuesday"
    When promise extraction runs
    Then a FollowUp is created with:
      | type     | "promise"                                    |
      | content  | "Have alterations ready for client"           |
      | due_date | "2026-03-24"                                 |

  Scenario: Client requests that imply a promise are not extracted
    Given a client-sent message exists: "Can you send me the quote by Friday?"
    When promise extraction runs
    Then no FollowUp with type "promise" is created from the client's message
    But a follow-up suggestion may be created (see US-F13-05 for buying signal detection)

  Scenario: Extracted promises appear in context assembly
    Given a promise FollowUp exists for client "client-abc" with status "open"
    When context assembly runs for "client-abc" (F-05)
    Then the promise appears in the activeFollowUps section
    And the AI is aware of outstanding commitments when generating draft replies

  Scenario: Promise extraction does not modify the source message or note
    When promise extraction creates a FollowUp record
    Then the original message or note content is unchanged
    And the FollowUp includes a reference to the source (message_id or note_id)
```

### Notes

- Promise extraction can run as part of async note categorization (US-F13-01) for notes, or as a separate extraction pass over recent conversation messages. Per ADR-4, promise extraction from conversation history dispatches through the Client Worker path.
- The deduplication check compares the semantic content of the detected promise against existing open FollowUp records of type "promise" for the same client. An exact string match is insufficient; the LLM should assess semantic equivalence.
- Promises are distinguished from follow-ups by the `type` field. Promises represent commitments made *to* the client; follow-ups represent tasks the staff needs to do. This distinction matters for COS prioritization in F-12 (broken promises are higher urgency than missed follow-ups).
- Promise extraction should only trigger on staff-sent messages and staff notes, not on client messages. Client requests are handled by buying signal detection (US-F13-05).

---

## Story US-F13-05 — Buying Signal Detection and Follow-up Suggestion

**As a** staff member,
**I want** the system to automatically detect buying signals in client conversations — such as questions about pricing, availability, or specific services — and suggest a follow-up to nurture the lead,
**so that** potential bookings are not lost because I forgot to follow up on a warm lead.

### Acceptance criteria

```gherkin
Feature: Buying signal detection and follow-up suggestion

  Background:
    Given workspace "WS-001" exists
    And client "client-xyz" has an active conversation session
    And the workspace knowledge base includes service offerings and pricing

  Scenario: Pricing inquiry triggers a follow-up suggestion
    Given client "client-xyz" sends a message: "How much does a deep tissue massage cost?"
    When the AI processes the inbound message
    Then a ProposedAction is created with:
      | field      | value                                                              |
      | actionType | "followup_create"                                                  |
      | payload    | { "type": "follow_up", "content": "Client inquired about deep tissue massage pricing — follow up to convert to booking", "suggested_due_date": "2026-03-21" } |
      | tier       | "review"                                                           |
    And a confirmation card appears suggesting the follow-up
    And staff can approve, modify, or reject the suggestion

  Scenario: Availability question triggers a follow-up suggestion
    Given client "client-xyz" sends: "Do you have any openings this Saturday?"
    When the AI processes the message
    Then a follow-up suggestion is created with content referencing the client's interest in a Saturday appointment
    And the suggested due date is before the requested Saturday

  Scenario: Service comparison question is detected as a buying signal
    Given client "client-xyz" sends: "What's the difference between the basic and premium facial?"
    When the AI processes the message
    Then a follow-up suggestion is created noting the client is comparing service tiers
    And the follow-up content captures the specific services being compared

  Scenario: General conversation is NOT flagged as a buying signal
    Given client "client-xyz" sends: "Thanks for the appointment yesterday, it was great!"
    When the AI processes the message
    Then no buying-signal follow-up suggestion is created

  Scenario: Staff approves a buying signal follow-up
    Given a confirmation card suggests: "Client inquired about deep tissue massage pricing — follow up to convert to booking"
    When staff taps "Approve"
    Then a FollowUp record is created with:
      | field      | value                     |
      | type       | "follow_up"               |
      | status     | "open"                    |
      | created_by | system (with staff approval) |
    And the follow-up appears in the client's active items
    And the follow-up is included in context assembly for future AI drafts

  Scenario: Staff rejects a buying signal follow-up
    Given a confirmation card suggests a buying-signal follow-up
    When staff taps "Reject"
    Then no FollowUp record is created
    And an audit event is logged with action = "proposal_rejected"

  Scenario: Repeated buying signals for the same service do not create duplicate suggestions
    Given a follow-up already exists: "Client inquired about deep tissue massage pricing"
    And the client sends another message: "Just checking — is the deep tissue massage still $120?"
    When the AI processes the new message
    Then no duplicate follow-up suggestion is created
    And the existing follow-up remains active

  Scenario: Buying signal follow-up includes relevant context from the knowledge base
    Given the workspace knowledge base contains "Deep tissue massage — 60 min — $120"
    When a buying signal follow-up is suggested for a pricing inquiry
    Then the follow-up content or the associated AI draft references the current pricing
    And staff has the information needed to respond effectively
```

### Notes

- Buying signal detection runs as part of the normal Client Worker invocation (F-05) during inbound message processing. It does not require a separate job. The Client Worker's intent classification should include a "buying_signal" category that triggers follow-up proposal generation.
- The suggested due date defaults to 3 business days from detection, giving staff time to follow up before the lead cools. Staff can modify the date when approving.
- The follow-up creation goes through the standard F-06 approval flow (`propose_write` authority). The AI cannot create a follow-up without staff confirmation.
- Deduplication checks against existing open follow-ups for the same client to avoid spamming staff with repeated suggestions when a client sends multiple related messages.
- This story extends the lead nurturing foundation established in US-F09-04 (manual lead follow-ups) with automated detection.

---

## Story US-F13-06 — Deadline Inference for Promises and Follow-ups

**As a** staff member,
**I want** the system to automatically resolve relative date references in promises and follow-ups (like "next Thursday" or "by end of week") into absolute calendar dates,
**so that** follow-up records have concrete deadlines that the COS engine can use for overdue detection and prioritization.

### Acceptance criteria

```gherkin
Feature: Deadline inference for promises and follow-ups

  Background:
    Given today's date is Wednesday, 2026-03-18
    And the workspace timezone is "Europe/London"

  Scenario: "Next Thursday" resolves to the correct absolute date
    Given a note contains "I promised to call her back next Thursday"
    When the categorization job extracts the promise
    Then the FollowUp due_date is set to "2026-03-26" (the next Thursday)

  Scenario: "By Friday" resolves to the nearest upcoming Friday
    Given a staff message says "I'll send you the quote by Friday"
    When promise extraction processes the message
    Then the FollowUp due_date is set to "2026-03-20" (the upcoming Friday)

  Scenario: "End of week" resolves to the workspace's end-of-week day
    Given a note contains "Will have the estimate ready by end of week"
    When the categorization job processes the note
    Then the FollowUp due_date is set to "2026-03-20" (Friday of the current week)

  Scenario: "Tomorrow" resolves relative to the message/note timestamp
    Given a note was saved at 2026-03-18 and contains "I'll confirm tomorrow"
    When the categorization job processes the note
    Then the FollowUp due_date is set to "2026-03-19"

  Scenario: "In two weeks" resolves to 14 days from the source date
    Given a staff message sent on 2026-03-18 says "We can have it ready in two weeks"
    When promise extraction processes the message
    Then the FollowUp due_date is set to "2026-04-01"

  Scenario: Specific date mentioned directly is used as-is
    Given a note contains "Promised to deliver by March 28"
    When the categorization job processes the note
    Then the FollowUp due_date is set to "2026-03-28"

  Scenario: No temporal reference results in null due_date
    Given a note contains "We'll keep her preferred slot available"
    When the categorization job processes the note
    Then the FollowUp due_date is null
    And the follow-up is still created with status "open"

  Scenario: Past dates are flagged rather than silently accepted
    Given a note saved on 2026-03-18 contains "Should have called her last Monday"
    When the categorization job processes the note
    Then the FollowUp due_date is set to "2026-03-16" (last Monday)
    And the FollowUp status is set to "overdue" (since due_date is in the past)

  Scenario: Date resolution uses the workspace timezone
    Given the workspace timezone is "Asia/Tokyo" (UTC+9)
    And a note is saved at 2026-03-18 23:00 UTC (2026-03-19 08:00 JST)
    And the note says "I'll follow up tomorrow"
    When the categorization job processes the note
    Then "tomorrow" is resolved relative to the local date 2026-03-19
    And the FollowUp due_date is set to "2026-03-20"
```

### Notes

- Date inference happens within the LLM call during categorization or promise extraction. The LLM receives the current date (in workspace timezone) and the timestamp of the source message or note as context, and outputs an absolute ISO 8601 date.
- The workspace timezone is critical for correct resolution. "Tomorrow" at 11 PM UTC means different calendar dates depending on the timezone. All date references should be resolved in the workspace's local timezone.
- If the inferred date is in the past relative to the current date, the FollowUp should still be created, but with `status = "overdue"` so it appears immediately in the COS overdue items list (F-12).
- Ambiguous dates (e.g., "March" without a day, "soon") should result in `due_date = null` rather than a guess. The system should only set a due_date when the temporal reference is specific enough to resolve with reasonable confidence.

---

## Story US-F13-07 — Categorization Failure Resilience

**As a** staff member,
**I want** a failed AI categorization to never block my note from being saved or prevent me from using the system,
**so that** I can always capture information reliably regardless of AI availability or processing errors.

### Acceptance criteria

```gherkin
Feature: Categorization failure resilience

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And a client record exists with client_id "client-abc"

  Scenario: LLM call failure does not affect the saved note
    Given staff saves a note "Follow up about her wedding dress order"
    And the Note record is created with extraction_status = "pending"
    When the async categorization job runs and the LLM call fails (timeout, API error, rate limit)
    Then the Note record remains intact with its original content
    And the extraction_status is updated to "failed"
    And an error is logged with the failure reason and note_id
    And no FollowUp or ProposedAction records are created from this attempt

  Scenario: Failed categorization is retried automatically
    Given a note has extraction_status = "failed"
    When the retry scheduler runs (next retry cycle)
    Then the categorization job is re-enqueued for the failed note_id
    And the retry attempt uses exponential backoff (e.g., 1 min, 5 min, 30 min)

  Scenario: Maximum retry attempts are respected
    Given a note has been retried 3 times and all attempts failed
    When the fourth retry would be scheduled
    Then no further automatic retries are enqueued
    And the extraction_status remains "failed"
    And an alert is logged for operational monitoring
    And the note remains fully readable and usable as raw text

  Scenario: Failed categorization does not block compaction
    Given client "client-abc" has notes with the following extraction statuses:
      | note_id | extraction_status |
      | note-1  | "complete"        |
      | note-2  | "failed"          |
      | note-3  | "complete"        |
    When the daily compaction job (F-11) runs for "client-abc"
    Then compaction proceeds (failed notes are treated as resolved for compaction purposes)
    And the compaction includes the raw text of the failed note in the summary input
    And only notes with extraction_status = "pending" block compaction

  Scenario: Pending categorization blocks compaction (flush-before-compact)
    Given client "client-abc" has a note with extraction_status = "pending"
    When the daily compaction job (F-11) runs for "client-abc"
    Then compaction is deferred for "client-abc"
    And compaction proceeds normally for other clients without pending notes

  Scenario: Staff can manually trigger re-categorization of a failed note
    Given a note has extraction_status = "failed"
    When staff views the note in the client thread
    Then the note displays a subtle indicator that categorization failed
    And a "Retry" option is available
    When staff taps "Retry"
    Then a new categorization job is enqueued for the note
    And extraction_status is set back to "pending"

  Scenario: Malformed LLM output is treated as a categorization failure
    Given the categorization job runs and the LLM returns unparseable output
    When the system attempts to parse the categorization result
    Then the note's extraction_status is set to "failed"
    And no partial or malformed records are created
    And the error is logged with the raw LLM output for debugging

  Scenario: Conversational context update parsing failure falls back to regular note
    Given staff types "update her name to Liz"
    And the intent parsing LLM call fails
    Then the input is saved as a regular note with source = "staff_manual"
    And extraction_status is set to "pending" (for async categorization retry)
    And staff sees a brief message: "Saved as note. Update could not be processed — will retry."
```

### Notes

- The fundamental invariant: **note persistence is decoupled from AI processing.** The note is written to the database by F-09 before F-13's async pipeline begins. No AI failure path can delete, modify, or prevent a note from being saved.
- The `extraction_status` lifecycle is: `pending` (just saved, awaiting processing) -> `complete` (categorization succeeded) or `failed` (all retries exhausted). Notes with `source` values that do not require categorization (e.g., `merge_history`) are set to `not_applicable` at creation time.
- For the flush-before-compact invariant, only `pending` status blocks compaction. `failed` status does not block — the raw note content is still available for the compaction LLM to summarize, and the structured extraction is treated as best-effort.
- Retry policy: 3 automatic retries with exponential backoff. After exhaustion, the note remains usable as raw text. Operational monitoring should alert on sustained categorization failure rates.
- The conversational context update path (NF-04) has a special fallback: if intent parsing fails, the input is saved as a regular note and enters the async categorization pipeline, which may succeed on a subsequent attempt.

---

## Story map summary

| Story | PRD functions | Scope | Size estimate |
|-------|--------------|-------|---------------|
| US-F13-01 Async AI note categorization | NF-02 | Async LLM job, multi-extraction, writes FollowUp + ProposedAction | M |
| US-F13-02 Structured change proposal via confirmation card | NF-03 | Before/after diff in confirmation card, reuses F-06 approval flow | S |
| US-F13-03 Conversational context update parsing | NF-04 | Intent classification for update commands, NLP parsing | M |
| US-F13-04 Promise extraction from conversation history | NF-08 | LLM scan of messages + notes, deduplication, FollowUp creation | M |
| US-F13-05 Buying signal detection and follow-up suggestion | (Lead nurturing extension) | Intent classification for buying signals, ProposedAction creation | M |
| US-F13-06 Deadline inference for promises and follow-ups | NF-08 (extended) | Relative-to-absolute date resolution, timezone handling | S |
| US-F13-07 Categorization failure resilience | NF-02 (non-functional) | Retry logic, failure isolation, compaction invariant | S |

**Total feature size: L** (as per feature-list.md — the async LLM pipeline, multiple extraction types, integration with the F-06 approval flow, promise deduplication, and the flush-before-compact invariant justify the sizing.)

---

## Out of scope for F-13

- **Immediate note save** (NF-01) — Phase 2, covered by F-09. F-13 operates on notes already persisted by F-09.
- **Follow-up creation and status management** (NF-05, NF-06) — Phase 2, covered by F-09. F-13 uses the FollowUp model but does not own it.
- **Daily follow-up surfacing by COS** (NF-07) — Phase 3, covered by F-12. The FollowUp records created by F-13 feed into COS prioritization.
- **Approval policy evaluation and confirmation card rendering** (AG-01, AG-02) — Phase 2, covered by F-06. F-13 creates ProposedActions that enter the existing F-06 pipeline.
- **Client Worker and context assembly** — Phase 2, covered by F-05. Buying signal detection runs within the Client Worker; the follow-up suggestion is the output that F-13 defines.
- **Daily compaction** (CS-05, CS-06) — Phase 3, covered by F-11. F-13 maintains the `extraction_status` field that F-11's flush-before-compact invariant checks.
