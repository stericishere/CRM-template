# User Stories — F-04: Staff Notifications & Audit Foundation

**Feature:** F-04 — Staff Notifications & Audit Foundation
**Phase:** 1 (Core Messaging & Onboarding)
**Size:** M
**PRD Functions:** NT-01, NT-02, AG-06
**Architecture modules:** `agent-governance` (AuditEvent), `integrations` (push notifications)
**Last updated:** March 2026

---

## Context

F-04 establishes two foundational capabilities that every later feature depends on:

1. **Real-time staff alerting** — staff receive a push notification within 5 seconds of an inbound WhatsApp message arriving, and the inbox unread badge reflects the live unread count at all times.
2. **Audit event logging** — every state-changing mutation in the system writes an immutable AuditEvent record capturing actor type, actor ID, action type, target entity, session key, and a before/after snapshot. This is the governance baseline consumed by F-06 (Approval Workflow) and all future compliance and debugging tooling.

The staff app is a PWA (mobile-first responsive web), so push delivery depends on the browser's Notifications API and a registered service worker. Notification permission must be explicitly requested and gracefully handled when denied.

---

## Story US-F04-01: Push notification on inbound message (NT-01)

**As a** staff member,
**I want** to receive a push notification on my device within 5 seconds of a client sending a WhatsApp message,
**so that** I can respond quickly without keeping the app open or polling manually.

### Acceptance criteria

```gherkin
Feature: Push notification on inbound WhatsApp message

  Background:
    Given I am a staff member with an active workspace session
    And I have granted push notification permission in the browser
    And my device has a registered service worker with a valid VAPID subscription

  Scenario: Push notification delivered within latency target
    Given a client sends an inbound WhatsApp message at T=0
    When the message is received by the webhook and enqueued to BullMQ
    Then a push notification is dispatched to all subscribed staff devices
    And the notification arrives at the staff device within 5 seconds of T=0
    And the notification title includes the client's display name or phone number
    And the notification body shows the first 100 characters of the message text

  Scenario: Notification while app is in the background
    Given I have minimised or closed the staff app browser tab
    When a client sends an inbound message
    Then the service worker receives the push event
    And a system notification is shown on my device
    And tapping the notification deep-links me to that client's conversation thread

  Scenario: Notification while app is in the foreground
    Given I have the staff app open and focused
    When a client sends an inbound message
    Then an in-app toast notification is shown within the UI
    And a duplicate OS-level notification is suppressed

  Scenario: Multiple rapid inbound messages from the same client
    Given a client sends 3 messages within 10 seconds
    Then at most 1 push notification is dispatched per client per 10-second window
    And all 3 messages are stored and visible in the conversation thread

  Scenario: Media-only message (image or voice note)
    Given a client sends a message with media and no caption text
    When the push notification is dispatched
    Then the notification body reads "New media message" rather than empty text

  Scenario: Push delivery failure is handled gracefully
    Given a staff device has an expired or invalid push subscription
    When the system attempts to dispatch a push notification
    Then the invalid subscription is removed from the database
    And no error is surfaced to the client or the sending user
```

### Notes

- Latency target: < 5 seconds end-to-end (§16.3).
- MVP: notifications go to all workspace staff. Post-MVP routing by assignment is out of scope for this story (§10.7).
- Voice note and image bodies handled in F-08; this story only needs a sensible fallback label.
- Deduplication window (10 s) is an implementation detail; the PRD does not specify — engineering owns this decision.

---

## Story US-F04-02: Notification permission flow (PWA service worker)

**As a** staff member using the PWA for the first time,
**I want** to be guided through granting notification permission,
**so that** push alerts work correctly without me needing to know browser settings.

### Acceptance criteria

```gherkin
Feature: Notification permission onboarding flow

  Background:
    Given I am a logged-in staff member
    And my browser supports the Notifications API and service workers

  Scenario: First login — permission not yet requested
    Given I open the staff app for the first time on this device
    When the inbox loads
    Then a contextual prompt appears explaining why notifications are needed
    And I am shown an "Enable notifications" call-to-action button
    And the native browser permission dialog is NOT shown until I click the button

  Scenario: Staff grants permission
    Given the notification permission prompt is visible
    When I click "Enable notifications"
    Then the browser permission dialog is shown
    And if I click Allow, my device's push subscription is saved to the database
    And the prompt is dismissed and replaced with a success confirmation
    And I begin receiving push notifications from this point forward

  Scenario: Staff denies permission at the browser dialog
    Given I am shown the browser permission dialog
    When I click Block or Deny
    Then the app records that permission was denied for this device
    And a non-intrusive banner remains visible: "Notifications are off — enable them in browser settings"
    And all other app functionality remains fully usable

  Scenario: Staff previously denied permission returns to app
    Given I previously denied notification permission on this device
    When I open the app on a subsequent visit
    Then the permission prompt is not shown again automatically
    And a persistent but unobtrusive settings link reads "Turn on notifications"
    And clicking it opens browser settings guidance rather than the (blocked) permission dialog

  Scenario: Unsupported browser
    Given I am using a browser that does not support service workers or the Push API
    When the inbox loads
    Then no notification permission prompt is shown
    And a one-time informational message reads "Push notifications require a supported browser (Chrome, Edge, Safari 16.4+)"
    And the message can be dismissed and does not reappear

  Scenario: Service worker registration failure
    Given the service worker fails to register (e.g., served over HTTP in production)
    Then push notifications are silently disabled
    And an error is written to the server-side log with the failure reason
    And staff can still use the app without notifications
```

