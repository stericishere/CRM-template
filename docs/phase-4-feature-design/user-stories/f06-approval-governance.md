# User Stories — F-06: Approval Workflow & Governance

**Feature:** F-06 — Approval Workflow & Governance
**Phase:** 2 (AI Drafting & Booking)
**Size:** L
**PRD Functions:** AG-01, AG-02, AG-03, AG-04, AG-05, AG-07, NT-03, NT-04
**Architecture modules:** `agent-governance` (ProposedAction, ConfirmationRequest, ApprovalPolicy, EvaluateApprovalPolicy, ExecuteApprovedAction), `agent/ToolParamInjector`
**ADR dependencies:** ADR-1 (tools return ProposedAction, not direct writes)
**Depends on:** F-04 (audit event foundation), F-05 (Client Worker produces ProposedActions)
**Last updated:** March 2026

---

## Context

F-06 implements the approval boundary — the architectural rule that **only deterministic application services may commit writes** (Architecture Specification, core rule). The Client Worker (F-05) proposes actions; this feature evaluates, gates, and executes them.

Every action produced by the Client Worker is wrapped in a `ProposedAction` and classified into one of three trust tiers defined in PRD section 8:

| Tier | Examples | System behaviour |
|---|---|---|
| **Auto-allowed** | Update `last_contacted_at`, save AI-extracted note, attach low-risk tags, propose time slots (read-only) | Executes immediately. Audit logged. |
| **Suggest for review** | Change client name, modify appointment details, create bookings, modify lifecycle status, draft replies, propose follow-ups | Staff sees a confirmation card. Applied only after explicit approval. |
| **Human-only** | Refunds, pricing changes, policy exceptions, negotiation, complaint handling, liability commitments | Flags for manual handling. AI does not draft or propose. |

The MVP trust model is fixed (not configurable per workspace). All draft replies require staff review.

In addition, F-06 owns the `ToolParamInjector` — the critical safety mechanism that injects `workspaceId` and `clientId` from the session key into every tool call at runtime, preventing the LLM from overriding session scope. This ensures session isolation by construction (Architecture section 4.4).

Finally, F-06 adds two notification types on top of the F-04 notification foundation: a draft-ready notification when a draft or confirmation card is ready for review (NT-03), and an escalation re-notification when staff has not acted within a timeout window (NT-04).

---

## Story US-F06-01: Approval policy evaluation (AG-01)

**As a** system operator,
**I want** every ProposedAction returned by the Client Worker to be classified into a trust tier (auto-allowed, suggest-for-review, or human-only) before any write is committed,
**so that** dangerous or sensitive actions are never executed without staff oversight, and safe actions proceed without unnecessary friction.

### Acceptance criteria

```gherkin
Feature: Approval policy evaluation classifies ProposedActions into trust tiers

  Background:
    Given the Client Worker has completed an LLM invocation for workspace "WS-001" and client "CL-042"
    And the Client Worker returns one or more ProposedAction objects
    And the ApprovalPolicyEvaluator is configured with the fixed MVP trust model

  Scenario: Auto-allowed action is classified and executed immediately
    Given the Client Worker returns a ProposedAction with actionType "note_create" and source "ai_extracted"
    When the ApprovalPolicyEvaluator evaluates the action
    Then the action's tier is set to "auto"
    And the ActionExecutor executes the action immediately
    And an AuditEvent is written with actor_type "ai" and the relevant action_type
    And no ConfirmationRequest is created
    And no staff notification is sent for this action

  Scenario: Review-tier action is classified and held for staff confirmation
    Given the Client Worker returns a ProposedAction with actionType "booking_create"
    When the ApprovalPolicyEvaluator evaluates the action
    Then the action's tier is set to "review"
    And the action's status is set to "pending"
    And the action is persisted to the proposed_actions table
    And a ConfirmationRequest is created (see US-F06-02)
    And no write is committed to the target table

  Scenario: Human-only action is classified and escalated
    Given the Client Worker returns a ProposedAction with actionType that matches a human-only category (e.g., refund, pricing change, policy exception)
    When the ApprovalPolicyEvaluator evaluates the action
    Then the action's tier is set to "human_only"
    And the conversation is flagged for manual handling
    And no draft is generated for this action
    And no ConfirmationRequest is created
    And an AuditEvent is written with action_type reflecting the escalation

  Scenario: Multiple actions in a single invocation are evaluated independently
    Given the Client Worker returns 3 ProposedActions:
      | actionType        | expected tier |
      | note_create       | auto          |
      | client_update     | review        |
      | booking_create    | review        |
    When the ApprovalPolicyEvaluator evaluates all actions
    Then the note_create action executes immediately
    And the client_update and booking_create actions each produce a ConfirmationRequest
    And each action has its own independent status lifecycle

  Scenario: Unknown or unmapped action type defaults to review tier
    Given the Client Worker returns a ProposedAction with an actionType not explicitly listed in the policy
    When the ApprovalPolicyEvaluator evaluates the action
    Then the action's tier defaults to "review"
    And a warning is logged identifying the unmapped action type

  Scenario: All classified actions carry the session key
    Given the Client Worker returns a ProposedAction
    When the ApprovalPolicyEvaluator evaluates it
    Then the ProposedAction's sessionKey is "workspace:WS-001:client:CL-042"
    And all downstream writes (audit, confirmation) are scoped to this session key
```

