# User Stories — F-09: Notes, Follow-ups & Knowledge Management

**Feature:** F-09 Notes, Follow-ups & Knowledge Management
**Phase:** 2
**Size:** L
**PRD Functions:** NF-01, NF-05, NF-06, ON-08, CI-03, CI-04
**Architecture modules:** `follow-up-management` (ProposeFollowUp), `workspace-knowledge` (IndexKnowledge), `client-relationship` (client merge)
**ADR dependencies:** ADR-2 (all records scoped by `workspace_id + client_id`)

---

## Context

This feature covers the non-AI, staff-driven data operations that keep client context rich and actionable: saving notes instantly, creating and managing follow-ups, uploading business documents for knowledge search, and merging duplicate client records.

Notes and follow-ups are first-class records that survive memory compaction (F-11) and appear in context assembly (F-05). Notes are immediate-write — no AI latency is acceptable on the save path. Follow-ups carry optional due dates and a status lifecycle that the COS daily operations engine (F-12) will later use to surface overdue items.

A critical use case is **lead nurturing**: when a client shows interest or buying signals, staff creates a follow-up that captures what the client was interested in, sets a due date, and tracks the lead's warmth. This turns informal interest detection into a structured pipeline that prevents warm leads from going cold.

Document uploads extend the workspace knowledge base beyond the Instagram-scraped content from onboarding (F-01). Uploaded files are chunked and embedded via pgvector so the AI can cite them in draft replies (F-05). The knowledge base is also editable directly in the Settings page.

Client merge is a staff-initiated operation that consolidates duplicate records — all notes, follow-ups, bookings, messages, and conversation history transfer to the target client, and the source record is soft-deleted. A merge history note preserves the audit trail.

### Data model references

**Note** (PRD §12.8): `note_id`, `client_id`, `content`, `source` (enum: `staff_manual`, `ai_extracted`, `conversation_update`, `merge_history`), `created_by`, `created_at`.

**Follow-up / Promise** (PRD §12.9): `followup_id`, `client_id`, `type` (enum: `follow_up`, `promise`, `reminder`), `content`, `due_date` (nullable), `status` (enum: `open`, `completed`, `pending`, `overdue`), `created_by`, `created_at`.

**Knowledge chunk** (PRD §12.11): `chunk_id`, `workspace_id`, `content`, `source` (enum: `instagram_scrape`, `manual_upload`, `settings_editor`), `source_ref`, `embedding` (vector(1536)), `created_at`, `updated_at`.

---

## Story US-F09-01 — Immediate Note Save (NF-01)

**As a** staff member viewing a client thread,
**I want to** save a free-text note against a client record with sub-second latency,
**so that** I can capture important observations in the moment without waiting for AI processing or losing my train of thought.

### Acceptance criteria

```gherkin
Feature: Immediate note save

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And a client record exists with client_id "client-abc" in workspace "WS-001"
    And staff is viewing the client thread for "client-abc"

  Scenario: Note is saved immediately on submit
    When staff enters note text "Client prefers appointments after 5pm on weekdays"
    And staff taps the save button
    Then a Note record is created with:
      | field      | value                                              |
      | client_id  | "client-abc"                                       |
      | content    | "Client prefers appointments after 5pm on weekdays"|
      | source     | "staff_manual"                                     |
      | created_by | "staff-001"                                        |
    And created_at is set to the current timestamp
    And the save completes in under 1 second (end-to-end from tap to confirmation)
    And no LLM call is made during the save path

  Scenario: Note appears in client thread immediately after save
    When staff saves a note "Allergic to latex gloves"
    Then the note appears in the client thread's notes section without a page refresh
    And the note displays the content, staff name, and timestamp

  Scenario: Empty note is rejected
    When staff attempts to save a note with empty or whitespace-only content
    Then the save is blocked with a validation message
    And no Note record is created

  Scenario: Note save writes an audit event
    When staff saves a note
    Then an audit event is logged with actor = "staff-001", action = "note_created"
    And the audit event references the new note_id and client_id

  Scenario: Note is scoped to the correct workspace and client
    When staff saves a note in workspace "WS-001" for client "client-abc"
    Then the Note record has workspace_id = "WS-001" (via client_id FK)
    And the note is not visible when querying notes for other clients or workspaces
```

