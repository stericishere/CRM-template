# User Stories — F-10: Learning Signal Capture

**Feature:** F-10 — Learning Signal Capture
**Phase:** 2 (AI Drafting & Booking)
**Size:** S
**PRD Functions:** LL-01
**Architecture modules:** `learning-optimization` (RecordDraftEditSignal, DraftEditSignal)
**Last updated:** March 2026

---

## Context

F-10 lays the raw data foundation for the entire learning loop. Every time a staff member acts on an AI-generated draft — sends it unchanged, edits and sends it, regenerates it, or discards it — the system writes one structured `DraftEditSignal` record to the database.

No LLM is involved. This is a pure synchronous database write that happens at the moment of staff action. The record captures:

- **`original_draft`** — the exact text the AI produced
- **`final_version`** — the text actually sent (null if discarded or regenerated without sending)
- **`staff_action`** — the categorical outcome: `sent_as_is`, `edited_and_sent`, `regenerated`, or `discarded`
- **`intent_classified`** — the intent label the Client Worker assigned to the inbound message
- **`scenario_type`** — the scenario classification (e.g., booking inquiry, FAQ, follow-up)
- **`draft_id`**, **`client_id`**, **`workspace_id`** — relational keys for all future aggregation

The fields `edit_categories`, `pattern_key`, `client_replied`, and `client_reply_latency_minutes` exist on the schema but are intentionally null at write time; they are populated in Phase 3 (F-14) and Phase 4 (F-15) respectively.

F-10 depends on F-05 (AI Drafting) being operational — signals can only be recorded when drafts exist.

---

## Story US-F10-01: Draft edit signal recorded when staff sends a reply (LL-01)

**As a** workspace manager,
**I want** every staff send action on an AI draft to be recorded as a structured learning signal,
**so that** the system accumulates raw data about how staff use, edit, and override AI suggestions — enabling future quality improvement without any manual instrumentation.

### Acceptance criteria

```gherkin
Feature: Draft edit signal recorded at send time

  Background:
    Given the workspace has AI drafting active (F-05 operational)
    And a client has sent an inbound message
    And the Client Worker has generated a draft reply with intent_classified and scenario_type populated
    And a staff member is reviewing the draft in the staff app

  Scenario: Staff sends draft without editing (sent_as_is)
    Given the draft text has not been modified since generation
    When the staff member clicks "Send"
    Then a DraftEditSignal record is written with:
      | Field            | Value                                     |
      | staff_action     | sent_as_is                                |
      | original_draft   | the exact AI-generated draft text         |
      | final_version    | the same text as original_draft           |
      | draft_id         | the UUID of the draft record              |
      | client_id        | the client UUID for this conversation     |
      | workspace_id     | the workspace UUID                        |
      | intent_classified| the intent label from the draft record    |
      | scenario_type    | the scenario type from the draft record   |
      | created_at       | the current UTC timestamp                 |
    And the signal is written before the WhatsApp message is dispatched
    And the send proceeds normally regardless of whether the signal write succeeds

  Scenario: Staff edits the draft and sends (edited_and_sent)
    Given the staff member has modified the draft text in the compose field
    When the staff member clicks "Send"
    Then a DraftEditSignal record is written with:
      | Field            | Value                                     |
      | staff_action     | edited_and_sent                           |
      | original_draft   | the original AI-generated text            |
      | final_version    | the edited text as sent to the client     |
      | draft_id         | the UUID of the draft record              |
      | intent_classified| the intent label from the draft record    |
      | scenario_type    | the scenario type from the draft record   |
    And original_draft and final_version are different strings
    And the signal is written atomically with updating the draft record's staff_action field

  Scenario: Staff sends an edited draft where only whitespace changed
    Given the staff member has only added or removed leading/trailing whitespace
    When the staff member clicks "Send"
    Then a DraftEditSignal record is written with staff_action "edited_and_sent"
    And final_version reflects the trimmed sent text
    And original_draft retains the exact original AI output

  Scenario: Signal write failure does not block message delivery
    Given the learning_signals table write fails (e.g., transient database error)
    When the staff member clicks "Send"
    Then the WhatsApp message is still dispatched to the client
    And the signal write failure is logged with the draft_id and error reason
    And no error is surfaced to the staff member in the UI
```

### Notes