### Notes

- The trust tier mapping is fixed for MVP (PRD section 8: "MVP trust model is fixed"). Post-MVP, workspace-level policy customization is a candidate extension.
- The ApprovalPolicyEvaluator is a pure function: `(ProposedAction, ApprovalPolicy) -> tier`. It has no side effects and is independently testable.
- The `auto_write` authority on tools like `create_note` (Architecture section 4.3) means the tool itself returns a result immediately, but the audit event is still written. This is distinct from `propose_write` tools that always return a `ProposedAction`.
- Unmapped action types defaulting to "review" follows the principle of least privilege.

---

## Story US-F06-02: Confirmation card generation for review-tier actions (AG-02)

**As a** staff member,
**I want** to see a clear confirmation card for every action the AI proposes that requires my approval,
**so that** I can understand exactly what the AI wants to do and approve or reject it with confidence.

### Acceptance criteria

```gherkin
Feature: Confirmation card creation for review-tier ProposedActions

  Background:
    Given a ProposedAction has been evaluated as tier "review" by the ApprovalPolicyEvaluator
    And the ProposedAction has status "pending"

  Scenario: Confirmation card is created for a client_update action
    Given the ProposedAction has actionType "client_update"
    And the payload contains changes: { "lifecycle_status": "chosen_service" }
    When the ConfirmationRequest is created
    Then the card includes:
      | Field        | Content                                               |
      | summary      | A human-readable description (e.g., "Update lifecycle status to chosen_service") |
      | actionType   | "client_update"                                       |
      | before_state | The current value of the field being changed           |
      | after_state  | The proposed new value                                 |
      | proposed_action_id | The UUID of the ProposedAction                   |
    And the card is visible in the client's conversation thread in the staff app
    And the card displays "Approve" and "Reject" action buttons

  Scenario: Confirmation card for a booking_create action
    Given the ProposedAction has actionType "booking_create"
    And the payload contains slot, appointment type, and notes
    When the ConfirmationRequest is created
    Then the card summary reads a human-readable booking description (e.g., "Book Initial Consultation on 22 Mar at 14:00")
    And the card displays the appointment type, date, time, and duration
    And the card displays the client name and any notes

  Scenario: Confirmation card for a followup_create action
    Given the ProposedAction has actionType "followup_create"
    And the payload contains a description and optional due date
    When the ConfirmationRequest is created
    Then the card summary describes the follow-up (e.g., "Create follow-up: Confirm fabric selection by 25 Mar")
    And the card displays the due date if provided

  Scenario: Confirmation card for a message_send (draft reply) action
    Given the ProposedAction has actionType "message_send"
    And the payload contains the draft reply text
    When the ConfirmationRequest is created
    Then the card displays the full draft text for staff review
    And the staff can edit the draft inline before approving (see F-05 for edit flow)

  Scenario: Multiple confirmation cards appear in chronological order
    Given the Client Worker returns 2 review-tier ProposedActions from the same invocation
    When both ConfirmationRequests are created
    Then both cards appear in the conversation thread
    And they are ordered by creation timestamp (oldest first)
    And each card is independently actionable (approving one does not affect the other)

  Scenario: Confirmation card persists until acted upon
    Given a ConfirmationRequest has been created
    And the staff member has not yet approved or rejected it
    When the staff member navigates away and returns to the conversation thread
    Then the confirmation card is still visible with "Approve" and "Reject" buttons
    And the ProposedAction status remains "pending"

  Scenario: Confirmation card shows before/after state for data changes
    Given the ProposedAction modifies an existing record
    When the ConfirmationRequest is created
    Then the card clearly labels the current value (before) and the proposed value (after)
    And the diff is visually distinguishable (e.g., old value struck-through, new value highlighted)
```

