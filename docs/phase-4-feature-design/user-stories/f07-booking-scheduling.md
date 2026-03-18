# User Stories — F-07: Booking & Scheduling

**Feature:** F-07 Booking & Scheduling
**PRD Functions:** BK-01, BK-02, BK-03, BK-04, BK-05, BK-06, BK-07, BK-08, BK-09, ON-07
**Phase:** 2
**Size:** XL
**Architecture Modules:** booking-operations (QueryAvailability, ProposeBooking, DetectConflict, GoogleCalendarGateway)

---

## US-F07-01: Connect Google Calendar via OAuth

**As a** business owner or staff member,
**I want** to connect a Google Calendar account to my workspace via OAuth,
**So that** the system can read availability and create events, enabling automated booking flows.

**Acceptance Criteria:**

```gherkin
Scenario: Successful Google Calendar OAuth connection
  Given the workspace is active and no calendar is connected
  When the owner initiates Google Calendar connection from Settings (or from the onboarding summary)
  Then the system redirects to Google's OAuth consent screen
  And requests read/write access to Google Calendar
  And upon successful authorization, the OAuth tokens are stored in workspace.calendar_config
  And the calendar connection status is displayed as "Connected"
  And booking features (BK-01 through BK-09) become active for the workspace

Scenario: OAuth consent is denied
  Given the owner has been redirected to Google's OAuth consent screen
  When the owner denies consent or cancels the flow
  Then the system returns the owner to the Settings page
  And displays a message explaining that booking features require calendar access
  And the workspace continues operating without booking capabilities
  And the owner can retry the connection at any time

Scenario: OAuth token refresh
  Given a Google Calendar is connected and the access token has expired
  When any booking operation attempts to access the calendar
  Then the system uses the stored refresh token to obtain a new access token
  And the operation proceeds without user intervention
  And the new access token is persisted

Scenario: OAuth token revocation or invalidation
  Given a Google Calendar is connected
  When the owner revokes access from Google's account settings or the refresh token becomes invalid
  Then the next calendar operation fails gracefully
  And the workspace calendar_config is marked as "disconnected"
  And the owner is notified to reconnect via OAuth
  And existing booking records in the database are unaffected

Scenario: Calendar disconnection by owner
  Given a Google Calendar is connected
  When the owner disconnects the calendar from Settings
  Then the OAuth tokens are removed from workspace.calendar_config
  And new booking flows are disabled
  And existing confirmed bookings and their calendar_event_ids remain in the database
  And the system stops querying Google Calendar for availability
```

**Notes:**
- MVP supports a single Google Calendar per workspace. Multi-calendar is post-MVP.
- The OAuth flow stores both access and refresh tokens in `workspace.calendar_config`.
- Calendar connection can happen during onboarding (summary step) or later from Settings. Either path is equivalent.
- When calendar is not connected, the Client Worker does not have access to `calendar_query` or `calendar_book` tools.
- Maps to PRD function ON-07.

---

## US-F07-02: Query Calendar Availability

**As a** staff member,
**I want** the system to automatically query Google Calendar for available slots when a client expresses booking intent,
**So that** I do not have to manually check the calendar before proposing times.

**Acceptance Criteria:**

```gherkin
Scenario: Availability query for a standard appointment type
  Given a Google Calendar is connected to the workspace
  And the vertical_config defines an appointment type "consultation" with durationMinutes: 60 and bufferMinutes: 15
  When the Client Worker calls the calendar_query tool with a date range and appointmentType "consultation"
  Then the system queries Google Calendar for existing events in that date range
  And calculates available slots that accommodate the 60-minute duration plus 15-minute buffer
  And returns only slots that fall within the workspace's configured business_hours
  And all times are stored and processed in UTC with workspace timezone reference

Scenario: Availability respects existing calendar events
  Given the Google Calendar has events on Tuesday from 10:00-11:00 and 14:00-15:00
  And the appointment type requires 60 minutes plus 15-minute buffer
  When availability is queried for Tuesday
  Then the returned slots do not overlap with existing events
  And the returned slots account for the 15-minute buffer before and after each existing event
  And gaps shorter than durationMinutes + bufferMinutes are excluded

Scenario: Availability respects business hours
  Given the workspace business_hours are Monday-Friday 09:00-17:00 (workspace timezone)
  When availability is queried for a Saturday
  Then no slots are returned for Saturday
  And the system may include the next available business day if the date range permits

Scenario: No available slots in requested range
  Given the Google Calendar is fully booked for the requested date range
  When the Client Worker calls calendar_query
  Then the tool returns an empty slot list
  And the Client Worker can widen the date range or inform the client of unavailability

Scenario: Calendar query fails due to API error
  Given the Google Calendar API is temporarily unavailable
  When the Client Worker calls calendar_query
  Then the tool returns an error indicating calendar unavailability
  And the Client Worker generates a draft explaining that availability cannot be checked right now
  And the draft suggests the client try again shortly or contact the business directly
```