### Notes

- The save path is a pure database INSERT — no AI processing, no queue, no async dependency. This is the critical latency constraint: < 1 second per PRD §16.3.
- Async note categorization (NF-02, NF-03, NF-04) is handled by F-13 in Phase 3. The immediate save in F-09 writes the raw note only.
- Notes are included in context assembly (F-05) as `recentNotes` — the last N notes appear in the client context window for AI draft generation.

---

## Story US-F09-02 — Follow-up Creation with Optional Due Date (NF-05)

**As a** staff member,
**I want to** create a follow-up record for a client with a description and an optional due date,
**so that** I have a structured reminder of what needs to happen next and when, preventing tasks from falling through the cracks.

### Acceptance criteria

```gherkin
Feature: Follow-up creation

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And a client record exists with client_id "client-abc" in workspace "WS-001"

  Scenario: Create a follow-up with a due date
    When staff creates a follow-up with:
      | field    | value                                    |
      | content  | "Send revised quote for wedding package" |
      | type     | "follow_up"                              |
      | due_date | "2026-03-25"                             |
    Then a FollowUp record is created with:
      | field      | value                                    |
      | client_id  | "client-abc"                             |
      | content    | "Send revised quote for wedding package" |
      | type       | "follow_up"                              |
      | due_date   | "2026-03-25"                             |
      | status     | "open"                                   |
      | created_by | "staff-001"                              |
    And the follow-up appears in the client thread's follow-ups section

  Scenario: Create a follow-up without a due date
    When staff creates a follow-up with content "Check if she decided on the fabric" and no due date
    Then a FollowUp record is created with due_date = null
    And status is "open"
    And the follow-up is still visible in the client's active follow-ups list

  Scenario: Follow-up type can be set to promise or reminder
    When staff creates a follow-up with type "promise" and content "We promised 10% discount on next visit"
    Then the FollowUp record has type = "promise"
    And when staff creates a follow-up with type "reminder"
    Then the FollowUp record has type = "reminder"

  Scenario: Follow-up content is required
    When staff attempts to create a follow-up with empty content
    Then the creation is rejected with a validation error
    And no FollowUp record is written

  Scenario: Follow-up is included in context assembly
    Given a follow-up exists for client "client-abc" with status "open"
    When context assembly runs for "client-abc" (F-05)
    Then the follow-up appears in the activeFollowUps section of the context window
    And the AI can reference it when generating draft replies

  Scenario: Follow-up creation writes an audit event
    When staff creates a follow-up
    Then an audit event is logged with actor = "staff-001", action = "followup_created"
    And the event references the new followup_id and client_id
```

### Notes

- Default status on creation is always `open`. The COS engine (F-12) will later transition follow-ups to `overdue` when `due_date` passes without completion.
- Follow-up creation from the staff app is a direct write — no AI involvement, no approval card needed. This contrasts with AI-proposed follow-ups (via the `create_followup` tool in F-05/F-06), which go through the `propose_write` approval flow.
- The `type` field distinguishes follow-ups (staff-initiated tasks), promises (commitments made to the client), and reminders (time-triggered nudges).

---

## Story US-F09-03 — Follow-up Status Management (NF-06)

**As a** staff member,
**I want to** update the status of a follow-up to reflect its current state (open, completed, pending, overdue),
**so that** I have an accurate picture of outstanding work per client and the COS engine can correctly identify items needing attention.

### Acceptance criteria