- Signal write is best-effort: message delivery is the primary operation. A failed signal write must not surface to staff or block the conversation flow.
- The draft record's `staff_action` and `reviewed_at` fields (§12.6) are updated in the same operation as the signal write — they share the same action event.
- `intent_classified` and `scenario_type` are copied from the draft record at write time; they do not require a new LLM call.
- Schema reference: PRD §12.14 (DraftEditSignal), §17.1 (Signal capture).

---

## Story US-F10-02: Signal data completeness for all required fields (LL-01)

**As a** data analyst (or future LearningWorker in Phase 4),
**I want** every DraftEditSignal record to contain all seven required fields populated with non-null values,
**so that** downstream aggregation and diff classification can run against the full dataset without filtering out incomplete records.

### Acceptance criteria

```gherkin
Feature: DraftEditSignal required field completeness

  Background:
    Given a DraftEditSignal has been written for any staff action

  Scenario: All required fields are non-null
    Then the signal record satisfies:
      | Field             | Constraint                                        |
      | signal_id         | UUID, non-null, unique                            |
      | workspace_id      | UUID, non-null, valid FK to workspaces            |
      | client_id         | UUID, non-null, valid FK to clients               |
      | draft_id          | UUID, non-null, valid FK to drafts                |
      | staff_action      | one of: sent_as_is, edited_and_sent, regenerated, discarded |
      | original_draft    | non-null, non-empty text                          |
      | intent_classified | non-null, non-empty string                        |
      | scenario_type     | non-null, non-empty string                        |
      | created_at        | UTC timestamp, non-null                           |

  Scenario: final_version is null only for discard and regeneration actions
    Given a signal with staff_action "discarded" or "regenerated"
    Then final_version is null
    Given a signal with staff_action "sent_as_is" or "edited_and_sent"
    Then final_version is a non-null, non-empty string

  Scenario: Phase 4 fields are null at creation time
    When a new signal is written in Phase 2
    Then edit_categories is null
    And pattern_key is null
    And client_replied is null
    And client_reply_latency_minutes is null

  Scenario: Draft without intent or scenario type cannot produce a valid signal
    Given the Client Worker generated a draft but intent_classified or scenario_type is missing
    When the staff member attempts to send
    Then the system falls back to writing the signal with a sentinel value of "unclassified"
    And an error is logged indicating the missing classification
    And the send action proceeds normally

  Scenario: Database constraint enforces staff_action enum values
    Given an application attempts to write a DraftEditSignal with an unknown staff_action value
    Then the database rejects the insert with a constraint violation
    And the error is caught and logged at the application layer
    And no partial record is written
```

### Notes

- `final_version` nullability is by design: a discard produces no sent text; a regeneration replaces the draft rather than sending it.
- The `unclassified` sentinel for missing `intent_classified` / `scenario_type` is a defensive fallback. In normal operation F-05 always populates these fields before the draft reaches the staff review screen.
- `edit_categories` and `pattern_key` are populated by F-15 (LearningWorker) in Phase 4 via an UPDATE to existing signal records.
- `client_replied` and `client_reply_latency_minutes` are populated by F-14 (Acceptance Metrics) in Phase 3.
- All records are scoped by `workspace_id`; no cross-tenant signal reads are permitted.

---

## Story US-F10-03: Signal capture for discard and multiple-regeneration flows (LL-01)

**As a** workspace manager,
**I want** discarded drafts and intermediate regenerations to each produce their own signal record,
**so that** the full picture of staff effort and AI performance is captured — not just the final sent message.

### Acceptance criteria