**Notes:**
- `calendar_query` is a **read** authority tool (architecture section 4.3): it returns data without side effects and does not require staff approval.
- Runtime injects `workspaceId` and `calendarConfig` into every `calendar_query` call. The LLM provides `dateRange` and `appointmentType`.
- Slot calculation is deterministic code, not LLM logic: the GoogleCalendarGateway fetches events, then QueryAvailability computes valid windows.
- Buffer time is per appointment type from `vertical_config.appointmentTypes[].bufferMinutes`.
- Maps to PRD function BK-01.

---

## US-F07-03: Propose Available Slots in Draft

**As a** client,
**I want** to receive 2-4 specific time options to choose from,
**So that** I can pick a convenient appointment time without back-and-forth negotiation.

**Acceptance Criteria:**

```gherkin
Scenario: Draft proposes valid time slots
  Given the Client Worker has received available slots from calendar_query
  When the Client Worker generates a draft reply
  Then the draft contains 2 to 4 specific slot options
  And each option includes the date, day of week, start time, and appointment type
  And times are displayed in the workspace's timezone
  And the draft is saved with status "pending_review" for staff approval

Scenario: Fewer than 2 slots available
  Given calendar_query returns only 1 available slot
  When the Client Worker generates a draft reply
  Then the draft presents the single available slot
  And includes language indicating limited availability
  And suggests the client mention alternative date preferences if the slot does not work

Scenario: More than 4 slots available
  Given calendar_query returns 8 or more available slots
  When the Client Worker generates a draft reply
  Then the draft selects 3-4 well-distributed options (e.g., spread across different days/times)
  And does not overwhelm the client with all 8 options

Scenario: Slot proposal respects tone profile
  Given the workspace has a tone_profile configured
  When the Client Worker drafts the slot proposal message
  Then the message language matches the workspace's brand voice
  And the slot details are clear regardless of tone styling

Scenario: Draft includes appointment type context
  Given the client requested a "first_fitting" appointment
  When the Client Worker generates a draft with slot options
  Then the draft references the appointment type by its label (e.g., "First Fitting")
  And includes the duration if contextually appropriate (e.g., "approximately 45 minutes")
```

**Notes:**
- The Client Worker (LLM) decides how many slots to present (2-4) and which to select from the available pool. Distribution logic is a prompt instruction, not hard-coded.
- Slot proposals are part of the regular draft flow: they appear in the staff inbox as a draft for review before being sent.
- The proposed slots are stored with the draft so the system can match client replies back to them (see US-F07-04).
- Maps to PRD function BK-02.

---

## US-F07-04: Match Client Slot Selection

**As a** staff member,
**I want** the system to automatically match a client's reply to one of the previously proposed slots,
**So that** I can confirm the booking without manually interpreting the client's response.

**Acceptance Criteria:**