### Notes

- Confirmation cards live in the `confirmation_requests` table and are associated with a `proposed_action_id`.
- The staff app renders cards inline within the conversation thread, not as a separate queue. This ensures staff see proposed actions in context alongside the conversation.
- Draft reply cards (actionType `message_send`) support inline editing, which is the F-05 edit/reprompt flow. This story covers card generation; F-05 covers the edit interaction.
- Before/after state rendering requires the ConfirmationRequest to snapshot the current value at creation time. The payload stores `before_state` and `after_state`.

---

## Story US-F06-03: Staff approval processing (AG-03)

**As a** staff member,
**I want** to approve a proposed action with a single tap and have the system execute it immediately,
**so that** AI suggestions translate into real results without me needing to perform the underlying operation manually.

### Acceptance criteria

```gherkin
Feature: Staff approval executes the proposed action

  Background:
    Given I am a logged-in staff member
    And a ConfirmationRequest is visible in a client's conversation thread
    And the associated ProposedAction has status "pending"

  Scenario: Staff approves a client_update action
    Given the ProposedAction has actionType "client_update"
    And the payload proposes changing lifecycle_status from "open" to "chosen_service"
    When I tap "Approve"
    Then the ProposedAction status changes to "approved"
    And the ProposedAction.reviewedAt is set to the current timestamp
    And the ProposedAction.reviewedBy is set to my staff_id
    And the ActionExecutor updates the client record with the proposed changes
    And an AuditEvent is written with:
      | Field          | Value                                    |
      | actor_type     | staff                                    |
      | actor_id       | my staff_id                              |
      | action_type    | client_updated                           |
      | target_entity  | client                                   |
      | metadata.before | the prior field values                  |
      | metadata.after  | the new field values                    |
      | metadata.proposed_action_id | the ProposedAction UUID       |
    And the confirmation card in the UI updates to show "Approved" with a timestamp

  Scenario: Staff approves a booking_create action
    Given the ProposedAction has actionType "booking_create"
    When I tap "Approve"
    Then the ActionExecutor creates the booking record
    And a Google Calendar event is created (see F-07)
    And an AuditEvent is written with action_type "booking_created"
    And the confirmation card shows "Approved"

  Scenario: Staff approves a followup_create action
    Given the ProposedAction has actionType "followup_create"
    When I tap "Approve"
    Then the ActionExecutor creates the follow-up record with the specified description and due date
    And an AuditEvent is written with action_type "followup_created"

  Scenario: Approval of an already-expired action
    Given the ProposedAction has status "expired" (e.g., the proposed time slot has passed)
    When I tap "Approve"
    Then the system shows an error: "This action has expired and can no longer be executed"
    And the ProposedAction status remains "expired"
    And no write is committed

  Scenario: Concurrent approval by two staff members
    Given two staff members view the same confirmation card simultaneously
    When both tap "Approve" within milliseconds
    Then only one approval is processed (optimistic locking on ProposedAction.status)
    And the second staff member sees a message: "This action has already been approved"
    And only one AuditEvent and one write are committed

  Scenario: Approval atomicity — if the underlying write fails, status is not changed
    Given I approve a booking_create action
    And the ActionExecutor fails to create the calendar event (e.g., Google Calendar API error)
    Then the ProposedAction status remains "pending"
    And an error is shown to me: "Action could not be completed — please try again"
    And the failure is logged with the error details
    And the confirmation card remains actionable
```

### Notes

