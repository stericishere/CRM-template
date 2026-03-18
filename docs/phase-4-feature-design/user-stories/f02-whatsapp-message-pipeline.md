# User Stories — F-02: WhatsApp Message Pipeline

**Feature:** F-02 WhatsApp Message Pipeline
**Phase:** 1 (Core Messaging & Onboarding)
**Size:** L
**PRD Functions:** MP-01, MP-02, MP-06, MP-07, MP-08, MP-09, CS-01
**Architecture Module:** conversation (ProcessInboundMessage, BullMQMessageQueue), integrations/whatsapp
**ADR Dependency:** ADR-2 (database-backed sessions — session key resolves to DB queries, not files)

---

## Context

This feature is the foundational prerequisite for the entire system. It establishes the message ingestion pipeline from WhatsApp Web (QR code paired session) through BullMQ into persistent storage. The integration uses the WhatsApp Web protocol (Baileys/whatsapp-web.js), not the Meta Cloud API. There is no 24-hour messaging window restriction and no template requirement. Session health replaces any "window check" concept.

**Integration model:** Owner scans a QR code to pair their existing WhatsApp account. The system receives messages via WhatsApp Web protocol events, not webhooks from Meta.

**Key architectural constraints:**
- BullMQ uses the session key (`workspace:{id}:client:{id}`) as the queue group key, ensuring per-client sequential processing.
- Conversation records carry a `version` field for optimistic locking.
- All database queries are scoped by `workspace_id` and `client_id`.
- Imported history messages flow through the same pipeline but skip AI drafting.

---

## Stories

### F02-S01: Inbound Message Receipt and Queue Enqueue

**Function:** MP-01

> **As a** staff member,
> **I want** every inbound WhatsApp message to be reliably received and enqueued for processing,
> **so that** no client message is lost even under load or temporary failures.

**Acceptance Criteria:**

```gherkin
Feature: Inbound message receipt and queue enqueue

  Scenario: Text message received from WhatsApp Web session
    Given the WhatsApp Web session for workspace "ws-abc" is connected
    When a client sends a text message to the paired WhatsApp number
    Then the message listener captures the WhatsApp Web protocol event
    And the message is enqueued to BullMQ with the raw payload
    And the BullMQ job includes the workspace identifier "ws-abc"
    And the job is created with retry policy (exponential backoff, max 3 attempts)

  Scenario: Duplicate message is rejected
    Given a message with WhatsApp message ID "wamid-123" has already been enqueued
    When the message listener receives another event with WhatsApp message ID "wamid-123"
    Then the duplicate is discarded
    And no new BullMQ job is created
    And a deduplication log entry is recorded

  Scenario: Messages from the same client are processed sequentially
    Given client "C-001" has session key "workspace:ws-abc:client:C-001"
    When two messages arrive from client "C-001" in rapid succession
    Then BullMQ processes them sequentially using the session key as the queue group key
    And the second message is not dequeued until the first completes processing

  Scenario: Message received while worker is temporarily down
    Given the BullMQ worker process is restarting
    When a client sends a message
    Then the message is durably persisted in the Redis-backed queue
    And the message is processed once the worker recovers
```

**Notes:**
- Deduplication key is the WhatsApp-native message ID, checked before enqueue.
- BullMQ queue group key = session key ensures per-client ordering without global serialization.

---

### F02-S02: Phone Number Normalization to E.164

**Function:** MP-02

> **As a** system operator,
> **I want** every inbound phone number normalized to E.164 format before any lookup or storage,
> **so that** client identity matching is deterministic regardless of how the sender's number is formatted.

**Acceptance Criteria:**