```gherkin
Scenario: Client selects a slot by number or reference
  Given the client was sent a message proposing slots (e.g., "1. Tuesday 10am, 2. Wednesday 2pm, 3. Thursday 11am")
  When the client replies "Option 2" or "Wednesday works" or "Let's do 2pm Wednesday"
  Then the Client Worker matches the reply to the proposed Wednesday 2pm slot
  And generates a booking confirmation draft referencing the matched slot
  And the matched slot details are attached to the draft for staff verification

Scenario: Client selects a slot with ambiguous language
  Given the client was sent a message proposing multiple slots
  When the client replies with ambiguous text (e.g., "the morning one" when two morning options exist)
  Then the Client Worker generates a draft asking for clarification
  And re-presents the ambiguous options for the client to choose between

Scenario: Client reply does not match any proposed slot
  Given the client was sent a message proposing slots
  When the client replies with a time that was not proposed (e.g., "How about Friday at 3pm?")
  Then the Client Worker checks availability for the requested time via calendar_query
  And if available, generates a confirmation draft for the requested time
  And if unavailable, generates a draft explaining the conflict and re-proposing alternatives

Scenario: Client confirms eagerness without selecting
  Given the client was sent a message proposing slots
  When the client replies "Yes I'd like to book" without specifying which slot
  Then the Client Worker generates a draft asking the client to pick a specific option
  And re-presents the available slots
```

**Notes:**
- Slot matching is an LLM task: the Client Worker uses the conversation context (which includes the previously sent slot proposal) to interpret the client's reply.
- The system must track which slots were proposed in each conversation to enable matching. This is part of the draft/conversation context.
- If the client requests a time outside the proposed options, this triggers a new calendar_query (BK-01) rather than failing.
- Maps to PRD function BK-03.

---

## US-F07-05: Generate Booking Confirmation Draft

**As a** staff member,
**I want** a confirmation message drafted after a slot is matched,
**So that** I can review the booking details before confirming with the client.

**Acceptance Criteria:**

```gherkin
Scenario: Confirmation draft generated after slot match
  Given the Client Worker has matched the client's reply to a specific slot
  When the confirmation draft is generated
  Then the draft includes the appointment type label, date, start time, and duration
  And the draft asks the client to confirm the booking
  And the draft is saved with status "pending_review"
  And a confirmation card is created for the staff showing the proposed booking action

Scenario: Confirmation draft follows approval workflow
  Given a booking confirmation draft has been generated
  When the staff views the draft in their inbox
  Then the draft is accompanied by a ProposedAction confirmation card
  And the card shows: client name, appointment type, date/time, and calendar event details
  And the staff can approve (triggering calendar event + booking record creation) or reject

Scenario: Staff edits confirmation draft before sending
  Given a booking confirmation draft has been generated
  When the staff edits the draft text
  Then the edited version replaces the original draft
  And the underlying ProposedAction (calendar event + booking record) remains unchanged
  And the staff can still approve or reject the booking action independently of the message text

Scenario: Confirmation draft includes relevant business context
  Given the workspace knowledge base contains preparation instructions for the appointment type
  When the confirmation draft is generated
  Then the draft may include relevant preparation notes (e.g., "Please arrive 10 minutes early")
  And knowledge source attribution is tracked per the standard draft pipeline
```

**Notes:**
- The confirmation draft is generated by the Client Worker as part of the normal AI drafting flow (F-05). The booking-specific behavior is that the Client Worker also calls the `calendar_book` tool, which returns a `ProposedAction<BookingCreate>`.
- The `calendar_book` tool has **propose_write** authority (architecture section 4.3): it creates a ProposedAction that requires staff approval before execution.
- Staff approval triggers both calendar event creation (BK-05) and booking record creation (BK-06) atomically.
- Maps to PRD function BK-04.

---

## US-F07-06: Create Calendar Event and Booking Record After Approval

**As a** staff member,
**I want** the system to create a Google Calendar event and a database booking record when I approve a booking,
**So that** confirmed appointments are immediately reflected in the calendar and the client's record.

**Acceptance Criteria:**