```gherkin
Feature: Follow-up status management

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And a follow-up exists with followup_id "fu-001" for client "client-abc"
    And the follow-up has status "open"

  Scenario: Staff marks a follow-up as completed
    When staff changes the status of "fu-001" to "completed"
    Then the FollowUp record's status is updated to "completed"
    And the follow-up no longer appears in the active follow-ups list
    And an audit event is logged with action = "followup_status_updated", before = "open", after = "completed"

  Scenario: Staff marks a follow-up as pending
    When staff changes the status of "fu-001" to "pending"
    Then the FollowUp record's status is updated to "pending"
    And the follow-up remains in the active follow-ups list with a "pending" indicator

  Scenario: Valid status values are enforced
    Then the status field accepts exactly these values:
      | status    |
      | open      |
      | completed |
      | pending   |
      | overdue   |
    And any other value is rejected at the database constraint level

  Scenario: Overdue status is set automatically by the system
    Given a follow-up has due_date = "2026-03-15" and status = "open"
    And today's date is "2026-03-18"
    When the daily follow-up check runs
    Then the follow-up's status is updated to "overdue"
    And the follow-up is surfaced in the overdue items list

  Scenario: Completing an overdue follow-up is allowed
    Given a follow-up has status "overdue"
    When staff changes the status to "completed"
    Then the status is updated to "completed"
    And the follow-up is removed from the overdue list

  Scenario: Completed follow-ups are excluded from active context
    Given a follow-up has status "completed"
    When context assembly runs for the client
    Then the completed follow-up is NOT included in activeFollowUps
    And it remains queryable in the full follow-up history

  Scenario: Status update on a non-existent follow-up returns an error
    When staff attempts to update status on followup_id "fu-nonexistent"
    Then the operation returns a not-found error
    And no database write occurs
```

### Notes

- The automatic `open` to `overdue` transition is driven by a lightweight check that compares `due_date` against the current date. In Phase 3, the COS daily cron (F-12) will run this check and generate follow-up drafts for overdue items. In Phase 2, the check can run as a simple scheduled job or be evaluated at query time.
- Staff can manually set any valid status. There is no strict state machine enforcing transition order — any status can move to any other status.
- Follow-ups with status `open`, `pending`, or `overdue` are considered "active" and appear in context assembly and the Today's View.

---

## Story US-F09-04 — Lead Nurturing Follow-ups

**As a** staff member who has detected client interest or buying signals,
**I want to** create a follow-up that captures what the client was interested in, tags it as a lead nurturing action, and tracks the lead's warmth over time,
**so that** potential leads do not go cold and I am reminded to deepen the relationship and guide them toward a service or appointment.

### Acceptance criteria

```gherkin
Feature: Lead nurturing follow-ups

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And a client "client-xyz" exists with lifecycle_status "open"

  Scenario: Staff creates a follow-up capturing client interest
    When staff creates a follow-up with:
      | field    | value                                                              |
      | content  | "Asked about wedding dress alterations — interested in silk option" |
      | type     | "follow_up"                                                        |
      | due_date | "2026-03-22"                                                       |
    Then a FollowUp record is created with status "open"
    And the follow-up content preserves the interest context ("wedding dress alterations", "silk option")
    And the follow-up appears in the client's active items

  Scenario: Multiple interest-tracking follow-ups build a lead profile
    Given a follow-up already exists: "Asked about wedding dress alterations — interested in silk option"
    When staff creates another follow-up: "Called back to ask about pricing — comparing with competitor"
    Then both follow-ups are visible in the client's follow-up history
    And context assembly includes both active follow-ups
    And the AI draft can reference accumulated interest signals when composing replies

  Scenario: Follow-up due date triggers a reminder before the lead goes cold
    Given a follow-up exists with due_date = "2026-03-22" and status "open"
    And today's date is "2026-03-23"
    When the daily follow-up check runs
    Then the follow-up status transitions to "overdue"
    And the follow-up appears in the overdue items list for staff review
    And the COS engine (Phase 3) will prioritize this for follow-up draft generation

  Scenario: Completing a lead nurturing follow-up with an outcome note
    Given a follow-up exists: "Asked about wedding dress alterations — interested in silk option"
    When staff marks the follow-up as "completed"
    And staff saves a note: "Booked consultation for March 28. Decided on silk crepe."
    Then the follow-up status is "completed"
    And the note is saved as a separate Note record with source = "staff_manual"
    And both the follow-up outcome and the note are available in context assembly

  Scenario: Follow-ups without due dates remain visible as open items
    When staff creates a follow-up: "Expressed general interest in monthly packages — follow up when ready"
    And no due date is set
    Then the follow-up has status "open" and due_date = null
    And it remains in the active follow-ups indefinitely until staff completes or updates it
    And it is included in context assembly so the AI knows about the ongoing interest

  Scenario: Interest context is available to AI during draft generation
    Given an open follow-up exists: "Asked about teeth whitening options, budget around $500"
    When a new inbound message arrives from the same client
    And context assembly runs
    Then the follow-up content appears in the activeFollowUps section
    And the AI can use this interest context to craft a relevant, personalized reply
```