```gherkin
Feature: Phone number normalization to E.164

  Scenario: Local format number is normalized
    Given an inbound message from phone number "0412345678" with country context "AU"
    When the worker processes the message
    Then the phone number is normalized to "+61412345678"
    And the normalized number is used for all subsequent client lookups

  Scenario: Number already in E.164 format
    Given an inbound message from phone number "+14155551234"
    When the worker processes the message
    Then the phone number remains "+14155551234"
    And no normalization error is raised

  Scenario: Number with formatting characters
    Given an inbound message from phone number "+44 (20) 7946-0958"
    When the worker processes the message
    Then the phone number is normalized to "+442079460958"

  Scenario: Invalid phone number
    Given an inbound message from phone number "not-a-number"
    When the worker attempts normalization
    Then the message is flagged with a normalization failure
    And the message is moved to a dead-letter queue for manual review
    And an error event is logged with the raw phone string
```

**Notes:**
- Country context is derived from the workspace timezone/locale configuration.
- Use a standards-compliant phone parsing library (e.g., libphonenumber).
- The normalized E.164 number is the sole key for client record matching (PRD 10.3).

---

### F02-S03: Session Key Resolution

**Function:** CS-01

> **As a** system,
> **I want** every inbound message resolved to a deterministic session key of the form `workspace:{workspace_id}:client:{client_id}`,
> **so that** all downstream processing (context assembly, queue ordering, data scoping) operates on a consistent isolation boundary.

**Acceptance Criteria:**

```gherkin
Feature: Session key resolution

  Scenario: Existing client matched by phone number
    Given workspace "ws-abc" exists
    And a client record with phone "+14155551234" and client_id "C-001" exists in workspace "ws-abc"
    When an inbound message arrives from "+14155551234"
    Then the session key is resolved to "workspace:ws-abc:client:C-001"
    And the session key is attached to the BullMQ job metadata

  Scenario: New client auto-created
    Given workspace "ws-abc" exists
    And no client record exists for phone "+61400111222" in workspace "ws-abc"
    When an inbound message arrives from "+61400111222"
    Then a new client record is created with the normalized phone number
    And the client lifecycle status is set to "open"
    And the session key is resolved to "workspace:ws-abc:client:{new_client_id}"
    And a new Conversation record is created with channel "whatsapp" and state "idle"

  Scenario: Session key scopes all downstream queries
    Given session key "workspace:ws-abc:client:C-001" is resolved
    When context assembly or any database query executes downstream
    Then every query includes WHERE clauses for workspace_id = "ws-abc" AND client_id = "C-001"
```

**Notes:**
- Phone number lookup must happen after E.164 normalization (F02-S02).
- Client creation is an auto-allowed action; no staff approval required.
- Per ADR-2, session key parameterizes database queries, not filesystem paths.

---

### F02-S04: Message Storage and Client Association

**Function:** MP-09

> **As a** staff member,
> **I want** every inbound and outbound message stored and associated with the correct client record,
> **so that** I can view the full conversation history for any client and the AI has accurate context for drafting.

**Acceptance Criteria:**

```gherkin
Feature: Message storage and client association

  Scenario: Inbound text message stored
    Given session key "workspace:ws-abc:client:C-001" is resolved
    And conversation "conv-001" exists for client "C-001"
    When the worker stores the inbound message
    Then a Message record is created with:
      | field             | value         |
      | conversation_id   | conv-001      |
      | direction         | inbound       |
      | content           | <message text>|
      | sender_type       | client        |
      | timestamp         | <WhatsApp timestamp> |
      | delivery_status   | delivered     |
    And the Conversation.last_message_at is updated
    And the Conversation.last_client_message_at is updated
    And the Client.last_contacted_at is updated

  Scenario: Outbound message stored after staff sends
    Given staff sends an approved draft to client "C-001"
    When the outbound message is dispatched via WhatsApp Web session
    Then a Message record is created with direction "outbound" and sender_type "staff"
    And the draft_id field links to the originating Draft record
    And the delivery_status is initially set to "sent"

  Scenario: Message with media attachment stored
    Given an inbound message includes an image attachment
    When the worker stores the message
    Then the media_type is set to "image"
    And the media is uploaded to storage and media_url is populated
    And the text content (caption, if any) is stored in the content field

  Scenario: Messages displayed chronologically
    Given client "C-001" has 15 stored messages
    When staff opens the client conversation
    Then messages are displayed in ascending timestamp order
    And both inbound and outbound messages appear in the timeline
```

