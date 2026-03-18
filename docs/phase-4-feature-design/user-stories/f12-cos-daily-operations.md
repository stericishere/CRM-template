# User Stories — F-12: COS Daily Operations & Today's View

**Feature:** F-12 COS Daily Operations & Today's View
**Phase:** 3
**Size:** XL
**PRD Functions:** CO-01, CO-02, CO-03, CO-04, CO-05, CO-06, CO-07, NF-07
**Architecture modules:** `agent/COSOperationsRuntime`, `follow-up-management` (SurfaceOverdueFollowUps), `booking-operations`, `jobs/DailyFollowUpJob`
**ADR dependencies:** ADR-4 (COS identifies clients, Client Worker drafts messages), ADR-1 (COS is a separate LLM invocation path, not multi-agent)

---

## Context

The Chief of Staff (COS) is the system's proactive operational brain. While the Client Worker (F-05) reacts to individual inbound messages, the COS operates at the workspace level, scanning structured records across all clients to surface what needs attention today. It runs daily on a per-workspace cron and can be triggered on-demand by staff queries.

The COS works exclusively from structured records -- follow-ups, bookings, conversation state metadata, and client lifecycle status. It never reads message content or client-specific memory. This is a hard architectural boundary (Architecture Spec SS 5.1): the COS sees that a follow-up is overdue or a booking is unconfirmed, but not what the client said.