### Notes

- Lead nurturing is implemented using the same FollowUp data model — there is no separate "lead" entity. The richness of the `content` field is what captures interest signals, and the `due_date` + `status` lifecycle is what prevents leads from going cold.
- The owner's requirement ("remind and suggest me to follow up, get to know the potential client more") maps to: (1) structured follow-ups with due dates that trigger overdue alerts, and (2) follow-up content being included in context assembly so the AI can suggest relevant engagement when the client messages again.
- In Phase 3, the COS engine (F-12) will proactively generate follow-up draft messages for overdue items, ranked by urgency. In Phase 2, the follow-up infrastructure (create, track, surface in context) is the foundation that makes COS follow-up drafting possible.
- Lifecycle status transitions (e.g., `open` to `chosen_service`) remain managed by F-03. Follow-ups complement lifecycle status by providing granular, actionable tracking of specific interest signals.

---

## Story US-F09-05 — Document Upload, Chunking, and Embedding (ON-08)

**As a** staff member or workspace owner,
**I want to** upload business documents (PDFs, service menus, price lists) that are automatically chunked and embedded for semantic search,
**so that** the AI can cite accurate, up-to-date business information when drafting replies to client questions.

### Acceptance criteria

```gherkin
Feature: Document upload and knowledge indexing

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And the workspace has an existing knowledge base from onboarding (F-01)

  Scenario: Staff uploads a PDF document
    When staff navigates to Settings > Knowledge Base
    And uploads a file "services-menu-2026.pdf" (PDF, under 10 MB)
    Then the system accepts the upload
    And displays a progress indicator while processing
    And upon completion shows a success confirmation with the document name

  Scenario: Uploaded document is chunked into knowledge chunks
    When the file "services-menu-2026.pdf" is processed
    Then the document text is extracted
    And the text is split into chunks (target ~500 tokens per chunk with overlap)
    And each chunk is stored as a KnowledgeChunk record with:
      | field      | value                       |
      | workspace_id | "WS-001"                  |
      | source     | "manual_upload"              |
      | source_ref | "services-menu-2026.pdf"     |
    And each chunk has a non-null embedding (vector(1536)) generated via the embedding model

  Scenario: Uploaded knowledge is searchable immediately after processing
    Given "services-menu-2026.pdf" has been uploaded and processed
    And the document contains "Deep tissue massage — 60 minutes — $120"
    When a client asks "How much is a deep tissue massage?"
    And context assembly performs semantic search (F-05)
    Then the relevant chunk is returned in the search results
    And the AI draft can cite "services-menu-2026.pdf" as the source

  Scenario: Duplicate upload of the same filename replaces previous chunks
    Given "services-menu-2026.pdf" was previously uploaded with 12 chunks
    When staff uploads a new version of "services-menu-2026.pdf"
    Then the previous 12 chunks with source_ref = "services-menu-2026.pdf" are deleted
    And new chunks are created from the updated document
    And the knowledge base reflects the latest content

  Scenario: Unsupported file types are rejected
    When staff attempts to upload a file "photo.exe"
    Then the upload is rejected with a message indicating accepted file types
    And no KnowledgeChunk records are created

  Scenario: Large files are rejected with a clear error
    When staff attempts to upload a file exceeding the size limit (10 MB)
    Then the upload is rejected with a file-size error message
    And no processing is initiated

  Scenario: Upload failure does not corrupt existing knowledge base
    Given the knowledge base contains 50 existing chunks
    When staff uploads a new document but processing fails mid-way
    Then the existing 50 chunks remain intact
    And the partial chunks from the failed upload are rolled back
    And staff is shown an error message with an option to retry
```

### Notes