```gherkin
Scenario: Staff approves booking and calendar event is created
  Given a ProposedAction<BookingCreate> is pending staff review
  When the staff approves the action
  Then the system creates a Google Calendar event with:
    | Field       | Value                                             |
    | Title       | Appointment type label + client name               |
    | Start       | Matched slot start_time                            |
    | End         | start_time + durationMinutes from vertical_config  |
    | Description | Booking notes and client context                   |
  And the calendar_event_id returned by Google is stored in the booking record
  And an audit event is logged with actor: staff, action: "booking_approved"

Scenario: Booking record created in database
  Given the staff has approved the booking
  When the system executes the approved action
  Then a new row is inserted into the Booking table with:
    | Field               | Value                                      |
    | client_id           | The current client's ID                     |
    | workspace_id        | The current workspace's ID                  |
    | provider_id         | Staff/provider ID if applicable             |
    | appointment_type    | Key from vertical_config.appointmentTypes   |
    | start_time          | Confirmed slot start time (UTC)             |
    | end_time            | start_time + durationMinutes (UTC)          |
    | calendar_event_id   | Google Calendar event ID                    |
    | status              | "confirmed"                                 |
    | confirmation_status | "pending"                                   |
  And the client's lifecycle status is updated to "upcoming_appointment"

Scenario: Google Calendar API fails during event creation
  Given the staff has approved the booking
  When the system attempts to create the Google Calendar event and the API call fails
  Then the booking record is NOT created (atomic: both succeed or neither)
  And the staff is notified of the failure
  And the ProposedAction remains in "pending" status for retry
  And the staff can retry the approval or reject and re-propose

Scenario: Staff rejects the booking
  Given a ProposedAction<BookingCreate> is pending staff review
  When the staff rejects the action
  Then no calendar event is created
  And no booking record is written
  And the ProposedAction status is set to "rejected"
  And an audit event is logged
  And the staff can reprompt the Client Worker to propose different options
```

**Notes:**
- Event creation and booking record creation are atomic: if the Google Calendar API call succeeds but the database write fails (or vice versa), the system must roll back or retry to maintain consistency.
- The `confirmation_status` starts as "pending" because the client has not yet confirmed attendance (that is a separate COS flow in Phase 3, F-12).
- `provider_id` is nullable in MVP since single-provider workspaces may not need it.
- Runtime injects `workspaceId` and `clientId` into the `calendar_book` tool call. The LLM cannot override these.
- Maps to PRD functions BK-05 (calendar event) and BK-06 (booking record).

---

## US-F07-07: Detect Conflicts at Confirmation Time

**As a** staff member,
**I want** the system to detect scheduling conflicts before confirming a booking,
**So that** double-bookings are prevented even when slots were checked earlier and have since been taken.

**Acceptance Criteria:**

```gherkin
Scenario: No conflict detected
  Given a staff member approves a booking for Tuesday 10:00-11:00
  When the system performs a conflict check against Google Calendar at approval time
  Then no overlapping events are found
  And the booking proceeds normally (calendar event + booking record created)

Scenario: Conflict detected — slot taken since proposal
  Given slots were proposed to the client 30 minutes ago
  And another event was added to Google Calendar in the interim
  When the staff approves the booking and the system performs a conflict check
  Then the system detects the overlapping event
  And the booking is NOT created
  And the staff is notified with a conflict explanation: "This slot is no longer available"
  And the system automatically triggers a new calendar_query for alternative slots
  And a new draft with alternative slot proposals is generated

Scenario: Conflict detected — overlapping booking in database
  Given a booking already exists in the Booking table for the same time window
  When the staff approves a new booking that overlaps with it
  Then the system detects the conflict from the database records
  And prevents the double-booking
  And notifies the staff with the conflicting booking details

Scenario: Conflict with buffer time
  Given an existing event ends at 11:00
  And the appointment type requires a 15-minute buffer
  When the staff approves a booking starting at 11:05
  Then the system detects the buffer conflict
  And prevents the booking
  And explains that a 15-minute buffer is required between appointments

Scenario: Conflict check includes both calendar and database
  Given the system checks for conflicts
  When it evaluates a proposed booking time
  Then it checks both Google Calendar events AND existing Booking table records
  And a conflict in either source blocks the booking
```

**Notes:**
- Slots are checked but **not locked** at query time (PRD section 9.2). This is a deliberate design choice: locking introduces complexity and most SMB booking volumes do not require it.
- Conflict detection is the last gate before event creation. It runs at approval time, not at proposal time.
- DetectConflict is a deterministic application service in booking-operations, not an LLM call.
- When a conflict is detected, the system falls through to alternative slot proposal (BK-08 / US-F07-08).
- Maps to PRD function BK-07.