- Approval is an atomic operation: status transition and underlying write must succeed together. If the write fails, the status must not change to "approved".
- The `reviewedBy` field links the approval to the specific staff member for accountability in the audit trail.
- Optimistic locking prevents double execution. Implementation options: database row-level lock, conditional UPDATE on `status = 'pending'`, or Supabase RPC with `WHERE status = 'pending'`.
- The ActionExecutor is responsible for dispatching to the correct domain service based on `actionType`. It is a router, not a monolith.

---

## Story US-F06-04: Staff rejection processing (AG-04)

**As a** staff member,
**I want** to reject a proposed action when the AI's suggestion is wrong or inappropriate,
**so that** incorrect actions are never applied and the rejection is permanently recorded for audit and learning purposes.

### Acceptance criteria

```gherkin
Feature: Staff rejection marks the action as rejected and logs an audit event

  Background:
    Given I am a logged-in staff member
    And a ConfirmationRequest is visible with a "Reject" button
    And the associated ProposedAction has status "pending"

  Scenario: Staff rejects a proposed action
    Given the ProposedAction has actionType "client_update"
    When I tap "Reject"
    Then the ProposedAction status changes to "rejected"
    And the ProposedAction.reviewedAt is set to the current timestamp
    And the ProposedAction.reviewedBy is set to my staff_id
    And no write is committed to the target entity
    And an AuditEvent is written with:
      | Field          | Value                                    |
      | actor_type     | staff                                    |
      | actor_id       | my staff_id                              |
      | action_type    | proposed_action_rejected                 |
      | target_entity  | proposed_action                          |
      | target_id      | the ProposedAction UUID                  |
      | metadata.action_type | the original actionType             |
      | metadata.payload     | the proposed change payload         |
    And the confirmation card updates to show "Rejected" with a timestamp

  Scenario: Rejection does not affect other pending actions in the same conversation
    Given 2 ConfirmationRequests are visible for the same client
    When I reject the first ProposedAction
    Then the second ProposedAction remains "pending" and its card remains actionable
    And only the first ProposedAction's status changes

  Scenario: Rejection is irreversible
    Given I have rejected a ProposedAction
    When I view the conversation thread
    Then the confirmation card shows "Rejected" and the "Approve" and "Reject" buttons are no longer visible
    And there is no "undo" or "re-approve" action available
    And the staff must request a new AI invocation if the action is actually needed

  Scenario: Rejection of an expired action
    Given the ProposedAction has already expired
    When I tap "Reject"
    Then the status remains "expired"
    And the card displays its expired state
    And no additional audit event is written (expiry was already logged)

  Scenario: Rejected action data is retained for learning signal analysis
    Given a ProposedAction has been rejected
    Then the full ProposedAction record (including payload, summary, and session key) remains in the database
    And the record is available for future learning loop analysis (F-15)
```

### Notes

- `proposed_action_rejected` is a new audit action type introduced by F-06. It must be added to the AG-06 enum defined in F-04.
- Rejection is final in MVP. An "undo reject" capability could be considered post-MVP but adds complexity and reduces auditability.
- Rejected ProposedActions are valuable learning signals. F-15 (Learning Loop) can use rejection patterns to detect recurring AI misjudgments.
- The rejection reason is not captured in MVP (no free-text field). This is a candidate post-MVP enhancement to improve learning loop fidelity.

---

## Story US-F06-05: Human-only escalation (AG-05)

**As a** staff member,
**I want** conversations involving sensitive topics (refunds, pricing changes, policy exceptions, complaints, liability) to be flagged for my manual handling without any AI draft or proposal,
**so that** I retain full control over high-risk interactions and the AI never oversteps into areas requiring human judgment.

### Acceptance criteria