**Notes:**
- The Message table schema follows PRD 12.5 exactly.
- Conversation.version is incremented on writes (optimistic locking per architecture 3.5).
- Media storage is a reference (URL); actual files stored in Supabase Storage or equivalent.

---

### F02-S05: WhatsApp Session Health Monitoring and Re-authentication

**Function:** MP-06

> **As a** staff member,
> **I want** the system to continuously monitor the WhatsApp Web session health and immediately alert me if the session disconnects,
> **so that** I can re-scan the QR code before clients notice any interruption in service.

**Acceptance Criteria:**

```gherkin
Feature: WhatsApp session health monitoring and re-authentication

  Scenario: Healthy session confirmed
    Given the WhatsApp Web session for workspace "ws-abc" is connected
    When the system performs a periodic health check
    Then the session status remains "connected" in whatsapp_config
    And no notification is sent to staff

  Scenario: Session disconnection detected
    Given the WhatsApp Web session for workspace "ws-abc" disconnects
    When the system detects the disconnection event
    Then the session status is updated to "disconnected" in whatsapp_config
    And a push notification is sent to the workspace owner with message "WhatsApp disconnected. Tap to re-scan QR code."
    And an in-app banner is displayed in the staff app indicating session loss
    And a timestamp is recorded for the disconnection event

  Scenario: Outbound message blocked during disconnection
    Given the WhatsApp Web session status is "disconnected"
    When staff attempts to send an approved draft
    Then the send is blocked with status "blocked" and reason "whatsapp_session_disconnected"
    And the staff is shown a prompt to re-scan the QR code
    And the draft remains in "approved" state for retry after reconnection

  Scenario: Session re-established via QR re-scan
    Given the session status is "disconnected"
    When the owner scans a new QR code in the staff app
    Then the session status is updated to "connected"
    And the last QR scan timestamp is updated in whatsapp_config
    And session credentials are stored for future auto-reconnection
    And any queued outbound messages are retried

  Scenario: Auto-reconnection via stored credentials
    Given the WhatsApp Web session drops due to a transient network issue
    When the system attempts auto-reconnection using stored auth keys
    And the stored credentials are still valid
    Then the session is re-established without QR re-scan
    And the session status returns to "connected"
    And no staff notification is sent for transient reconnections under 30 seconds
```

**Notes:**
- Session persistence uses stored auth keys (per architecture 11.1).
- QR re-scan is only needed when credentials are expired or revoked (e.g., user logged out from phone).
- The `sendMessage` function must check session status before attempting delivery (architecture 11.1 code sample).
- The whatsapp_config JSON on the Workspace record tracks: connection_status, last_qr_scan, stored credentials.

---

### F02-S06: Delivery Status Tracking

**Function:** MP-08

> **As a** staff member,
> **I want** to see real-time delivery status for every outbound message (sent, delivered, read, failed),
> **so that** I know whether the client actually received and read my response.

**Acceptance Criteria:**

```gherkin
Feature: Delivery status tracking

  Scenario: Message sent successfully
    Given staff sends an outbound message to client "C-001"
    When the WhatsApp Web session confirms the message was sent
    Then the Message.delivery_status is set to "sent"
    And the status is reflected in the staff app conversation view

  Scenario: Message delivered to client device
    Given an outbound message has delivery_status "sent"
    When the WhatsApp Web protocol fires a delivery receipt event
    Then the Message.delivery_status is updated to "delivered"
    And the UI displays a double-check indicator

  Scenario: Message read by client
    Given an outbound message has delivery_status "delivered"
    When the WhatsApp Web protocol fires a read receipt event
    Then the Message.delivery_status is updated to "read"
    And the UI displays a blue double-check indicator

  Scenario: Message delivery fails
    Given staff sends an outbound message
    When the WhatsApp Web protocol reports a delivery failure
    Then the Message.delivery_status is set to "failed"
    And the staff is notified of the failure with the error reason
    And the message is eligible for manual retry

  Scenario: Status updates arrive out of order
    Given an outbound message exists with delivery_status "sent"
    When a "read" receipt arrives before a "delivered" receipt
    Then the delivery_status is updated to "read" (the highest status)
    And the intermediate "delivered" status is not required as a prerequisite
```