---

## US-F07-08: Propose Alternative Slots When Rejected or Conflicted

**As a** client,
**I want** to receive new time options when my chosen slot is unavailable or when I reject the proposed times,
**So that** I can still book without restarting the conversation.

**Acceptance Criteria:**

```gherkin
Scenario: Alternatives proposed after conflict detection
  Given a conflict was detected at confirmation time for the client's chosen slot
  When the system generates a new draft
  Then a fresh calendar_query is executed for the same appointment type
  And the Client Worker generates a new draft explaining the conflict and proposing 2-4 alternative slots
  And the draft is submitted for staff review through the normal approval workflow

Scenario: Alternatives proposed after client rejects options
  Given the client replies that none of the proposed slots work (e.g., "None of those work for me")
  When the Client Worker processes the reply
  Then the Client Worker asks about the client's preferred dates/times
  Or executes a new calendar_query with a wider or different date range
  And generates a draft with 2-4 new slot proposals

Scenario: Client suggests a specific alternative time
  Given the client rejects the proposed slots
  When the client replies with a specific preference (e.g., "I can only do evenings" or "Next week would be better")
  Then the Client Worker uses the preference to constrain the calendar_query
  And generates a draft with slots matching the client's stated preference

Scenario: No alternatives available
  Given the client's chosen slot conflicted and a new calendar_query returns no available slots
  When the Client Worker generates a draft
  Then the draft explains that no availability was found in the searched window
  And asks the client if they would like to check a different time period
  And suggests contacting the business directly for special arrangements if appropriate

Scenario: Repeated conflict cycle
  Given alternatives have been proposed and conflicted multiple times
  When a third conflict occurs
  Then the system still proposes new alternatives from a fresh query
  And does not give up or stop trying
  And the conversation context preserves all previously rejected/conflicted slots to avoid re-proposing them
```

**Notes:**
- Alternative proposal reuses the same pipeline: `calendar_query` (BK-01) followed by Client Worker draft with slot options (BK-02). The flow is circular by design.
- The Client Worker has full conversation context, so it can see which slots were previously proposed and rejected, avoiding repetition.
- The LLM interprets client preferences (e.g., "evenings", "next week") and translates them into appropriate `dateRange` parameters for `calendar_query`.
- Maps to PRD function BK-08.

---

## US-F07-09: Validate Appointment Type Prerequisites

**As a** staff member,
**I want** the system to enforce appointment type sequencing rules from the vertical configuration,
**So that** clients cannot book appointments out of order (e.g., a second fitting before a first fitting).

**Acceptance Criteria:**

```gherkin
Scenario: Prerequisite satisfied — booking proceeds
  Given the vertical_config defines "second_fitting" with prerequisite: "first_fitting"
  And the client has a completed booking record for "first_fitting"
  When the Client Worker attempts to book a "second_fitting"
  Then the prerequisite check passes
  And the booking flow proceeds normally

Scenario: Prerequisite not satisfied — booking blocked
  Given the vertical_config defines "second_fitting" with prerequisite: "first_fitting"
  And the client has NO completed booking record for "first_fitting"
  When the Client Worker attempts to book a "second_fitting"
  Then the system blocks the booking proposal
  And the Client Worker generates a draft explaining that a "First Fitting" must be completed first
  And the draft may offer to book the prerequisite appointment type instead

Scenario: Prerequisite exists but is cancelled or no-show
  Given the client has a booking record for "first_fitting" with status "cancelled" or "no_show"
  When the Client Worker attempts to book a "second_fitting"
  Then the system treats the prerequisite as NOT satisfied
  And blocks the "second_fitting" booking
  And explains that the "First Fitting" needs to be rebooked

Scenario: Appointment type has no prerequisite
  Given the vertical_config defines "consultation" with no prerequisite field
  When the Client Worker attempts to book a "consultation"
  Then no prerequisite check is performed
  And the booking flow proceeds normally

Scenario: Prerequisite validation uses booking records, not calendar events
  Given a client's first_fitting booking exists in the Booking table with status "completed"
  When prerequisite validation runs
  Then it queries the Booking table for the client's appointment history
  And does not rely on Google Calendar event existence
  And scoping is enforced by workspace_id + client_id
```