```gherkin
Feature: Human-only escalation flags conversation for manual handling

  Background:
    Given the Client Worker has classified the client's intent
    And the ApprovalPolicyEvaluator has the fixed MVP trust model

  Scenario: Intent classified as human-only category skips draft generation
    Given the Client Worker classifies the inbound message intent as "refund_request"
    And "refund_request" is mapped to the human-only tier
    When the ApprovalPolicyEvaluator evaluates the intent
    Then no draft reply is generated
    And no ProposedAction is created for the refund itself
    And the conversation is marked with a "manual_handling_required" flag
    And an AuditEvent is written with action_type "escalation_flagged"

  Scenario: Escalation flag is visible in the staff app
    Given a conversation has been flagged for manual handling
    When I open the inbox
    Then the conversation shows a distinct visual indicator (e.g., a warning icon or "Needs manual attention" label)
    And the conversation thread displays a system message: "This conversation requires manual handling — [category]"
    And no confirmation cards or draft cards are shown for the escalated topic

  Scenario: Staff can still use the conversation thread normally after escalation
    Given a conversation is flagged for manual handling
    When I compose and send a reply manually
    Then the message is sent through WhatsApp as normal
    And an AuditEvent is written with actor_type "staff" and action_type "message_sent"
    And the manual_handling_required flag remains until explicitly cleared

  Scenario: Multiple categories map to human-only tier
    Then the following intent categories are classified as human-only:
      | Category              |
      | refund_request        |
      | pricing_negotiation   |
      | policy_exception      |
      | complaint_handling    |
      | liability_commitment  |
    And this mapping is defined in the ApprovalPolicy configuration, not hardcoded in the LLM prompt

  Scenario: Subsequent messages in an escalated conversation are still processed
    Given a conversation was previously flagged for manual handling
    When the client sends a follow-up message
    Then the inbound message is stored and the staff is notified (per F-02 and F-04)
    And the Client Worker is still invoked to classify intent
    And if the new intent is non-sensitive (e.g., a simple question), a draft may be generated
    And the manual_handling_required flag persists as a visual indicator

  Scenario: Escalation notification is sent to staff
    Given a conversation is flagged for manual handling
    Then a push notification is sent with urgency indicator (distinct from standard inbound message notifications)
    And the notification body references the escalation category (e.g., "Refund request from [client name] — manual handling required")
```

### Notes

- Human-only escalation does not mean the Client Worker is not invoked. The Client Worker still runs (for context assembly and intent classification) but the system suppresses draft generation and proposal creation when the intent matches a human-only category.
- The `manual_handling_required` flag is a conversation-level attribute, not a client-level attribute. A client can have both escalated and non-escalated conversations.
- Post-MVP: the escalation notification could route to specific staff members based on role or assignment. MVP sends to all workspace staff (consistent with F-04 notification scope).
- The list of human-only categories is sourced from PRD section 8 and defined in `ApprovalPolicy.ts`. Adding new categories requires a code change in MVP; post-MVP this could become workspace-configurable.

---

## Story US-F06-06: Tool parameter injection (AG-07)

**As a** system architect,
**I want** `workspaceId` and `clientId` to be injected into every tool call by the runtime — overriding any values the LLM may have included,
**so that** the LLM can never read or write data belonging to a different workspace or client, even if prompt-injected or hallucinating.

### Acceptance criteria

```gherkin
Feature: Runtime injects workspaceId and clientId into all tool calls

  Background:
    Given the Client Worker is executing an LLM invocation for session key "workspace:WS-001:client:CL-042"
    And the session context contains workspaceId "WS-001" and clientId "CL-042"

  Scenario: LLM-provided parameters are merged with runtime-injected parameters
    Given the LLM outputs a tool call for "calendar_query" with arguments { "dateRange": "2026-03-20/2026-03-25", "appointmentType": "initial_consultation" }
    When the ToolParamInjector processes the tool call
    Then the executed tool receives parameters:
      | Parameter        | Value                  | Source          |
      | dateRange        | 2026-03-20/2026-03-25  | LLM-provided    |
      | appointmentType  | initial_consultation   | LLM-provided    |
      | workspaceId      | WS-001                 | Runtime-injected |
    And the workspaceId is not overridable by any LLM-provided argument

  Scenario: LLM attempts to override workspaceId — runtime value wins
    Given the LLM outputs a tool call with arguments that include "workspaceId": "WS-999"
    When the ToolParamInjector processes the tool call
    Then the workspaceId used is "WS-001" (from the session context)
    And the LLM-provided "WS-999" is silently discarded
    And a warning is logged: "LLM attempted to override workspaceId — injected value used"

  Scenario: LLM attempts to override clientId — runtime value wins
    Given the LLM outputs a tool call with arguments that include "clientId": "CL-999"
    When the ToolParamInjector processes the tool call
    Then the clientId used is "CL-042" (from the session context)
    And the LLM-provided "CL-999" is silently discarded
    And a warning is logged: "LLM attempted to override clientId — injected value used"

  Scenario: Injection applies to all tool types uniformly
    Given the Client Worker outputs tool calls for the following tools:
      | Tool                 | Authority     |
      | knowledge_search     | read          |
      | calendar_query       | read          |
      | calendar_book        | propose_write |
      | update_client_record | propose_write |
      | create_note          | auto_write    |
      | create_followup      | propose_write |
    When the ToolParamInjector processes each tool call
    Then every tool call receives the runtime-injected workspaceId and clientId
    And no tool call executes without these injected parameters

  Scenario: Tool call with invalid LLM-provided parameters is rejected
    Given the LLM outputs a tool call for "calendar_book" with arguments missing required field "slotId"
    When the ToolParamInjector merges parameters and validates against the tool's input schema
    Then validation fails
    And the tool is not executed
    And an error result is returned to the LLM indicating the missing parameter
    And an audit event is not written (no action was taken)

  Scenario: Fixed parameters per tool are also injected
    Given the tool "create_note" has fixed params including source: "ai_extracted"
    When the ToolParamInjector processes a create_note call
    Then the executed tool receives workspaceId, clientId, and source: "ai_extracted"
    And the LLM cannot override the source field
```

