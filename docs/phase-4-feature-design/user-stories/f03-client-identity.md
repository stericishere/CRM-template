# User Stories — F-03: Client Identity & Profile

**Feature:** F-03 Client Identity & Profile
**Phase:** 1
**Size:** M
**PRD Functions:** CI-01, CI-02, MP-03
**Architecture module:** `client-relationship` (Client, ClientProfile, ClientRepository)
**ADR dependencies:** ADR-2 (all queries scoped by `workspace_id + client_id`)

---

## Context

Every inbound WhatsApp message triggers the client identity pipeline before any other work can proceed. The pipeline normalizes the sender's phone number to E.164 format (handled by F-02 / MP-02), then either resolves the number to an existing client record or creates a new one. The resulting `client_id` becomes the isolation boundary for all subsequent data access: context assembly, draft generation, bookings, notes, and follow-ups are all scoped to `workspace_id + client_id`.

Client records carry a `lifecycle_status` enum that tracks where in the service journey a client sits. Vertical-specific attributes (e.g., `chest_inches` for a bespoke tailor, `hair_type` for a salon) are stored as values in the `client.preferences` JSON column, keyed by the `customFields[].key` values declared in `workspace.vertical_config`. No schema migrations are required when a new vertical is deployed.

---

## Story US-F03-01 — Phone Number Lookup (CI-01)

**As a** message processing worker,
**I want to** look up an existing client by their normalized E.164 phone number within the correct workspace,
**so that** the right client record is returned before any AI or context work begins, without touching records from other workspaces.

### Acceptance criteria

```gherkin
Feature: Phone number lookup

  Background:
    Given workspace "WS-001" exists with an active WhatsApp connection
    And a client record exists with phone_number "+447700900001" in workspace "WS-001"
    And a separate workspace "WS-002" exists with its own client records

  Scenario: Exact E.164 match returns the correct client
    When the pipeline receives an inbound message from "+447700900001" for workspace "WS-001"
    Then the lookup returns client record with matching phone_number
    And the returned client's workspace_id equals "WS-001"
    And no new client record is created

  Scenario: Lookup is scoped to the receiving workspace
    Given workspace "WS-002" also has a client with phone_number "+447700900001"
    When the pipeline receives an inbound message from "+447700900001" for workspace "WS-001"
    Then only the client record belonging to workspace "WS-001" is returned
    And the client record from "WS-002" is never touched

  Scenario: No match found returns empty result
    When the pipeline receives an inbound message from "+447700900999" for workspace "WS-001"
    And no client in workspace "WS-001" has phone_number "+447700900999"
    Then the lookup returns no result
    And the pipeline proceeds to the new-client creation step

  Scenario: Lookup uses exact string match, not partial
    Given a client exists with phone_number "+447700900001"
    When the pipeline queries for "+44770090000" (prefix only)
    Then the lookup returns no result
```

### Notes

- Lookup is a pure database read: `SELECT * FROM clients WHERE workspace_id = $1 AND phone_number = $2 LIMIT 1`.
- Phone number must already be in E.164 format before this function is called (normalization is MP-02, owned by F-02).
- No LLM involved.

---

## Story US-F03-02 — New Client Auto-Creation (CI-02)

**As a** message processing worker,
**I want to** automatically create a new client profile when no existing record matches the inbound phone number,
**so that** first-time contacts are captured immediately and the rest of the pipeline can proceed without manual intervention.

### Acceptance criteria

```gherkin
Feature: New client auto-creation

  Background:
    Given workspace "WS-001" exists
    And no client record exists for phone_number "+447700900555" in workspace "WS-001"

  Scenario: New client record is created on first message
    When the pipeline receives an inbound message from "+447700900555" for workspace "WS-001"
    And the phone number lookup returns no result
    Then a new client record is created with:
      | field            | value             |
      | workspace_id     | "WS-001"          |
      | phone_number     | "+447700900555"   |
      | lifecycle_status | "open"            |
    And the new record has a non-null client_id (UUID)
    And created_at and updated_at are set to the current timestamp

  Scenario: Auto-created client has null optional fields
    When a new client record is created for "+447700900555"
    Then the full_name field is null
    And the email field is null
    And the preferences field is an empty JSON object
    And the summary field is null

  Scenario: Subsequent message from the same number finds the existing record
    Given a client was auto-created for "+447700900555" during a previous message
    When a second inbound message arrives from "+447700900555" for workspace "WS-001"
    Then the lookup returns the previously created client record
    And no second client record is created

  Scenario: Creation failure does not silently swallow the error
    Given the database is temporarily unavailable
    When the pipeline attempts to create a new client record
    Then the operation throws a retryable error
    And the BullMQ job is not acknowledged
    And no partial record is written
```