**Notes:**
- Delivery status values follow a progression: sent -> delivered -> read. A "failed" status is terminal.
- Status updates are received as WhatsApp Web protocol events, not webhook callbacks.
- The status enum matches PRD 12.5: `sent`, `delivered`, `read`, `failed`.

---

### F02-S07: Conversation History Import

**Function:** MP-07

> **As a** business owner connecting WhatsApp for the first time,
> **I want** my existing WhatsApp conversation history imported into the system,
> **so that** the AI has context from previous client interactions and I do not start from zero.

**Acceptance Criteria:**

```gherkin
Feature: Conversation history import on first connection

  Scenario: History imported after first QR code scan
    Given the owner has just completed QR code pairing for workspace "ws-abc"
    And this is the first connection for this workspace
    When the system detects the newly paired session
    Then an import job is enqueued to process existing WhatsApp conversations
    And the workspace displays an "Importing history..." status indicator

  Scenario: Imported messages processed through the standard pipeline
    Given a history import job is running for workspace "ws-abc"
    When the system processes each historical message
    Then the phone number is normalized to E.164 (F02-S02)
    And a client record is matched or created (F02-S03)
    And the message is stored in the Message table with correct timestamp and direction
    And the conversation record is created or updated

  Scenario: Imported messages do not trigger AI drafting
    Given historical messages are being imported
    When a historical inbound message is stored
    Then no AI draft generation is triggered
    And no staff notification is sent for historical messages
    And the message is marked as imported (not a live inbound)

  Scenario: Import handles large conversation volumes
    Given the owner's WhatsApp has 500 conversations with 50,000 total messages
    When the history import runs
    Then messages are processed in batches to avoid memory exhaustion
    And the import job reports progress (conversations processed / total)
    And live inbound messages arriving during import take priority in the queue

  Scenario: Import completes and system transitions to live mode
    Given the history import job has processed all available conversations
    When the import completes
    Then the workspace import status is marked as "complete"
    And the staff is notified that history import is finished
    And all subsequently received messages are treated as live (AI drafting enabled)

  Scenario: Duplicate prevention during import
    Given a message with WhatsApp message ID "wamid-hist-456" was already imported
    When the import job encounters the same message ID again
    Then the duplicate is skipped
    And the import continues with the next message
```

**Notes:**
- History import is a one-time operation triggered by the first QR code connection (architecture 11.1).
- Messages flow through the same pipeline as live messages (normalization, client lookup, storage) but bypass AI invocation.
- Import must not block or delay processing of new live inbound messages.
- Batch size and concurrency should be tunable to respect WhatsApp Web protocol rate limits.

---

### F02-S08: Message Deduplication and Ordering via BullMQ

**Function:** Cross-cutting (MP-01, CS-01, architecture 2.2 and 3.5)

> **As a** system operator,
> **I want** the message pipeline to guarantee exactly-once processing and correct per-client ordering,
> **so that** conversations are never corrupted by duplicate processing or out-of-order state mutations.

**Acceptance Criteria:**