### Notes

- Permission must be triggered by a user gesture (button click); browsers block programmatic calls without a gesture.
- VAPID public key must be stored in environment config, not hardcoded.
- Push subscription (endpoint + keys) stored per `(workspace_id, staff_id, device_fingerprint)`.

---

## Story US-F04-03: In-app unread badge count (NT-02)

**As a** staff member looking at my inbox,
**I want** to see an accurate unread message count badge on each conversation,
**so that** I can immediately see which clients need attention without opening every thread.

### Acceptance criteria

```gherkin
Feature: In-app unread badge count

  Background:
    Given I am a logged-in staff member
    And the inbox is visible

  Scenario: New inbound message increments the badge
    Given a conversation has 0 unread messages
    When a client sends a new inbound message
    Then the unread badge on that conversation increments to 1
    And the change is reflected without requiring a page refresh
    And the conversation moves to the top of the inbox list

  Scenario: Multiple unread messages accumulate
    Given a client sends 3 messages while I am away
    When I open the inbox
    Then the badge on that conversation shows "3"

  Scenario: Opening a conversation clears its badge
    Given a conversation shows a badge of 2
    When I open the conversation thread and scroll to the latest message
    Then the badge on that conversation resets to 0
    And the inbox total unread count decreases accordingly

  Scenario: Badge persists across page reloads
    Given I have 4 unread conversations
    When I refresh the browser
    Then the inbox still shows the correct unread counts for each conversation
    And the total is loaded from the server, not a local cache

  Scenario: Badge reflects unreviewed AI drafts (future extension point)
    Given a conversation has an unreviewed AI draft but no new client messages
    Then the badge uses a visually distinct indicator (e.g., outline style vs. filled)
    And the count is tracked separately from raw unread message count

  Scenario: Zero unread state
    Given all conversations have been read
    Then no badges are visible in the inbox
    And no total count appears in the browser tab title or app icon
```

### Notes

- Unread count is server-authoritative; the client subscribes via Supabase Realtime or polling fallback.
- "Unreviewed draft" badge variant is defined here as a future extension point but not implemented in Phase 1.
- The browser tab title badge (e.g., "(3) Inbox") is in scope as a low-effort addition; engineering to confirm feasibility.

---

## Story US-F04-04: Audit event logging for all mutations (AG-06)

**As a** workspace manager,
**I want** every action taken by staff, the AI, or the system to produce an immutable audit log entry,
**so that** I can understand exactly what happened, who did it, and what changed — for compliance, debugging, and accountability.

### Acceptance criteria

```gherkin
Feature: Audit event logging for all system mutations

  Background:
    Given the audit logging service is active for the workspace
    And all mutations route through domain use-case handlers that emit AuditEvents

  Scenario: Staff sends a message
    Given a staff member sends a reply to a client
    When the message is delivered
    Then an AuditEvent is written with:
      | Field          | Value                              |
      | actor_type     | staff                              |
      | actor_id       | the staff member's user ID         |
      | action_type    | message_sent                       |
      | target_entity  | message                            |
      | target_id      | the message UUID                   |
      | metadata.session_key | the resolved session key      |
      | metadata.before | null (new record)                 |
      | metadata.after  | the outbound message payload       |

  Scenario: AI draft is generated
    Given the Client Worker produces a draft reply
    Then an AuditEvent is written with actor_type "ai" and action_type "draft_generated"
    And metadata includes the session key and the draft content hash

  Scenario: Staff updates a client profile field
    Given a staff member changes a client's lifecycle status from "open" to "chosen_service"
    Then an AuditEvent is written with action_type "client_updated"
    And metadata.before contains the prior lifecycle status
    And metadata.after contains the new lifecycle status
    And actor_type is "staff" with the correct actor_id

  Scenario: System action is attributed correctly
    Given a scheduled cron job (e.g., daily compaction) updates a memory record
    Then an AuditEvent is written with actor_type "system" and actor_id null
    And action_type reflects the system operation (e.g., the relevant action type)

  Scenario: Audit event covers all defined action types
    Then AuditEvents are emitted for each of the following action_type values:
      | draft_generated    |
      | message_sent       |
      | client_updated     |
      | booking_created    |
      | booking_cancelled  |
      | note_added         |
      | followup_created   |
      | followup_completed |
      | draft_regenerated  |
      | client_merged      |
      | knowledge_updated  |
      | sop_updated        |

  Scenario: Audit events are immutable
    Given an AuditEvent has been written
    Then no application code path can UPDATE or DELETE that record
    And any attempt to do so returns a permission-denied error at the database layer

  Scenario: Audit event write failure does not block the primary mutation
    Given the audit_events table is temporarily unavailable
    When a staff member sends a message
    Then the message is delivered successfully
    And the audit write failure is captured in an error log with the full event payload
    And a retry or dead-letter mechanism queues the event for later persistence

  Scenario: Audit log is queryable by workspace manager
    Given I am a workspace manager
    When I query the audit log filtered by client_id and a date range
    Then I see a chronologically ordered list of all events for that client
    And each entry shows actor, action, timestamp, and a summary of what changed
```