### Notes

- This is the critical safety mechanism described in Architecture section 4.4. The injection happens AFTER the LLM outputs the tool call and BEFORE the tool executes. The order is: LLM outputs arguments -> ToolParamInjector merges session-scoped params (overriding conflicts) -> schema validation -> tool execution.
- The implementation pattern from the architecture spec: spread LLM arguments first, then overwrite with session-scoped values. This ensures runtime values always win.
- Per-tool fixed parameters (like `source: "ai_extracted"` for `create_note`) are defined in the tool registry alongside the tool schema. They follow the same override semantics.
- The warning log on override attempts is important for security monitoring. Repeated override attempts may indicate prompt injection and should be surfaceable in operational dashboards post-MVP.

---

## Story US-F06-07: Draft-ready and escalation re-notifications (NT-03, NT-04)

**As a** staff member,
**I want** to be notified when a draft or confirmation card is ready for my review, and re-notified if I have not acted within a reasonable time,
**so that** clients receive timely responses and proposed actions do not go stale while I am busy.

### Acceptance criteria

```gherkin
Feature: Draft-ready notification and escalation re-notification

  Background:
    Given I am a staff member with push notifications enabled (per F-04)
    And the workspace has an active WhatsApp connection

  Scenario: Draft-ready notification when AI draft is generated (NT-03)
    Given the Client Worker generates a draft reply for client "CL-042"
    And the draft is saved with status "pending_review"
    When the draft-ready event is emitted
    Then a push notification is dispatched to all workspace staff
    And the notification title includes the client's display name
    And the notification body reads "Draft reply ready for review"
    And tapping the notification deep-links to the client's conversation thread

  Scenario: Draft-ready notification when confirmation card is created (NT-03)
    Given a review-tier ProposedAction creates a ConfirmationRequest
    When the confirmation-ready event is emitted
    Then a push notification is dispatched to all workspace staff
    And the notification body includes the action summary (e.g., "Booking proposal ready for review")
    And tapping the notification deep-links to the client's conversation thread

  Scenario: Draft-ready notification is distinct from inbound message notification
    Given the inbound message notification (NT-01 / F-04) fires when a message arrives
    And the draft-ready notification (NT-03) fires when the AI draft is complete
    Then the two notifications are visually distinguishable (different icon or prefix)
    And both can arrive for the same client message (inbound first, then draft-ready)
    And the draft-ready notification does not duplicate the inbound notification

  Scenario: Escalation re-notification after 1 hour of inactivity (NT-04)
    Given a draft or confirmation card has been pending for 60 minutes
    And no staff member has approved, rejected, or sent the draft
    When the escalation timer fires
    Then a re-notification is dispatched to all workspace staff
    And the notification body reads "Reminder: [client name] has a pending draft/action for over 1 hour"
    And the notification carries an urgency indicator distinguishing it from the original notification

  Scenario: Re-notification does not fire if staff has already acted
    Given a draft was pending and the staff approved it 45 minutes after creation
    When the 60-minute escalation timer checks the status
    Then no re-notification is sent
    And the timer is cancelled or the check exits early

  Scenario: Re-notification fires at most once per pending action
    Given a draft has been pending for 120 minutes
    Then exactly one re-notification was sent (at the 60-minute mark)
    And no additional re-notifications are sent regardless of how long the action remains pending

  Scenario: Multiple pending actions each have independent re-notification timers
    Given 2 ConfirmationRequests are created at T=0 and T=30 minutes
    Then the first re-notification fires at T=60
    And the second re-notification fires at T=90
    And each notification references the specific action

  Scenario: Escalation for human-only flagged conversations
    Given a conversation has been flagged for manual handling (human-only escalation)
    And no staff member has opened the conversation within 60 minutes
    When the escalation timer fires
    Then a re-notification is dispatched with urgency: "Manual handling required — [client name] waiting for over 1 hour"
```