### Notes

- Default `lifecycle_status` on creation is always `open`.
- `full_name` remains null until set by staff or by a future intelligent note processing extraction (F-13).
- Write must be idempotent-safe: use `INSERT ... ON CONFLICT (workspace_id, phone_number) DO NOTHING RETURNING *` or equivalent to guard against parallel race conditions from duplicate queue delivery.
- No LLM involved.

---

## Story US-F03-03 — Client Find-or-Create Pipeline Integration (MP-03)

**As a** message processing worker,
**I want to** execute lookup and conditional creation as a single atomic find-or-create operation within the inbound message pipeline,
**so that** every message that reaches context assembly has a guaranteed, valid `client_id` to scope all subsequent reads and writes.

### Acceptance criteria

```gherkin
Feature: Client find-or-create pipeline integration

  Background:
    Given an inbound WhatsApp message has been dequeued from BullMQ
    And the phone number has already been normalized to E.164 by MP-02

  Scenario: Known client — find path is taken
    Given a client exists for the normalized phone number in the workspace
    When the find-or-create operation runs
    Then the existing client record is returned
    And no INSERT is executed
    And the returned client_id is passed to the session key resolver (CS-01)

  Scenario: Unknown client — create path is taken
    Given no client exists for the normalized phone number in the workspace
    When the find-or-create operation runs
    Then a new client record is created (as per US-F03-02)
    And the new client_id is passed to the session key resolver (CS-01)

  Scenario: Session key is correctly composed after find-or-create
    When the find-or-create operation returns client_id "abc-123" for workspace "WS-001"
    Then the resolved session key is "workspace:WS-001:client:abc-123"

  Scenario: Concurrent messages from the same new number do not create duplicates
    Given two messages arrive from "+447700900777" at the same time
    And no client record exists for that number
    When both pipeline workers execute find-or-create simultaneously
    Then exactly one client record exists for "+447700900777" afterwards
    And both workers receive the same client_id

  Scenario: find-or-create operation is a prerequisite gate
    When the find-or-create operation fails (throws)
    Then the pipeline worker does not proceed to context assembly
    And the BullMQ job is returned to the queue for retry
```

### Notes

- The find-or-create is a single database round-trip: `INSERT INTO clients (...) ON CONFLICT (workspace_id, phone_number) DO UPDATE SET updated_at = now() RETURNING *` — or a read-first approach with an upsert fallback.
- The `client_id` produced here is the scoping key for every downstream operation in this pipeline run (CS-01 session key, context assembly, draft generation, audit events).
- This function has no LLM dependency and must complete in under 50 ms (pure DB read/write path).

---

## Story US-F03-04 — Lifecycle Status Management

**As a** staff member,
**I want** client lifecycle statuses to advance through a defined set of stages,
**so that** I can see at a glance where each client sits in the service journey and the AI can use status as context when assembling drafts.

### Acceptance criteria

```gherkin
Feature: Client lifecycle status management

  Background:
    Given a client record exists with lifecycle_status "open"

  Scenario: Valid lifecycle status values
    Then the lifecycle_status field accepts exactly these values:
      | status                |
      | open                  |
      | chosen_service        |
      | upcoming_appointment  |
      | follow_up             |
      | review_complete       |
      | inactive              |
    And any other value is rejected at the database constraint level

  Scenario: New client starts at "open"
    When a new client is auto-created via CI-02
    Then lifecycle_status is "open"

  Scenario: Status update is treated as a suggest-for-review action
    When an AI tool proposes changing lifecycle_status to "chosen_service"
    Then a ProposedAction is created (not a direct write)
    And a confirmation card is presented to staff
    And the status is updated only after staff approves

  Scenario: Staff can update status directly from the client profile
    Given a staff member is viewing the client profile in the staff app
    When they change lifecycle_status to "upcoming_appointment"
    Then the update is saved immediately without requiring AI approval
    And an audit event is written with actor = staff, action = "lifecycle_status_updated", before and after values

  Scenario: Client becomes "inactive" after configurable period of no interaction
    Given a client's last_contacted_at is more than 30 days ago (workspace default)
    And the client's lifecycle_status is not "inactive"
    When the inactivity check runs
    Then lifecycle_status is updated to "inactive"
    And an audit event is written

  Scenario: "inactive" client reverts to "open" on new inbound message
    Given a client has lifecycle_status "inactive"
    When a new inbound message arrives from that client
    Then lifecycle_status is updated to "open"
    And last_contacted_at is updated to now
    And an audit event is written
```

### Notes