```gherkin
Feature: Signal capture for discard and regeneration edge cases

  Background:
    Given a staff member is reviewing an AI draft for a client conversation

  Scenario: Staff discards a draft without sending
    Given the staff member clicks "Discard" on the draft
    When the discard action is confirmed
    Then a DraftEditSignal record is written with:
      | Field          | Value                             |
      | staff_action   | discarded                         |
      | original_draft | the AI-generated draft text       |
      | final_version  | null                              |
      | draft_id       | the UUID of the discarded draft   |
    And the conversation thread shows no outbound message was sent
    And no WhatsApp message is dispatched to the client

  Scenario: Staff discards a draft and then writes a manual reply
    Given the staff member has discarded the AI draft
    When the staff member composes and sends a manual message (not using the draft)
    Then the discard signal was already written when discard was clicked
    And no additional learning signal is written for the manual reply
    And the manual reply is sent through the standard message pipeline

  Scenario: Staff regenerates once, then sends the new draft as-is
    Given the staff member clicks "Regenerate" on the original draft
    When the new draft is generated and the staff member clicks "Send"
    Then two DraftEditSignal records exist for this conversation turn:
      | Signal | staff_action | draft_id              |
      | 1st    | regenerated  | the original draft ID |
      | 2nd    | sent_as_is   | the new draft ID      |
    And each signal references its own distinct draft_id
    And each signal retains the original_draft text for its own draft record

  Scenario: Staff regenerates multiple times before sending
    Given the staff member regenerates a draft 3 times before sending the final version
    When the staff member sends the 3rd regenerated draft
    Then 4 DraftEditSignal records exist for this conversation turn:
      | Signal | staff_action |
      | 1st    | regenerated  |
      | 2nd    | regenerated  |
      | 3rd    | regenerated  |
      | 4th    | sent_as_is   |
    And each of the first 3 signals has final_version null
    And the 4th signal has final_version equal to the sent text

  Scenario: Regeneration limit reached (soft cap of 5)
    Given a staff member has regenerated a draft 5 times in the same thread
    When the staff member attempts a 6th regeneration
    Then the "Regenerate" button is disabled
    And a tooltip reads "Regeneration limit reached for this conversation"
    And all 5 previous regeneration signals have been written correctly
    And the staff member can still edit and send the current draft

  Scenario: Staff regenerates and then discards all drafts
    Given the staff member has regenerated once and now discards the second draft
    Then two DraftEditSignal records exist:
      | Signal | staff_action |
      | 1st    | regenerated  |
      | 2nd    | discarded    |
    And no outbound message is dispatched to the client
    And the conversation remains in an awaiting-reply state for staff to handle manually
```

### Notes

- Each regeneration creates a new draft record in the `drafts` table (new `draft_id`); the signal for the superseded draft is written at the moment the staff member clicks "Regenerate", not at send time.
- The discard signal is written immediately on the discard action — not deferred. This ensures the signal is captured even if the staff member closes the app before sending a manual reply.
- The 5-regeneration soft cap (PRD §18.4) is enforced in the UI; the signal layer itself does not gate on this count.
- In the multiple-regeneration scenario, `scenario_type` and `intent_classified` on each signal derive from their respective draft records. If the Client Worker reclassifies intent on regeneration, the new classification is captured on the new signal.
- These raw per-regeneration signals are the input for F-15's recurrence analysis; the LearningWorker will later compute the diff between `original_draft` and `final_version` on `edited_and_sent` records only.

---

## Story map summary

| Story | PRD Function | Actor | Priority |
|---|---|---|---|
| US-F10-01 | LL-01 | Manager (data foundation) | Must-have |
| US-F10-02 | LL-01 | System / Future LearningWorker | Must-have |
| US-F10-03 | LL-01 | Manager (data completeness) | Must-have |

All three stories are Phase 2 must-haves. US-F10-01 is the core behaviour; US-F10-02 and US-F10-03 are completeness and edge-case guards that protect the data quality F-14 and F-15 depend on. No story in this feature requires an LLM call.

## Open questions

1. **Signal write ordering** — should the signal write be part of the same database transaction as the draft `staff_action` update, or fire-and-forget after the send? A transaction guarantees consistency but adds latency; fire-and-forget risks a signal gap if the app crashes between send and write. Engineering to decide before sprint start.
2. **Manual replies after discard** — US-F10-03 specifies that manual replies (post-discard) do not produce a signal. Confirm with PM whether manually composed messages should ever be captured in the signal table (e.g., as a `manual` staff_action variant) for completeness.
3. **`scenario_type` source of truth** — the PRD defines `scenario_type` on the signal schema (§12.14) but does not enumerate the valid values. Engineering and PM need to align on the scenario taxonomy (e.g., `booking_inquiry`, `faq`, `follow_up_reply`, `complaint`, `other`) before the Client Worker is implemented.
4. **Regeneration signal timing** — US-F10-03 specifies the regeneration signal is written when "Regenerate" is clicked. Confirm this is preferable to writing it when the new draft arrives (which would allow capturing whether the LLM returned an error before writing the signal).