**Notes:**
- Prerequisites are defined in `vertical_config.appointmentTypes[].prerequisite` as the `key` of the required prior appointment type.
- Validation is a deterministic check in the booking-operations domain (BookingRules), not an LLM decision.
- Only bookings with status "completed" satisfy the prerequisite. Statuses "confirmed" (not yet attended), "cancelled", and "no_show" do not count.
- This validation runs before the `calendar_book` tool creates a ProposedAction, so invalid bookings are never proposed to staff.
- Maps to PRD function BK-09.

---

## US-F07-10: Reschedule an Existing Booking

**As a** client,
**I want** to reschedule an existing appointment through the WhatsApp conversation,
**So that** I can change my appointment time without calling the business or going through a complex process.

**Acceptance Criteria:**

```gherkin
Scenario: Client requests reschedule via WhatsApp
  Given a client has a confirmed booking for "consultation" on Tuesday at 10:00
  When the client sends a message like "Can I move my appointment to Thursday?"
  Then the Client Worker classifies the intent as a reschedule request
  And queries calendar_query for available "consultation" slots on or near Thursday
  And generates a draft proposing 2-4 alternative slots for staff review

Scenario: Staff approves the reschedule
  Given the Client Worker has proposed alternative slots and the client has selected one
  When the staff approves the reschedule
  Then the original Google Calendar event is updated (or deleted and recreated) with the new time
  And the original booking record's start_time, end_time, and calendar_event_id are updated
  And the booking status remains "confirmed"
  And an audit event is logged with action: "booking_rescheduled", including before/after state

Scenario: Conflict detected during reschedule
  Given the client wants to reschedule to a specific new time
  When a conflict is detected at the new time
  Then the system follows the standard conflict handling flow (US-F07-07)
  And proposes alternative slots
  And the original booking remains unchanged until a new time is successfully confirmed

Scenario: Reschedule preserves appointment type and prerequisites
  Given a client is rescheduling a "second_fitting"
  When the reschedule is processed
  Then the appointment type remains "second_fitting"
  And prerequisite validation is NOT re-run (the original booking already passed it)
  And only the time changes

Scenario: Multiple reschedules for the same booking
  Given a client has already rescheduled once
  When the client requests another reschedule
  Then the system processes it the same way
  And each reschedule is tracked in the audit log with before/after state
```

**Notes:**
- Reschedule is not explicitly covered as a separate PRD function but is a critical real-world flow implied by the JTBD "book or reschedule without back-and-forth."
- A reschedule is modeled as an update to an existing booking record, not a cancel-and-rebook. This preserves the booking_id and audit trail.
- The Client Worker identifies reschedule intent from conversation context (the client has an upcoming booking visible in their assembled context).
- The reschedule ProposedAction goes through the same approval workflow as a new booking (F-06 governance).

---

## US-F07-11: Cancel an Existing Booking

**As a** client,
**I want** to cancel an existing appointment through the WhatsApp conversation,
**So that** I can free up the time slot without calling the business.

**Acceptance Criteria:**