### Notes

- Schema defined in PRD §12.13: `event_id`, `workspace_id`, `actor_type`, `actor_id`, `action_type`, `target_entity`, `target_id`, `metadata` (JSON), `timestamp`.
- Immutability enforced via Supabase Row Level Security: no UPDATE or DELETE permitted on `audit_events`; INSERT only.
- All workspace queries are scoped by `workspace_id` to prevent cross-tenant leakage.
- The manager-facing audit log UI is a future surface (Phase 2+); Phase 1 delivers the data foundation and queryability via Supabase admin/API only.
- Audit write failure handling (retry/dead-letter) is engineering's implementation decision; the story defines the required behaviour.

---

## Story US-F04-05: Audit event logging on inbound message receipt (AG-06 + NT-01 integration)

**As a** workspace manager,
**I want** every inbound WhatsApp message to produce an audit event as well as a push notification,
**so that** the full message flow — from client send through to staff alert — is traceable end-to-end.

### Acceptance criteria

```gherkin
Feature: Inbound message produces both a notification and an audit event

  Background:
    Given the workspace has audit logging and push notifications active

  Scenario: Inbound message triggers notification and audit atomically
    Given a client sends an inbound WhatsApp message
    When the message pipeline processes it
    Then a push notification is dispatched to staff (see US-F04-01)
    And an AuditEvent is written with:
      | Field          | Value                        |
      | actor_type     | system                       |
      | actor_id       | null                         |
      | action_type    | message_received             |
      | target_entity  | message                      |
      | target_id      | the inbound message UUID     |
      | metadata.session_key | the resolved session key |
      | metadata.after | the normalised message payload |

  Scenario: Notification fails but audit event still written
    Given the push notification service is temporarily unavailable
    When an inbound message arrives
    Then the audit event is written successfully
    And the message is stored in the database
    And the notification failure is logged for retry

  Scenario: Audit event fails but notification still dispatched
    Given the audit_events table write fails
    When an inbound message arrives
    Then the push notification is still dispatched to staff
    And the audit failure is logged for retry (per US-F04-04 resilience behaviour)
```

### Notes

- `message_received` is not listed in the PRD's audit action type enumeration (§12.13); this story proposes it as a necessary addition. Engineering to confirm and add to the enum before implementation.
- The two operations (notification dispatch, audit write) run in parallel after message storage; neither blocks the other.

---

## Story map summary

| Story | PRD Function | Actor | Priority |
|---|---|---|---|
| US-F04-01 | NT-01 | Staff | Must-have |
| US-F04-02 | NT-01 (enablement) | Staff | Must-have |
| US-F04-03 | NT-02 | Staff | Must-have |
| US-F04-04 | AG-06 | Manager / System | Must-have |
| US-F04-05 | AG-06 + NT-01 | Manager | Must-have |

All five stories are Phase 1 must-haves. US-F04-04 is the highest-priority because F-06 (Approval Workflow, Phase 2) explicitly depends on the audit foundation being operational.

## Open questions

1. **`message_received` action type** — should it be added to the AG-06 enum, or are inbound messages captured only as context (no mutation)? Needs PM + Eng alignment before sprint start.
2. **Notification deduplication window** — 10-second client-level window proposed in US-F04-01. Needs engineering validation against BullMQ throughput characteristics.
3. **Unreviewed draft badge** — US-F04-03 defines this as a future extension point. Should it be scoped into Phase 1 or deferred to F-06?
4. **Audit log manager UI** — deferred to Phase 2+. Confirm no Phase 1 manager will need to access audit data during pilot; if yes, a read-only Supabase dashboard link may be sufficient.