- Accepted file types for MVP: PDF, plain text (.txt), Markdown (.md). Image-based PDFs may require OCR in a future phase.
- Chunking strategy: split on paragraph/section boundaries, target ~500 tokens per chunk with ~50-token overlap between consecutive chunks to preserve context across boundaries.
- Embeddings are generated using the same model used for semantic search in F-05 (e.g., OpenAI `text-embedding-3-small` producing 1536-dimensional vectors).
- Document processing (text extraction, chunking, embedding) is an async operation — the upload endpoint accepts the file and enqueues processing. The UI shows processing status.
- Knowledge chunks from uploads coexist with chunks from Instagram scraping (F-01) and settings editor entries. The `source` enum distinguishes their origin.

---

## Story US-F09-06 — Staff-Initiated Client Merge (CI-03)

**As a** staff member,
**I want to** merge two duplicate client records into one, transferring all associated data to the target record and soft-deleting the source,
**so that** client history is consolidated and future interactions reference a single, complete profile.

### Acceptance criteria

```gherkin
Feature: Staff-initiated client merge

  Background:
    Given workspace "WS-001" exists
    And client "client-A" (target) has phone_number "+447700900001" with:
      | record type  | count |
      | notes        | 3     |
      | follow-ups   | 2     |
      | bookings     | 1     |
      | messages     | 15    |
    And client "client-B" (source) has phone_number "+447700900099" with:
      | record type  | count |
      | notes        | 2     |
      | follow-ups   | 1     |
      | bookings     | 0     |
      | messages     | 8     |

  Scenario: Staff initiates merge from client profile
    When staff navigates to client "client-B" profile
    And selects "Merge into another client"
    And searches for and selects client "client-A" as the target
    Then a merge confirmation screen shows:
      | detail         | value                                          |
      | target client  | "client-A" (+447700900001)                     |
      | source client  | "client-B" (+447700900099)                     |
      | records to transfer | 2 notes, 1 follow-up, 0 bookings, 8 messages |
    And staff must confirm before the merge executes

  Scenario: All source records transfer to target on merge
    When staff confirms the merge of "client-B" into "client-A"
    Then all notes from "client-B" have their client_id updated to "client-A"
    And all follow-ups from "client-B" have their client_id updated to "client-A"
    And all bookings from "client-B" have their client_id updated to "client-A"
    And all messages from "client-B" have their client_id updated to "client-A"
    And all conversation records from "client-B" are transferred to "client-A"
    And "client-A" now has 5 notes, 3 follow-ups, 1 booking, and 23 messages

  Scenario: Source client is soft-deleted after merge
    When the merge completes
    Then client "client-B" has a deleted_at timestamp set to now
    And client "client-B" no longer appears in client search results
    And client "client-B" no longer appears in the inbox
    And the soft-deleted record is retained in the database for audit purposes

  Scenario: Merge is atomic — all or nothing
    When a merge is in progress and a database error occurs mid-transfer
    Then all transferred records are rolled back
    And both client records remain unchanged
    And staff is shown an error message indicating the merge failed
    And no data is lost or orphaned

  Scenario: Staff cannot merge a client into itself
    When staff attempts to merge client "client-A" into "client-A"
    Then the operation is rejected with a validation error
    And no records are modified

  Scenario: Staff cannot merge an already-deleted client
    Given client "client-C" has been soft-deleted (deleted_at is not null)
    When staff attempts to merge "client-C" into "client-A"
    Then the operation is rejected
    And a message indicates the source client has already been deleted

  Scenario: Merge writes a comprehensive audit event
    When the merge completes successfully
    Then an audit event is logged with:
      | field           | value                              |
      | actor           | "staff-001"                        |
      | action          | "client_merged"                    |
      | source_client_id| "client-B"                         |
      | target_client_id| "client-A"                         |
    And the audit event records the count of each record type transferred
```

### Notes

- Merge is a staff-only, human-initiated operation. The AI cannot propose or execute a merge.
- The merge must run as a database transaction to guarantee atomicity. If any record transfer fails, the entire merge is rolled back.
- Soft-delete uses a `deleted_at` timestamp column on the client record. All queries that list clients must filter on `deleted_at IS NULL`.
- The target client's profile fields (full_name, phone_number, email, preferences) are preserved. Source profile fields are NOT automatically merged — staff should update the target profile manually if needed. The source's unique data is preserved via the merge history note (US-F09-07).
- Phone number of the source client should be stored in the merge history note so that future inbound messages from that number can be investigated.

---