```gherkin
Scenario: Client requests cancellation via WhatsApp
  Given a client has a confirmed booking for "consultation" on Tuesday at 10:00
  When the client sends a message like "I need to cancel my appointment"
  Then the Client Worker classifies the intent as a cancellation request
  And generates a draft confirming the cancellation details for staff review
  And a ProposedAction for the cancellation is created requiring staff approval

Scenario: Staff approves the cancellation
  Given a cancellation ProposedAction is pending staff review
  When the staff approves the cancellation
  Then the Google Calendar event is deleted
  And the booking record status is updated to "cancelled"
  And the client's lifecycle status is re-evaluated (e.g., reverted from "upcoming_appointment" if no other bookings exist)
  And an audit event is logged with action: "booking_cancelled"
  And a confirmation message draft is generated for the client

Scenario: Staff rejects the cancellation
  Given a cancellation ProposedAction is pending staff review
  When the staff rejects the cancellation
  Then the booking remains confirmed
  And the staff can draft a manual reply to the client (e.g., offering to reschedule instead)

Scenario: Cancellation of a booking with dependent future bookings
  Given a client has a "first_fitting" booking on Tuesday and a "second_fitting" booking on Friday
  When the client requests cancellation of the "first_fitting"
  Then the system warns the staff that "second_fitting" depends on "first_fitting" as a prerequisite
  And the staff can decide whether to cancel both or only the first
  And if only the first is cancelled, the second_fitting remains but is flagged for staff attention

Scenario: Client cancels on the day of the appointment
  Given a client has a confirmed booking for today
  When the client requests cancellation
  Then the system processes the cancellation normally
  And the draft may include any cancellation policy information from the workspace knowledge base
  And the staff decides whether to approve based on business policy
```

**Notes:**
- Cancellation is a **suggest-for-review** tier action per the architecture trust model. The AI proposes the cancellation but staff must approve.
- MVP does not support automated cancellation (PRD section 9.7). All cancellations require staff approval.
- The cancellation draft and the ProposedAction are separate: the draft is the client-facing message, the ProposedAction is the system mutation.
- Cancellation policies (e.g., minimum notice, fees) are business-specific and live in the knowledge base or SOP rules, not in system logic. The Client Worker can reference them in the draft.
- When a cancelled booking has dependents (via prerequisites), the system surfaces this as information to the staff rather than automatically cascading cancellations.

---

## Story Map

| Story | PRD Functions | Core Flow | Fallback Path |
|-------|--------------|-----------|---------------|
| US-F07-01 | ON-07 | OAuth flow -> store tokens -> activate booking features | Consent denied, token expired/revoked -> reconnect |
| US-F07-02 | BK-01 | calendar_query -> compute slots respecting duration/buffer/hours | API error -> inform client, no slots -> widen range |
| US-F07-03 | BK-02 | Client Worker drafts 2-4 slot options | < 2 slots -> present what's available, > 4 -> select best spread |
| US-F07-04 | BK-03 | Match client reply to proposed slot | Ambiguous -> clarify, unproposed time -> new query |
| US-F07-05 | BK-04 | Confirmation draft + ProposedAction<BookingCreate> | Staff edits draft, rejects action |
| US-F07-06 | BK-05, BK-06 | Approve -> create calendar event + booking record (atomic) | API failure -> retry, rejection -> reprompt |
| US-F07-07 | BK-07 | Conflict check at approval time | Conflict found -> block + trigger alternatives |
| US-F07-08 | BK-08 | Fresh query -> new slot proposals | No alternatives -> suggest wider range |
| US-F07-09 | BK-09 | Check prerequisite from vertical_config against Booking table | Prerequisite unmet -> block + offer prerequisite booking |
| US-F07-10 | (implied) | Reschedule intent -> new query -> update booking + event | Conflict -> alternatives, original preserved until confirmed |
| US-F07-11 | (implied) | Cancel intent -> ProposedAction -> staff approval -> cancel | Staff rejects -> booking unchanged, dependent bookings -> warn |

## Dependencies

- **F-05 (Context Assembly & AI Draft Generation):** The Client Worker generates all booking-related drafts. Slot proposals and confirmations are standard Client Worker outputs with booking tools available.
- **F-06 (Approval Workflow & Governance):** All booking mutations (`calendar_book`) produce ProposedActions that pass through the approval workflow. Staff must approve before calendar events and booking records are created.
- **F-01 (Workspace Onboarding):** The vertical_config with appointment types, durations, buffers, and prerequisites is created during onboarding (ON-04, ON-05). Booking logic depends on this configuration existing.
- **ADR-1 (Single Agent with Tools):** Calendar operations are tools within the Client Worker, not a separate agent. `calendar_query` (read) and `calendar_book` (propose_write) are tool calls within a single LLM invocation.
- **ADR-4 (Booking drafts through Client Worker):** All booking drafts flow through the standard Client Worker path, ensuring consistent context assembly and tone application.