The COS produces two outputs:
1. A **ranked action list** for staff (displayed in the Today's View) -- prioritized by urgency via an LLM call (CO-04).
2. A **draft queue** -- Client Worker invocations dispatched per client needing follow-up or confirmation reminders (CO-05, CO-07). Each draft is generated through the normal Client Worker path with full per-client context (ADR-4).

A critical additional responsibility is **warm lead identification**. The COS should detect clients who showed interest (asked questions, requested information) but never booked -- clients in lifecycle status `open` or `chosen_service` with stale conversations. These represent revenue at risk of falling through the cracks, and the system must surface them for follow-up to nurture them toward a booking.

### Data model references

**COSOperationsContext** (Architecture Spec SS 5.3):
```typescript
type COSOperationsContext = {
  workspace: WorkspaceConfig;
  overdueFollowUps: Array<{ clientName, followUpContent, dueDate, daysPastDue }>;
  staleConversations: Array<{ clientName, lastMessageAt, conversationState, daysSinceContact }>;
  todayBookings: Array<{ clientName, appointmentType, startTime, confirmationStatus }>;
  atRiskBookings: Array<{ clientName, appointmentType, startTime, reason }>;
};
```

**Conversation state timeouts** (PRD SS 13.7):
| State | Timeout |
|---|---|
| `booking_in_progress` | 24h --> `follow_up_pending` |
| `awaiting_client_reply` | 24h (configurable) --> `follow_up_pending` |
| `awaiting_staff_review` | 1h --> re-send notification |
| `follow_up_pending` | Daily cron generates follow-up draft |

**Booking confirmation** (PRD SS 12.7): `confirmation_status` enum: `pending`, `confirmed`, `unconfirmed`. Booking `status` enum: `confirmed`, `at_risk`, `cancelled`, `completed`, `no_show`.

**Client lifecycle** (PRD SS 13.6): `open`, `chosen_service`, `upcoming_appointment`, `follow_up`, `review_complete`, `inactive`.

### Dependencies

- **F-11 (Daily Memory Compaction):** Compact summaries must exist for Client Worker follow-up drafts.
- **F-09 (Notes, Follow-ups & Knowledge):** Follow-up records that the COS scans for overdue items.
- **F-05 (Context Assembly & AI Drafting):** Client Worker runtime that generates the actual follow-up and confirmation drafts.
- **F-07 (Booking & Scheduling):** Booking records with confirmation status that the COS queries.
- **F-03 (Client Identity):** Client lifecycle status used for warm lead detection.

---

## Story US-F12-01 -- Daily Cron Trigger per Workspace Timezone (CO-01)

**As a** workspace owner,
**I want** the COS to run automatically once per day at a consistent time in my business timezone,
**so that** my team starts each day with a fresh view of what needs attention, without anyone having to remember to check.

### Acceptance criteria

```gherkin
Feature: Daily COS cron trigger per workspace timezone

  Background:
    Given workspace "WS-001" exists with timezone = "Asia/Hong_Kong"
    And workspace "WS-002" exists with timezone = "America/New_York"
    And each workspace has active clients with follow-ups, bookings, and conversations

  Scenario: COS runs at configured time in workspace timezone
    Given the COS daily cron is scheduled for 07:00 local time
    When the clock reaches 07:00 Asia/Hong_Kong (23:00 UTC previous day)
    Then the COS run begins for workspace "WS-001"
    And a COS run record is created with:
      | field          | value                    |
      | workspace_id   | "WS-001"                 |
      | trigger        | "daily_cron"             |
      | started_at     | current UTC timestamp    |
      | status         | "running"                |

  Scenario: Each workspace runs independently at its own local time
    When the clock reaches 07:00 Asia/Hong_Kong
    Then the COS runs for "WS-001"
    And the COS does NOT run for "WS-002" (whose 07:00 is 12:00 UTC)
    When the clock later reaches 07:00 America/New_York (12:00 UTC)
    Then the COS runs for "WS-002"

  Scenario: COS run completes and records outcome
    When the COS run finishes for workspace "WS-001"
    Then the COS run record is updated with:
      | field          | value                    |
      | status         | "completed"              |
      | completed_at   | current UTC timestamp    |
      | actions_found  | integer count of items   |
      | drafts_queued  | integer count of drafts  |

  Scenario: COS run failure is recorded and does not crash the scheduler
    Given the COS run for "WS-001" encounters a database error
    Then the COS run record is updated with status = "failed" and an error message
    And the scheduler continues to process other workspaces
    And an alert is emitted for operational monitoring
    And the next daily cron for "WS-001" still runs the following day

  Scenario: COS does not run for inactive workspaces
    Given workspace "WS-003" has no active clients and no activity in the last 30 days
    Then the COS cron skips "WS-003" to conserve resources
    And no COS run record is created for "WS-003"

  Scenario: COS cron is idempotent for same-day re-runs
    Given the COS already completed a run for "WS-001" today
    When the cron fires again for "WS-001" on the same calendar day (e.g., due to scheduler restart)
    Then the COS skips the duplicate run
    And logs a message indicating the run was already completed today
```

### Notes

- The COS cron runs after memory compaction (F-11) each day, so compact summaries are fresh when Client Workers generate follow-up drafts. The recommended scheduling order is: compaction cron first, then COS cron (e.g., compaction at 06:00 local, COS at 07:00 local).
- The workspace timezone is set during onboarding (F-01) and stored in `WorkspaceConfig`. All time comparisons use UTC internally; timezone is applied only for scheduling the cron trigger.
- The COS run record provides an audit trail and supports operational monitoring (e.g., alert if a COS run takes longer than 5 minutes or fails).

---

## Story US-F12-02 -- Stale Conversation Detection (CO-02)

**As a** staff member,
**I want** the COS to detect conversations where the client has gone silent past the configured timeout,
**so that** I am alerted to clients who may be losing interest and can re-engage them before they go cold.

### Acceptance criteria

```gherkin
Feature: Stale conversation detection

  Background:
    Given workspace "WS-001" exists with default staleness threshold = 24 hours
    And today is "2026-03-18"

  Scenario: Conversation in awaiting_client_reply exceeding timeout is flagged stale
    Given client "client-abc" has conversation state = "awaiting_client_reply"
    And the last outbound message was sent at "2026-03-16T10:00:00Z" (over 48 hours ago)
    When the COS runs stale conversation detection for "WS-001"
    Then client "client-abc" appears in the staleConversations list with:
      | field              | value                    |
      | clientName         | "client-abc" display name|
      | lastMessageAt      | "2026-03-16T10:00:00Z"   |
      | conversationState  | "awaiting_client_reply"  |
      | daysSinceContact   | 2                        |

  Scenario: Conversation in booking_in_progress exceeding 24h timeout is flagged stale
    Given client "client-def" has conversation state = "booking_in_progress"
    And the last message was at "2026-03-17T06:00:00Z" (over 24 hours ago)
    When the COS runs stale conversation detection
    Then client "client-def" appears in the staleConversations list
    And conversationState = "booking_in_progress"
    And daysSinceContact = 1

  Scenario: Conversation in follow_up_pending is included
    Given client "client-ghi" has conversation state = "follow_up_pending"
    When the COS runs stale conversation detection
    Then client "client-ghi" appears in the staleConversations list
    And the reason indicates the conversation timed out into follow_up_pending

  Scenario: Active conversations within timeout are NOT flagged
    Given client "client-jkl" has conversation state = "awaiting_client_reply"
    And the last outbound message was sent 6 hours ago
    When the COS runs stale conversation detection
    Then client "client-jkl" does NOT appear in the staleConversations list

  Scenario: Idle conversations are NOT flagged as stale
    Given client "client-mno" has conversation state = "idle"
    When the COS runs stale conversation detection
    Then client "client-mno" does NOT appear in the staleConversations list
    Because idle conversations are resolved and require no action

  Scenario: Staleness thresholds are configurable per workspace
    Given workspace "WS-001" has staleness_threshold_hours = 48 (custom override)
    And client "client-pqr" has conversation state = "awaiting_client_reply"
    And the last message was 30 hours ago
    When the COS runs stale conversation detection
    Then client "client-pqr" does NOT appear in the staleConversations list
    Because 30 hours < 48 hour threshold

  Scenario: Detection reads only structured metadata, never message content
    When the COS queries for stale conversations
    Then the query accesses only conversation.state, conversation.last_message_at, and client.full_name
    And no message body, note content, or memory record is read by the COS
```

### Notes

- Stale conversation detection is a pure database query against conversation state and `last_message_at` timestamps. No LLM is involved (CO-02 is marked LLM: No in the PRD function list).
- The conversation state machine (PRD SS 13.7) defines timeouts: `awaiting_client_reply` times out at 24h (configurable), `booking_in_progress` at 24h. These timeouts transition the state to `follow_up_pending`, which the COS then picks up.
- The COS detects both conversations that have already transitioned to `follow_up_pending` and conversations still in timeout-eligible states that have exceeded their threshold (in case the state transition job hasn't run yet).

---

## Story US-F12-03 -- Unconfirmed Booking Detection (CO-03)

**As a** staff member,
**I want** the COS to detect bookings that are approaching but have not been confirmed by the client,
**so that** I can send confirmation reminders before the appointment and avoid no-shows.

### Acceptance criteria

```gherkin
Feature: Unconfirmed booking detection

  Background:
    Given workspace "WS-001" exists
    And today is "2026-03-18"
    And the default confirmation reminder window is 48 hours before appointment

  Scenario: Booking within reminder window with pending confirmation is flagged
    Given client "client-abc" has a booking:
      | field                | value                    |
      | appointment_type     | "initial_consultation"   |
      | start_time           | "2026-03-20T14:00:00Z"   |
      | status               | "confirmed"              |
      | confirmation_status  | "pending"                |
    When the COS runs unconfirmed booking detection
    Then the booking appears in the atRiskBookings list with:
      | field              | value                        |
      | clientName         | client "client-abc" name     |
      | appointmentType    | "initial_consultation"       |
      | startTime          | "2026-03-20T14:00:00Z"       |
      | reason             | "confirmation_pending"       |

  Scenario: Booking outside the reminder window is not flagged
    Given client "client-def" has a booking with start_time = "2026-03-25T10:00:00Z"
    And confirmation_status = "pending"
    When the COS runs unconfirmed booking detection
    Then the booking does NOT appear in the atRiskBookings list
    Because the appointment is more than 48 hours away

  Scenario: Booking with confirmed confirmation status is not flagged
    Given client "client-ghi" has a booking with start_time = "2026-03-19T09:00:00Z"
    And confirmation_status = "confirmed"
    When the COS runs unconfirmed booking detection
    Then the booking does NOT appear in the atRiskBookings list

  Scenario: Booking explicitly marked unconfirmed is flagged with elevated urgency
    Given client "client-jkl" has a booking with:
      | field                | value                    |
      | start_time           | "2026-03-19T11:00:00Z"   |
      | confirmation_status  | "unconfirmed"            |
    When the COS runs unconfirmed booking detection
    Then the booking appears in the atRiskBookings list with reason = "client_unconfirmed"
    And it is marked as higher urgency than a "confirmation_pending" booking

  Scenario: Cancelled and completed bookings are excluded
    Given client "client-mno" has a booking with status = "cancelled"
    And confirmation_status = "pending"
    When the COS runs unconfirmed booking detection
    Then the booking does NOT appear in the atRiskBookings list

  Scenario: Today's bookings with pending confirmation are highest priority
    Given client "client-pqr" has a booking with:
      | field                | value                    |
      | start_time           | "2026-03-18T16:00:00Z"   |
      | confirmation_status  | "pending"                |
    When the COS runs unconfirmed booking detection
    Then the booking appears in atRiskBookings with reason = "same_day_unconfirmed"
    And it is flagged at the highest urgency level
```

### Notes

- Unconfirmed booking detection is a pure database query (CO-03 is LLM: No). The confirmation reminder window (default 48h) is configurable per workspace.
- Per PRD SS 9.7: "Before appointment day: confirmation draft for staff to send. If unconfirmed: flagged at-risk." The COS detects the condition; the confirmation reminder draft is generated separately (US-F12-07, CO-07).
- MVP does not support automated cancellation. The COS flags at-risk bookings; staff decides whether to send a reminder, reschedule, or cancel.
- The booking `status` field transitions to `at_risk` when the COS flags it. This is a write operation performed by the COS run.

---

## Story US-F12-04 -- LLM-Powered Priority Ranking (CO-04)

**As a** staff member opening the Today's View,
**I want** all actionable items (stale conversations, overdue follow-ups, unconfirmed bookings, warm leads) ranked by urgency,
**so that** I handle the most time-sensitive and revenue-critical items first instead of scanning through an unordered list.

### Acceptance criteria

```gherkin
Feature: LLM-powered priority ranking of COS actions

  Background:
    Given workspace "WS-001" has completed COS detection steps (CO-02, CO-03, NF-07)
    And the following items have been identified:
      | type                  | client       | detail                                    |
      | overdue_follow_up     | "Alice"      | 3 days overdue, promised a quote           |
      | stale_conversation    | "Bob"        | 2 days since last message, booking started |
      | unconfirmed_booking   | "Carol"      | appointment tomorrow, unconfirmed          |
      | stale_conversation    | "Diana"      | 5 days since last message, general inquiry |
      | warm_lead             | "Eve"        | asked about pricing 4 days ago, no booking |
      | overdue_follow_up     | "Frank"      | 1 day overdue, routine check-in           |

  Scenario: COS ranks items by urgency via LLM
    When the COS invokes the LLM with the COSOperationsContext
    Then the LLM returns a ranked action list ordered by urgency
    And the ranking considers:
      | factor                         | weight indicator     |
      | time until appointment         | highest for imminent |
      | days overdue                   | higher is more urgent|
      | revenue risk (booking vs lead) | bookings > leads     |
      | days since contact             | longer is more urgent|
      | conversation state             | booking_in_progress > general inquiry |

  Scenario: Same-day unconfirmed booking ranks above multi-day-old follow-up
    Given "Carol" has an unconfirmed booking for tomorrow
    And "Alice" has a follow-up 3 days overdue
    When the COS ranks the action list
    Then "Carol" (unconfirmed booking) ranks above or equal to "Alice" (overdue follow-up)
    Because imminent appointment loss is time-critical

  Scenario: Each ranked item includes a reason summary
    When the COS returns the ranked list
    Then each item has a human-readable reason field, for example:
      | client  | reason                                                  |
      | Carol   | "Appointment tomorrow at 2pm -- confirmation pending"   |
      | Alice   | "Quote promised 3 days ago -- no follow-up sent"        |
      | Bob     | "Started booking 2 days ago -- went silent"             |
      | Eve     | "Asked about pricing 4 days ago -- no booking yet"      |

  Scenario: Ranking uses only structured metadata, not message content
    When the LLM receives the COSOperationsContext
    Then the context contains client names, dates, states, and follow-up descriptions
    And the context does NOT contain message bodies, conversation history, or memory summaries

  Scenario: LLM ranking failure falls back to deterministic ordering
    Given the LLM call fails (timeout, rate limit, error)
    Then the system falls back to a deterministic sort:
      | primary sort      | secondary sort      |
      | item type priority| days since due/contact|
    Where type priority is: same_day_booking > unconfirmed_booking > overdue_follow_up > stale_conversation > warm_lead
    And the Today's View is still populated (without LLM-generated reasons)

  Scenario: Ranking is stored with the COS run
    When the COS produces a ranked list
    Then the ranked items are persisted with:
      | field          | value                    |
      | cos_run_id     | FK to the COS run record |
      | rank           | integer position         |
      | item_type      | enum of action type      |
      | client_id      | FK to client             |
      | reason         | LLM-generated text       |
      | urgency_score  | numeric (for API use)    |
```

### Notes

- Priority ranking is the only LLM-dependent step in the COS pipeline (CO-04 is marked LLM: Yes). All detection steps (CO-02, CO-03, NF-07) are pure database queries.
- The LLM call receives the full `COSOperationsContext` (Architecture Spec SS 5.3) containing aggregated structured records across all clients. This is a separate LLM invocation path from the Client Worker (ADR-1).
- The fallback deterministic ordering ensures the Today's View is never empty due to an LLM failure. Staff can still see all items; they just lack the LLM-generated priority and reason text.
- The ranking should be completed within a reasonable time budget. If the workspace has more than ~100 actionable items, the COS should batch and rank in chunks.

---

## Story US-F12-05 -- Overdue Follow-up Surfacing (NF-07)

**As a** staff member,
**I want** the COS to identify all follow-ups that have passed their due date without being completed,
**so that** overdue commitments are surfaced daily and I never silently miss a promise made to a client.

### Acceptance criteria

```gherkin
Feature: Overdue follow-up surfacing

  Background:
    Given workspace "WS-001" exists
    And today is "2026-03-18"

  Scenario: Follow-up past due date with status open is surfaced
    Given client "client-abc" has a follow-up:
      | field      | value                              |
      | content    | "Send revised quote for alterations"|
      | type       | "follow_up"                        |
      | due_date   | "2026-03-15"                       |
      | status     | "open"                             |
    When the COS runs overdue follow-up detection
    Then the follow-up appears in the overdueFollowUps list with:
      | field            | value                              |
      | clientName       | client "client-abc" display name   |
      | followUpContent  | "Send revised quote for alterations"|
      | dueDate          | "2026-03-15"                       |
      | daysPastDue      | 3                                  |

  Scenario: Follow-up past due date with status pending is also surfaced
    Given client "client-def" has a follow-up with status = "pending" and due_date = "2026-03-16"
    When the COS runs overdue follow-up detection
    Then the follow-up appears in the overdueFollowUps list with daysPastDue = 2

  Scenario: Follow-up status is transitioned to overdue
    Given a follow-up has status = "open" and due_date = "2026-03-15"
    When the COS runs and detects it as overdue
    Then the follow-up status is updated to "overdue" in the database
    And an audit event is logged with action = "followup_status_updated", before = "open", after = "overdue"

  Scenario: Already-overdue follow-ups continue to be surfaced
    Given a follow-up has status = "overdue" (set by a previous COS run)
    And it has not been completed or dismissed
    When the COS runs again
    Then the follow-up still appears in the overdueFollowUps list
    And daysPastDue is recalculated to the current date

  Scenario: Completed follow-ups are excluded
    Given a follow-up has status = "completed" and due_date = "2026-03-10"
    When the COS runs overdue follow-up detection
    Then the follow-up does NOT appear in the overdueFollowUps list

  Scenario: Follow-ups without a due date are excluded from overdue detection
    Given a follow-up has due_date = null and status = "open"
    When the COS runs overdue follow-up detection
    Then the follow-up does NOT appear in the overdueFollowUps list
    Because there is no due date to compare against

  Scenario: Promises are surfaced alongside regular follow-ups
    Given client "client-ghi" has a follow-up with type = "promise":
      | field      | value                                  |
      | content    | "Promised 10% discount on next visit"  |
      | due_date   | "2026-03-17"                           |
      | status     | "open"                                 |
    When the COS runs overdue follow-up detection
    Then the promise appears in the overdueFollowUps list with daysPastDue = 1
    And the item type indicates it is a promise (for ranking purposes)
```

### Notes

- Overdue follow-up surfacing (NF-07) is marked LLM: Yes in the PRD function list because the COS uses the LLM to rank the surfaced items (CO-04). The detection query itself is a pure database operation: `SELECT ... WHERE due_date < CURRENT_DATE AND status IN ('open', 'pending')`.
- The COS transitions follow-up status from `open`/`pending` to `overdue` as a side effect of detection. This ensures the follow-up status is accurate for context assembly (F-05) and client profile views.
- Follow-ups without due dates are not surfaced as overdue, but they may still appear in the Today's View as open items if they are associated with a stale conversation.
- The COS reads follow-up `content` for the ranked action list (so staff can see what the follow-up is about), but never reads message content or conversation history.

---

## Story US-F12-06 -- Follow-up Draft Dispatch to Client Workers (CO-05)

**As a** staff member,
**I want** the COS to automatically queue contextually rich follow-up draft messages for each client who needs attention,
**so that** I receive ready-to-review drafts in my inbox without having to manually compose re-engagement messages for every stale thread or overdue item.

### Acceptance criteria

```gherkin
Feature: Follow-up draft dispatch to Client Workers

  Background:
    Given workspace "WS-001" exists
    And the COS has completed detection and ranking for today
    And the ranked action list contains:
      | rank | client       | type                  |
      | 1    | "client-abc" | overdue_follow_up     |
      | 2    | "client-def" | stale_conversation    |
      | 3    | "client-ghi" | warm_lead             |

  Scenario: COS queues a Client Worker invocation per client needing follow-up
    When the COS dispatches follow-up drafts
    Then a BullMQ job is enqueued for each client in the action list:
      | job                    | client_id    | draft_type       |
      | ClientWorkerFollowUp   | "client-abc" | "follow_up"      |
      | ClientWorkerFollowUp   | "client-def" | "re_engagement"  |
      | ClientWorkerFollowUp   | "client-ghi" | "lead_nurture"   |
    And each job includes:
      | field          | value                              |
      | workspace_id   | "WS-001"                           |
      | client_id      | the specific client's ID           |
      | cos_run_id     | FK to the current COS run          |
      | action_reason  | the LLM-generated reason from ranking |
      | draft_type     | follow_up / re_engagement / lead_nurture / confirmation |

  Scenario: Client Worker generates draft using full per-client context
    When the Client Worker processes a queued follow-up job for "client-abc"
    Then context assembly runs for "client-abc" (F-05) including:
      | context component     | included |
      | workspace config      | yes      |
      | client profile        | yes      |
      | compact summary       | yes      |
      | recent messages       | yes      |
      | active follow-ups     | yes      |
      | active bookings       | yes      |
    And the Client Worker generates a draft reply that:
      | quality attribute       | requirement                          |
      | references the reason   | mentions the overdue item naturally  |
      | uses client context     | addresses client by name, references history |
      | matches workspace tone  | consistent with tone profile from F-01|
    And the draft is stored in the normal draft queue for staff review

  Scenario: Multiple follow-ups for the same client are batched into one draft
    Given client "client-abc" has 2 overdue follow-ups and 1 stale conversation
    When the COS dispatches follow-up drafts
    Then only ONE Client Worker invocation is queued for "client-abc"
    And the job includes all action reasons for that client
    And the Client Worker produces a single cohesive draft covering all items

  Scenario: Draft dispatch respects rate limits
    Given workspace "WS-001" has 25 clients needing follow-up
    When the COS dispatches follow-up drafts
    Then jobs are enqueued with a staggered delay (e.g., 2-second intervals)
    And the LLM provider rate limit is not exceeded
    And all 25 jobs complete within the daily processing window

  Scenario: Failed Client Worker invocation is retried
    Given a Client Worker job for "client-def" fails due to an LLM timeout
    Then the job is retried up to 3 times with exponential backoff
    And if all retries fail, the item remains in the Today's View without a draft
    And staff is notified that a draft could not be generated for "client-def"

  Scenario: COS does not draft messages itself
    When the COS dispatches follow-up jobs
    Then no draft text is generated by the COS LLM call
    And the COS only provides the action reason and draft type to the Client Worker
    Because per ADR-4, the COS identifies clients while Client Workers draft messages
```

### Notes

- This story enforces ADR-4: the COS identifies which clients need follow-up and why, but never generates draft message text itself. The COS lacks conversational context and client-specific memory -- only the Client Worker can produce contextually rich, tone-appropriate drafts.
- The `draft_type` field helps the Client Worker understand the intent: `follow_up` (overdue item), `re_engagement` (stale conversation), `lead_nurture` (warm lead), or `confirmation` (booking reminder, handled by US-F12-07).
- Follow-up drafts arrive in the staff inbox just like reactive drafts from inbound messages. Staff reviews, optionally edits, and sends through the normal approval workflow (F-06).
- Rate limiting is important because the COS may queue many Client Worker calls simultaneously. BullMQ's built-in rate limiter or a staggered delay prevents overwhelming the LLM provider.

---

## Story US-F12-07 -- Appointment Confirmation Reminder Drafts (CO-07)

**As a** staff member,
**I want** the COS to automatically generate confirmation reminder drafts for upcoming appointments that haven't been confirmed,
**so that** I can send reminders to clients before their appointment without manually tracking who needs one.

### Acceptance criteria

```gherkin
Feature: Appointment confirmation reminder drafts

  Background:
    Given workspace "WS-001" exists
    And the default confirmation reminder lead time is 48 hours
    And today is "2026-03-18"

  Scenario: Confirmation reminder draft is queued for unconfirmed booking within window
    Given client "client-abc" has a booking:
      | field                | value                    |
      | appointment_type     | "fitting_session"        |
      | start_time           | "2026-03-20T14:00:00Z"   |
      | confirmation_status  | "pending"                |
      | status               | "confirmed"              |
    When the COS runs confirmation reminder detection
    Then a Client Worker job is queued with:
      | field          | value                    |
      | client_id      | "client-abc"             |
      | draft_type     | "confirmation"           |
      | action_reason  | "Fitting session on March 20 at 2pm -- confirmation pending" |
    And the booking status is updated to "at_risk" if confirmation_status remains "pending"

  Scenario: Client Worker generates a personalized confirmation reminder draft
    When the Client Worker processes the confirmation job for "client-abc"
    Then the generated draft:
      | attribute           | requirement                                       |
      | mentions appointment| includes date, time, and appointment type          |
      | asks for confirmation| clearly requests the client to confirm attendance |
      | uses client name    | addresses the client personally                    |
      | matches tone        | consistent with workspace tone profile             |
    And the draft appears in the staff inbox for review and sending

  Scenario: No reminder is generated if confirmation is already received
    Given client "client-def" has a booking with confirmation_status = "confirmed"
    When the COS runs confirmation reminder detection
    Then no Client Worker job is queued for "client-def"

  Scenario: No reminder is generated for bookings outside the reminder window
    Given client "client-ghi" has a booking with start_time = "2026-03-25T10:00:00Z"
    And confirmation_status = "pending"
    When the COS runs confirmation reminder detection
    Then no Client Worker job is queued for "client-ghi"
    Because the appointment is more than 48 hours away

  Scenario: Duplicate reminders are prevented for the same booking
    Given a confirmation reminder draft was already generated for booking "bk-001" today
    When the COS runs again (e.g., on-demand trigger)
    Then no additional Client Worker job is queued for booking "bk-001"
    And the existing draft remains in the staff inbox

  Scenario: Same-day unconfirmed bookings get urgent reminder drafts
    Given client "client-jkl" has a booking:
      | field                | value                    |
      | start_time           | "2026-03-18T16:00:00Z"   |
      | confirmation_status  | "pending"                |
    When the COS runs confirmation reminder detection
    Then a Client Worker job is queued with draft_type = "confirmation" and urgency = "high"
    And the action reason indicates "Same-day appointment at 4pm -- still unconfirmed"

  Scenario: Cancelled bookings do not generate reminders
    Given client "client-mno" has a booking with status = "cancelled"
    When the COS runs confirmation reminder detection
    Then no Client Worker job is queued for "client-mno"
```

### Notes

- Per PRD SS 9.7: "Before appointment day: confirmation draft for staff to send. If unconfirmed: flagged at-risk. Staff decides action. MVP supports reminders and confirmation -- not automated cancellation."
- The COS flags bookings as `at_risk` (booking status field) when it detects pending confirmation within the reminder window. This status change is visible in the client profile and Today's View.
- Confirmation reminders follow the same ADR-4 pattern as follow-up drafts: the COS identifies the booking and queues a Client Worker invocation. The Client Worker generates the actual reminder draft with full client context.
- The duplicate prevention check uses a combination of `booking_id` + `cos_run_date` to ensure one reminder per booking per day.

---

## Story US-F12-08 -- Today's View Aggregation (CO-06)

**As a** staff member starting my workday,
**I want** a single Today's View screen that shows today's appointments, pending follow-ups, at-risk bookings, and warm leads -- all ranked by urgency,
**so that** I have a complete operational picture without switching between multiple screens or manually assembling information.

### Acceptance criteria

```gherkin
Feature: Today's View aggregation

  Background:
    Given workspace "WS-001" exists
    And the COS daily run has completed for today
    And today is "2026-03-18"

  Scenario: Today's View displays today's bookings
    Given the following bookings exist for today:
      | client       | appointment_type       | start_time          | confirmation_status |
      | "Alice"      | "initial_consultation" | "2026-03-18T09:00Z" | "confirmed"         |
      | "Bob"        | "fitting_session"      | "2026-03-18T14:00Z" | "pending"           |
      | "Carol"      | "final_fitting"        | "2026-03-18T16:30Z" | "confirmed"         |
    When staff opens the Today's View
    Then all three bookings are displayed in chronological order
    And each booking shows: client name, appointment type, start time (in workspace timezone), confirmation status
    And "Bob" is visually highlighted as at-risk (pending confirmation)

  Scenario: Today's View displays pending follow-ups ranked by urgency
    Given the COS ranked action list contains:
      | rank | client  | type               | reason                                   |
      | 1    | "Diana" | overdue_follow_up  | "Quote promised 3 days ago"              |
      | 2    | "Eve"   | stale_conversation | "Started booking 2 days ago, went silent"|
      | 3    | "Frank" | warm_lead          | "Asked about pricing 4 days ago"         |
    When staff opens the Today's View
    Then the follow-up / action section shows items in rank order
    And each item displays: client name, action type, reason, days overdue or since contact
    And each item links to the client thread for immediate action

  Scenario: Today's View displays at-risk bookings
    Given booking for "Bob" has been flagged at-risk by the COS
    When staff opens the Today's View
    Then "Bob" appears in both the bookings timeline and the at-risk section
    And the at-risk section shows the reason ("confirmation pending, appointment today at 2pm")
    And a "Send reminder" action is available if a confirmation draft exists

  Scenario: Today's View shows draft availability status
    Given the COS queued Client Worker drafts for "Diana" and "Eve"
    And the draft for "Diana" has been generated and is ready for review
    And the draft for "Eve" is still processing
    When staff opens the Today's View
    Then "Diana" shows a "Draft ready" indicator with a link to review
    And "Eve" shows a "Draft generating..." indicator

  Scenario: Today's View is accessible before the daily COS run
    Given the COS has not yet run today (e.g., staff opens the app before 07:00)
    When staff opens the Today's View
    Then today's bookings are displayed (queried directly from booking records)
    And the follow-up / action section shows a message: "Daily analysis will run at 7:00 AM"
    And any items from the previous COS run are still visible as stale data

  Scenario: Today's View updates after an on-demand COS trigger
    Given the COS ran at 07:00 and produced a ranked list
    And staff later completes a follow-up for "Diana"
    And staff triggers an on-demand COS refresh
    Then the Today's View updates to reflect "Diana" is no longer pending
    And the remaining items are re-ranked

  Scenario: Empty Today's View shows a positive state
    Given there are no bookings today, no overdue follow-ups, and no stale conversations
    When staff opens the Today's View
    Then a message is displayed: "All caught up -- no items need attention today"
    And the view still shows the next upcoming booking (if any) as a preview
```

### Notes

- The Today's View is a core surface defined in PRD SS 16.2: "Today's appointments. Pending follow-ups. At-risk bookings." This story extends it to include warm leads per the owner's requirement.
- The Today's View is a read-only aggregation of data produced by the COS run. It does not trigger any writes or LLM calls on load.
- Today's bookings are always available (direct query against booking records), even before the COS runs. The ranked action list depends on the COS having run.
- The view should support real-time or near-real-time updates (e.g., via Supabase Realtime subscriptions) so that when a staff member completes a follow-up, the item disappears from the Today's View without a manual refresh.
- Latency target: the Today's View should load within 2 seconds (PRD SS 16.3 context loading target).

---

## Story US-F12-09 -- Warm Lead Identification (Owner Requirement)

**As a** business owner,
**I want** the COS to automatically identify clients who showed interest in services but never booked,
**so that** my team follows up with these warm leads before they go cold, and potential revenue is not lost.

### Acceptance criteria

```gherkin
Feature: Warm lead identification

  Background:
    Given workspace "WS-001" exists
    And today is "2026-03-18"

  Scenario: Client with interest signals and no booking is identified as warm lead
    Given client "client-abc" has:
      | field              | value                |
      | lifecycle_status   | "open"               |
      | last_message_at    | "2026-03-14"         |
    And client "client-abc" has an open follow-up: "Asked about wedding suit pricing and timeline"
    And client "client-abc" has no bookings (past or future)
    When the COS runs warm lead detection
    Then client "client-abc" appears in the action list as type = "warm_lead"
    And the reason references the interest follow-up: "Asked about pricing 4 days ago -- no booking created"

  Scenario: Client in chosen_service without a booking is identified as warm lead
    Given client "client-def" has:
      | field              | value                |
      | lifecycle_status   | "chosen_service"     |
      | last_message_at    | "2026-03-12"         |
    And client "client-def" has no future bookings
    When the COS runs warm lead detection
    Then client "client-def" appears as a warm lead
    And the reason indicates: "Selected a service 6 days ago but hasn't booked"

  Scenario: Client with a future booking is NOT flagged as warm lead
    Given client "client-ghi" has lifecycle_status = "open"
    And client "client-ghi" has a booking with start_time in the future
    When the COS runs warm lead detection
    Then client "client-ghi" does NOT appear as a warm lead
    Because they already have a booking

  Scenario: Client with lifecycle_status inactive is NOT flagged as warm lead
    Given client "client-jkl" has lifecycle_status = "inactive"
    And client "client-jkl" has no bookings
    When the COS runs warm lead detection
    Then client "client-jkl" does NOT appear as a warm lead
    Because inactive clients have been dormant beyond the interest window

  Scenario: Client who messaged recently (within 24h) is not yet a warm lead
    Given client "client-mno" has lifecycle_status = "open"
    And client "client-mno" last messaged 6 hours ago
    When the COS runs warm lead detection
    Then client "client-mno" does NOT appear as a warm lead
    Because the conversation is still active and within normal response time

  Scenario: Warm lead detection uses configurable interest decay window
    Given workspace "WS-001" has warm_lead_window_days = 14
    And client "client-pqr" has lifecycle_status = "open" and last_message_at = "2026-03-02" (16 days ago)
    And client "client-pqr" has no bookings
    When the COS runs warm lead detection
    Then client "client-pqr" does NOT appear as a warm lead
    Because they are beyond the 14-day interest decay window
    And their lifecycle_status may transition to "inactive" via normal lifecycle rules

  Scenario: Warm lead drafts are generated with lead-nurturing intent
    Given "client-abc" is identified as a warm lead
    When the COS dispatches a Client Worker job for "client-abc"
    Then the job has draft_type = "lead_nurture"
    And the Client Worker generates a draft that:
      | attribute                 | requirement                                      |
      | re-engages naturally      | does not feel like a cold sales pitch             |
      | references prior interest | mentions what the client asked about              |
      | suggests next step        | proposes a low-commitment action (e.g., "happy to answer more questions") |
      | matches workspace tone    | consistent with business tone profile              |
```

### Notes

- Warm lead identification is a database query that combines: (1) lifecycle status in `open` or `chosen_service`, (2) no future bookings, (3) last message older than the staleness threshold but within the interest decay window, and (4) presence of open follow-ups or active conversation history indicating interest.
- The interest decay window (default: 14 days, configurable) defines how long a lead remains "warm" after last contact. Beyond this window, the client is likely cold and should transition to `inactive` rather than generating warm lead follow-ups.
- This detection runs as part of the COS daily cron alongside stale conversation and overdue follow-up detection. Warm leads appear in the ranked action list (CO-04) and the Today's View (CO-06).
- The lead-nurturing draft type guides the Client Worker to generate re-engagement messages that are softer and more exploratory than transactional follow-ups. The draft should feel like a natural continuation of the conversation, not a sales push.
- The owner's core requirement: "surface warm leads -- clients who showed interest but haven't booked yet. Suggest follow-up actions to nurture them toward a booking."

---

## Story US-F12-10 -- On-Demand COS Query (Architecture Spec SS 5.2)

**As a** staff member during the workday,
**I want to** ask the system "who needs follow-up?" or "what's today's schedule?" at any time,
**so that** I get an up-to-the-moment operational picture without waiting for the next daily cron.

### Acceptance criteria

```gherkin
Feature: On-demand COS query

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And workspace "WS-001" has active clients with various follow-ups, bookings, and conversations

  Scenario: Staff asks "who needs follow-up?"
    When staff triggers the "who needs follow-up?" query (via Today's View refresh or command)
    Then the COS runs the full detection pipeline on-demand:
      | step                        | executes |
      | stale conversation detection | yes     |
      | overdue follow-up detection  | yes     |
      | unconfirmed booking detection| yes     |
      | warm lead detection          | yes     |
      | LLM priority ranking         | yes     |
    And the results are returned with the same ranked action list format as the daily cron
    And the Today's View is updated with the fresh results

  Scenario: Staff asks "what's today's schedule?"
    When staff triggers the "what's today's schedule?" query
    Then the system returns today's bookings across all clients:
      | field              | included |
      | client name        | yes      |
      | appointment type   | yes      |
      | start time         | yes (in workspace timezone) |
      | confirmation status| yes      |
    And bookings are sorted chronologically
    And unconfirmed bookings are flagged

  Scenario: On-demand query creates its own COS run record
    When staff triggers an on-demand COS query
    Then a COS run record is created with:
      | field     | value          |
      | trigger   | "on_demand"    |
      | triggered_by | "staff-001"|
    And the results are associated with this run record for audit

  Scenario: On-demand query does not duplicate draft dispatch
    Given the daily COS run already queued follow-up drafts for "client-abc" today
    When staff triggers an on-demand query
    Then the ranked list includes "client-abc" if still unresolved
    But no additional Client Worker draft job is queued for "client-abc"
    Because a draft is already pending or generated

  Scenario: On-demand query optionally dispatches new drafts for newly detected items
    Given the daily COS ran at 07:00 and dispatched drafts
    And since then, a new follow-up for "client-xyz" has become overdue
    When staff triggers an on-demand query at 14:00
    Then "client-xyz" appears in the ranked list
    And a new Client Worker draft job is queued for "client-xyz"
    Because this item was not detected in the earlier daily run

  Scenario: On-demand query completes within acceptable latency
    When staff triggers an on-demand COS query
    Then the detection queries complete in under 2 seconds
    And the LLM ranking completes in under 10 seconds
    And the full result is returned in under 15 seconds total

  Scenario: On-demand query is rate-limited per workspace
    Given staff triggers 3 on-demand queries within 5 minutes
    When staff attempts a 4th query
    Then the system returns the cached results from the most recent query
    And indicates "Results from 2 minutes ago -- next refresh available in 3 minutes"
```

### Notes

- On-demand COS queries run the same detection and ranking pipeline as the daily cron but are triggered interactively. Per Architecture Spec SS 5.2, the two on-demand trigger paths are: "who needs follow-up?" (full pipeline) and "what's today's schedule?" (bookings only).
- The "what's today's schedule?" query is lightweight -- it queries booking records directly without LLM ranking. The "who needs follow-up?" query runs the full pipeline including LLM ranking.
- Rate limiting prevents abuse and unnecessary LLM costs. A reasonable limit is 1 full pipeline run per 5 minutes per workspace, with cached results returned for intermediate requests.
- On-demand queries do not re-dispatch drafts for items already handled by the daily cron or a previous on-demand run. The duplicate detection uses `cos_run_id` + `client_id` + `draft_type` + `date`.

---

## Story map summary

| Story | PRD functions | Scope | Size estimate |
|-------|--------------|-------|---------------|
| US-F12-01 Daily cron trigger per workspace timezone | CO-01 | Cron scheduler + run records | S |
| US-F12-02 Stale conversation detection | CO-02 | DB query against conversation state + timestamps | S |
| US-F12-03 Unconfirmed booking detection | CO-03 | DB query against booking confirmation_status | S |
| US-F12-04 LLM-powered priority ranking | CO-04 | LLM call with COSOperationsContext | M |
| US-F12-05 Overdue follow-up surfacing | NF-07 | DB query + status transition | S |
| US-F12-06 Follow-up draft dispatch to Client Workers | CO-05 | BullMQ job queue + Client Worker integration | L |
| US-F12-07 Appointment confirmation reminder drafts | CO-07 | Detection + Client Worker dispatch for confirmations | M |
| US-F12-08 Today's View aggregation | CO-06 | UI surface aggregating COS outputs | M |
| US-F12-09 Warm lead identification | (owner req) | DB query + lead nurture draft dispatch | M |
| US-F12-10 On-demand COS query | CO-01 (extended) | On-demand pipeline trigger + caching | M |

**Total feature size: XL** (as per feature-list.md -- the orchestration across multiple detection queries, LLM ranking, Client Worker dispatch, Today's View aggregation, and on-demand support justify the sizing.)

---

## Out of scope for F-12

- **Automated cancellation of unconfirmed bookings** -- MVP supports reminders and confirmation only (PRD SS 9.7). Staff decides whether to cancel.
- **Message reading by the COS** -- The COS never reads message content, conversation history, or client memory. It operates on structured records only (Architecture Spec SS 5.1).
- **Follow-up record creation** (NF-05, NF-06) -- Covered by F-09. F-12 surfaces and acts on existing follow-up records.
- **Promise extraction from conversations** (NF-08) -- Covered by F-13. F-12 surfaces promises that have already been extracted and recorded.
- **No-show tracking and post-appointment follow-up workflows** -- Future phase. F-12 covers pre-appointment confirmation only.
- **Multi-calendar booking aggregation** -- MVP supports single calendar per workspace (PRD SS 14.2).
- **Push notification dispatch for COS-generated drafts** -- Covered by F-04 (Staff Notifications). When a COS-generated draft is ready, the existing notification pipeline (NT-01, NT-03) delivers the push notification.