## Story US-F09-07 — Merge History Note Preservation (CI-04)

**As a** staff member reviewing a client record that was the target of a merge,
**I want** a merge history note to be automatically created that records what was merged and from where,
**so that** there is a clear audit trail and important context from the source client is not silently lost.

### Acceptance criteria

```gherkin
Feature: Merge history note preservation

  Background:
    Given client "client-A" (target) and client "client-B" (source) exist in workspace "WS-001"
    And client "client-B" has:
      | field           | value               |
      | full_name       | "Sarah Chen"         |
      | phone_number    | "+447700900099"      |
      | lifecycle_status| "chosen_service"     |
      | preferences     | { "hair_type": "2C" }|

  Scenario: Merge creates a history note on the target client
    When staff merges "client-B" into "client-A"
    Then a Note record is created on "client-A" with:
      | field      | value                  |
      | source     | "merge_history"        |
      | created_by | "staff-001"            |
    And the note content includes:
      | information                | example value                              |
      | source client name         | "Sarah Chen"                               |
      | source phone number        | "+447700900099"                             |
      | source lifecycle status    | "chosen_service"                            |
      | source preferences         | "hair_type: 2C"                             |
      | record counts transferred  | "2 notes, 1 follow-up, 0 bookings, 8 messages" |
      | merge timestamp            | current timestamp                           |

  Scenario: Merge history note is readable in the client thread
    When staff views client "client-A" thread after the merge
    Then the merge history note is visible alongside regular notes
    And it is visually distinguishable (marked with source = "merge_history")
    And staff can read the source client's profile data captured at merge time

  Scenario: Merge history note is included in context assembly
    When context assembly runs for client "client-A" after the merge
    Then the merge history note appears in recentNotes
    And the AI is aware that this client has merged history from another record

  Scenario: Notes from the source client are preserved with original timestamps
    Given client "client-B" had a note created on "2026-03-10" with content "Prefers evening appointments"
    When the merge completes
    Then the note "Prefers evening appointments" exists under client "client-A"
    And its original created_at timestamp of "2026-03-10" is preserved
    And it retains its original source value ("staff_manual")

  Scenario: Merge history note is immutable
    When staff attempts to edit or delete the merge history note
    Then the edit/delete is blocked
    And a message indicates merge history notes cannot be modified
```

### Notes

- The merge history note captures a snapshot of the source client's profile at the time of merge. This is critical because the source record is soft-deleted and should not be routinely queried.
- The `source = "merge_history"` enum value on the Note record allows the UI to render merge notes distinctively (e.g., with a merge icon or different background).
- Existing notes transferred from the source retain their original `source` value and `created_at` timestamp — they are not modified, only re-pointed to the target `client_id`. The merge history note is the only new note created during the merge.
- Merge history notes should be treated as immutable audit records. Staff cannot edit or delete them.

---

## Story US-F09-08 — Knowledge Base Editing in Settings

**As a** workspace owner or staff member,
**I want to** view, edit, and manage knowledge base entries directly in the Settings page,
**so that** I can keep business information accurate without re-uploading documents and the AI always drafts replies using current information.

### Acceptance criteria