### Notes

- The 1-hour re-notification timeout comes from PRD function NT-04: "Re-send if staff hasn't reviewed within 1h." This is a fixed value for MVP; post-MVP it could be workspace-configurable.
- Re-notification fires at most once per pending action (no repeated nagging). If the action remains unaddressed beyond 1 hour, it is the staff's operational visibility (inbox badges, today's view in F-12) that surfaces it.
- Implementation: the escalation timer can be a BullMQ delayed job scheduled at draft/card creation time. The job checks the action status before dispatching; if already acted upon, it exits without sending.
- Draft-ready notifications (NT-03) are additive to the inbound message notification (NT-01). The sequence for a typical inbound message is: (1) NT-01 fires immediately on message receipt, (2) Client Worker processes the message and generates a draft, (3) NT-03 fires when the draft is saved. These are distinct events with distinct notification content.
- Human-only escalation re-notifications follow the same timer mechanism but with a distinct message template that emphasizes urgency.

---

## Story map summary

| Story | PRD Function | Actor | Priority | Dependency |
|---|---|---|---|---|
| US-F06-01 | AG-01 | System | Must-have | F-05 (Client Worker produces ProposedActions) |
| US-F06-02 | AG-02 | Staff | Must-have | US-F06-01 (tier classification) |
| US-F06-03 | AG-03 | Staff | Must-have | US-F06-02 (confirmation card exists) |
| US-F06-04 | AG-04 | Staff | Must-have | US-F06-02 (confirmation card exists) |
| US-F06-05 | AG-05 | Staff | Must-have | US-F06-01 (policy evaluator active) |
| US-F06-06 | AG-07 | System | Must-have | F-05 (Client Worker tool calling) |
| US-F06-07 | NT-03, NT-04 | Staff | Must-have | F-04 (notification foundation), US-F06-02 |

All seven stories are Phase 2 must-haves. US-F06-06 (tool parameter injection) is the highest-priority from a security standpoint and should be implemented first, as it is required before any Client Worker tool call can safely execute. US-F06-01 (policy evaluation) is next, as it gates all other approval flow stories. US-F06-02 through US-F06-04 form a natural sequence (create card -> approve -> reject). US-F06-05 (human-only escalation) can be implemented in parallel with the approval/rejection stories. US-F06-07 (notifications) depends on cards and drafts existing but can be developed in parallel with notification infrastructure from F-04.

## Open questions

1. **Rejection reason capture** — should MVP include an optional free-text field for staff to explain why they rejected a proposed action? This would improve learning loop fidelity (F-15) but adds UI complexity. Recommend deferring to post-MVP.
2. **ProposedAction expiry policy** — the architecture defines an "expired" status but the PRD does not specify when expiry occurs. Recommend: booking actions expire when the proposed slot time passes; other actions expire after 24 hours of inactivity. Needs PM + Eng alignment.
3. **`proposed_action_rejected` audit action type** — this is a new audit action type not in the original AG-06 enum (PRD section 12.13). It must be added to the enum before F-06 implementation. Similarly, `escalation_flagged` should be added.
4. **Draft-ready vs. confirmation-ready notification distinction** — should these be the same notification type with different body text, or distinct notification categories with separate enable/disable controls? Recommend same type for MVP, split post-MVP if staff feedback indicates notification fatigue.
5. **Re-notification for human-only escalations** — NT-04 says "re-send if staff hasn't reviewed within 1h" but does not specify whether this applies to human-only flags as well as review-tier cards. US-F06-07 includes it; confirm with PM.