- Status transitions are not enforced as a strict state machine at the DB layer in Phase 1; any status can be set from any status. A transition graph may be introduced in a later phase.
- The inactivity threshold (default 30 days) is workspace-configurable. The check should run as part of a lightweight scheduled job or on message receipt, not inside the hot path of the message pipeline.
- Lifecycle status is surfaced in the client thread sidebar and client profile view in the staff app.

---

## Story US-F03-05 — Vertical Custom Field Storage in Preferences

**As a** staff member working in a specific vertical (e.g., bespoke tailor, salon),
**I want** vertical-specific client attributes (such as measurements or hair type) to be stored against the client record,
**so that** the AI can include them in context assembly and staff can view and edit them in the client profile without the platform requiring code changes per vertical.

### Acceptance criteria

```gherkin
Feature: Vertical custom field storage

  Background:
    Given workspace "WS-001" has vertical_type "bespoke_tailor"
    And vertical_config contains customFields:
      | key           | label         | type   | required |
      | chest_inches  | Chest (in)    | number | false    |
      | suit_style    | Suit Style    | enum   | false    |
      | notes_fitting | Fitting notes | string | false    |
    And a client record exists for that workspace with preferences = {}

  Scenario: Custom field value is written to preferences JSON
    When staff sets "chest_inches" to 42 for the client
    Then client.preferences contains { "chest_inches": 42 }
    And no new column or table is created

  Scenario: Multiple custom field values coexist in preferences
    When staff sets "chest_inches" to 42 and "suit_style" to "single_breasted"
    Then client.preferences contains:
      { "chest_inches": 42, "suit_style": "single_breasted" }

  Scenario: Custom field update does not overwrite unrelated preference keys
    Given client.preferences already contains { "chest_inches": 40, "preferred_name": "James" }
    When staff updates only "chest_inches" to 42
    Then client.preferences becomes { "chest_inches": 42, "preferred_name": "James" }
    And "preferred_name" is not removed

  Scenario: Custom fields render dynamically in the client profile UI
    When a staff member opens the client profile
    Then the UI renders one input field per entry in vertical_config.customFields
    And each field shows its configured label (not the key)
    And current values are pre-filled from client.preferences

  Scenario: Different verticals store different keys without conflict
    Given workspace "WS-002" has vertical_type "salon" with customField key "hair_type"
    And workspace "WS-001" has vertical_type "bespoke_tailor" with customField key "chest_inches"
    When each workspace writes its own custom field values
    Then the preferences JSON for WS-001 clients contains "chest_inches" (not "hair_type")
    And the preferences JSON for WS-002 clients contains "hair_type" (not "chest_inches")
    And neither workspace's data appears in the other's client records

  Scenario: Custom field values are included in context assembly
    Given client.preferences contains { "chest_inches": 42, "suit_style": "single_breasted" }
    When context assembly runs for that client (F-05)
    Then the client-scoped section of the context window includes these key-value pairs
    And they are available to the Client Worker LLM call
```

### Notes

- `client.preferences` is a single JSON column that stores both vertical custom field values and any other client-level preferences (e.g., preferred name). Keys from `vertical_config.customFields[].key` are the canonical identifiers.
- No schema migrations are needed when a new vertical is deployed or when a business owner modifies their custom fields via the SOP editor (F-01 / ON-05).
- Type validation for custom field values (number, enum, date, boolean) is enforced at the application layer before writing, using the `type` and `enumValues` metadata from `vertical_config`.
- Custom field values written to `preferences` are persisted on every update using a JSON merge patch (`jsonb_set` or equivalent), not a full column overwrite.
```

---

## Story map summary

| Story | PRD functions | Phase | Size estimate |
|-------|--------------|-------|---------------|
| US-F03-01 Phone number lookup | CI-01 | 1 | XS — single DB query |
| US-F03-02 New client auto-creation | CI-02 | 1 | XS — single DB insert |
| US-F03-03 Find-or-create pipeline integration | MP-03 | 1 | S — combines CI-01 + CI-02 with concurrency guard |
| US-F03-04 Lifecycle status management | (CI-01, CI-02 data model) | 1 | S — DB enum + audit event + inactivity check |
| US-F03-05 Vertical custom field storage | (MP-03 data model) | 1 | S — JSON merge write + UI rendering |

**Total feature size: M** (as per feature-list.md — these are all fast, non-LLM database operations, but the find-or-create concurrency guard, inactivity job, and UI rendering for custom fields add meaningful surface area.)

---

## Out of scope for F-03

- **Client merge** (CI-03, CI-04) — Phase 2, covered by F-09.
- **Conversational context updates** (e.g., "update her preferred name to Liz") — Phase 3, covered by F-13.
- **Intelligent note processing** that extracts custom field values from free text — Phase 3, covered by F-13.
- **Context assembly** that consumes the client record — Phase 2, covered by F-05.