```gherkin
Feature: Knowledge base editing in settings

  Background:
    Given staff member "staff-001" is authenticated in workspace "WS-001"
    And the knowledge base contains entries from multiple sources:
      | source            | count | example source_ref         |
      | instagram_scrape  | 8     | "instagram.com/post/123"   |
      | manual_upload     | 12    | "services-menu-2026.pdf"   |
      | settings_editor   | 3     | null                       |

  Scenario: Staff views knowledge base entries grouped by source
    When staff navigates to Settings > Knowledge Base
    Then all knowledge entries are displayed
    And entries are grouped or filterable by source (Instagram, uploaded documents, manual entries)
    And each entry shows a preview of its content and source reference

  Scenario: Staff adds a new knowledge entry manually
    When staff clicks "Add Entry"
    And enters content: "We now offer same-day alterations for an additional $50 rush fee"
    And saves the entry
    Then a KnowledgeChunk record is created with:
      | field        | value                                                           |
      | workspace_id | "WS-001"                                                       |
      | content      | "We now offer same-day alterations for an additional $50 rush fee" |
      | source       | "settings_editor"                                               |
      | source_ref   | null                                                            |
    And an embedding is generated for the new chunk
    And the entry appears in the knowledge base list immediately

  Scenario: Staff edits an existing knowledge entry
    Given a knowledge chunk exists with content "Haircut — $40"
    When staff edits the content to "Haircut — $45 (updated March 2026)"
    And saves the change
    Then the chunk's content is updated to "Haircut — $45 (updated March 2026)"
    And the embedding is regenerated for the updated content
    And updated_at is set to the current timestamp

  Scenario: Staff deletes a knowledge entry
    Given a knowledge chunk exists with chunk_id "chunk-old"
    When staff deletes the entry
    Then a confirmation dialog appears: "Are you sure? The AI will no longer reference this information."
    And upon confirmation, the KnowledgeChunk record is deleted
    And the entry no longer appears in semantic search results

  Scenario: Staff deletes all chunks from an uploaded document
    Given 12 chunks exist with source_ref = "services-menu-2026.pdf"
    When staff selects "Remove document" for "services-menu-2026.pdf"
    Then all 12 chunks with that source_ref are deleted
    And the document no longer appears in the knowledge base

  Scenario: Edits to knowledge base are reflected in the next AI draft
    Given a knowledge chunk contains "Closing time: 6 PM"
    And staff edits it to "Closing time: 8 PM (extended hours starting March 2026)"
    When a client subsequently asks "What time do you close?"
    And context assembly performs semantic search
    Then the updated chunk "Closing time: 8 PM..." is returned
    And the AI draft references the correct, updated closing time
```

### Notes

- The Settings knowledge editor operates on individual KnowledgeChunk records. For entries created via `settings_editor`, each entry is typically a single chunk. For entries from `manual_upload`, chunks are grouped by `source_ref` (filename) and can be managed as a document unit.
- Embedding regeneration on edit is an async operation — the content update is saved immediately, and the new embedding is computed in the background. There may be a brief window where semantic search uses the old embedding for the updated content.
- Instagram-scraped entries (`instagram_scrape`) are editable and deletable just like any other entry. However, re-running Instagram scraping (if supported) would recreate them.
- The knowledge base is workspace-scoped. All chunks are filtered by `workspace_id` in the Settings view.

---

## Story map summary

| Story | PRD functions | Scope | Size estimate |
|-------|--------------|-------|---------------|
| US-F09-01 Immediate note save | NF-01 | Pure DB write, < 1s | XS |
| US-F09-02 Follow-up creation with optional due date | NF-05 | DB write + UI form | S |
| US-F09-03 Follow-up status management | NF-06 | DB update + auto-overdue check | S |
| US-F09-04 Lead nurturing follow-ups | NF-05, NF-06 (extended) | Interest capture + context surfacing | S |
| US-F09-05 Document upload, chunking, and embedding | ON-08 | File upload + async processing + pgvector | M |
| US-F09-06 Staff-initiated client merge | CI-03 | Transactional record transfer + soft-delete | M |
| US-F09-07 Merge history note preservation | CI-04 | Auto-generated note on merge | XS |
| US-F09-08 Knowledge base editing in settings | ON-08 (extended) | CRUD UI + embedding regeneration | S |

**Total feature size: L** (as per feature-list.md — the breadth of functionality across three bounded contexts, the document processing pipeline, and the transactional merge operation justify the sizing.)

---

## Out of scope for F-09

- **Async note categorization** (NF-02) — Phase 3, covered by F-13. Notes are saved raw in F-09; AI extraction of follow-ups and preferences happens later.
- **Conversational context update parsing** (NF-03, NF-04) — Phase 3, covered by F-13.
- **Daily follow-up surfacing by COS** (NF-07) — Phase 3, covered by F-12. F-09 provides the follow-up records that COS operates on.
- **Promise extraction from conversation history** (NF-08) — Phase 3, covered by F-13.
- **Semantic search execution** during context assembly — Phase 2, covered by F-05. F-09 provides the indexed knowledge chunks that F-05 searches.
- **AI-proposed follow-up creation** via the `create_followup` tool — Phase 2, covered by F-05/F-06 (the tool produces a `ProposedAction` that goes through the approval flow).