```gherkin
Feature: Message deduplication and ordering via BullMQ

  Scenario: Duplicate WhatsApp message ID rejected at enqueue
    Given message with WhatsApp ID "wamid-789" is already in the queue or was already processed
    When the message listener receives another event with WhatsApp ID "wamid-789"
    Then no new job is created in BullMQ
    And a deduplication counter metric is incremented

  Scenario: Per-client sequential processing maintained
    Given client "C-001" with session key "workspace:ws-abc:client:C-001"
    And messages M1 (timestamp T1) and M2 (timestamp T2, T2 > T1) are both enqueued
    When the worker processes the queue
    Then M1 is fully processed before M2 begins processing
    And the Conversation.version after M1 is used as the base for M2

  Scenario: Different clients processed concurrently
    Given client "C-001" and client "C-002" each have one pending message
    When workers are available
    Then both messages may be processed concurrently by different workers
    And there is no cross-client ordering dependency

  Scenario: Optimistic lock conflict triggers retry
    Given client "C-001" message M1 is being processed
    And an external process updates the Conversation.version for "C-001"
    When M1's worker attempts to write with the stale version
    Then the write fails due to optimistic lock violation
    And the worker retries with fresh context and the current version

  Scenario: Failed job retried with backoff
    Given a BullMQ job fails due to a transient error (e.g., database timeout)
    When the retry policy activates
    Then the job is retried with exponential backoff
    And the maximum retry count is 3
    And after 3 failures the job is moved to the dead-letter queue
    And an alert is raised for dead-letter queue entries
```

**Notes:**
- Deduplication is two-layered: (1) at enqueue time using WhatsApp message ID, (2) at storage time using a unique constraint on the message table.
- BullMQ queue group key = session key ensures per-client ordering without global serialization (architecture 3.5).
- Optimistic locking on Conversation.version prevents concurrent mutation of the same conversation state.
- Dead-letter queue entries require manual investigation by staff or operator.

---

## Story Map

| Story | PRD Function | Priority | Dependencies |
|-------|-------------|----------|--------------|
| F02-S01: Inbound Message Receipt | MP-01 | Must-have | WhatsApp Web session (F-01 QR pairing) |
| F02-S02: Phone Number Normalization | MP-02 | Must-have | None |
| F02-S03: Session Key Resolution | CS-01 | Must-have | F02-S02 |
| F02-S04: Message Storage | MP-09 | Must-have | F02-S03 |
| F02-S05: Session Health Monitoring | MP-06 | Must-have | WhatsApp Web session (F-01 QR pairing) |
| F02-S06: Delivery Status Tracking | MP-08 | Must-have | F02-S04 |
| F02-S07: History Import | MP-07 | Must-have | F02-S01, F02-S02, F02-S03, F02-S04 |
| F02-S08: Deduplication and Ordering | MP-01, CS-01 | Must-have | F02-S01 |

## Suggested Build Order

```
F02-S02 (Phone Normalization)     ── no dependencies, pure utility
    |
    v
F02-S03 (Session Key Resolution)  ── needs normalization
    |
    v
F02-S01 (Inbound Receipt + Queue) ── needs session key for queue group
    |
    v
F02-S08 (Dedup + Ordering)        ── hardens the queue layer
    |
    v
F02-S04 (Message Storage)         ── writes to DB, needs resolved session
    |
    v
F02-S05 (Session Health)          ── can be built in parallel with S04
    |
    v
F02-S06 (Delivery Status)         ── extends stored messages with status updates
    |
    v
F02-S07 (History Import)          ── uses the full pipeline, built last
```

## Definition of Done (Feature Level)

- [ ] All 8 stories pass acceptance criteria in integration tests.
- [ ] Messages from WhatsApp Web events flow through BullMQ to database storage end-to-end.
- [ ] Phone numbers are consistently E.164 across all stored records.
- [ ] Session key resolution produces correct `workspace:{id}:client:{id}` keys.
- [ ] Per-client ordering is verified under concurrent message load.
- [ ] Deduplication prevents double-processing at both enqueue and storage layers.
- [ ] WhatsApp session disconnection triggers staff notification within 60 seconds.
- [ ] QR re-scan restores session and resumes message delivery.
- [ ] History import completes without blocking live message processing.
- [ ] Delivery status updates (sent/delivered/read/failed) reflect in the staff app within 5 seconds of protocol event.
- [ ] All operations are scoped by workspace_id; no cross-workspace data leakage.
