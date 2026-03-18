# User Stories — F-11: Daily Memory Compaction

**Feature:** F-11 — Daily Memory Compaction
**Phase:** 3 (Operational Memory & Follow-ups)
**Size:** L
**PRD Functions:** CS-05, CS-06
**Architecture modules:** `conversation` (CompactConversation), `jobs/DailyCompactionJob`
**ADR dependencies:** ADR-3 (daily scheduled compaction, not reactive), ADR-2 (compaction reads/writes scoped to one client)
**Last updated:** March 2026

---

## Context

F-11 is the system's memory maintenance backbone. Every day, a cron job fires per workspace timezone and compacts conversational history into a durable summary for each client who has had activity since the last compaction cycle.

The compaction pipeline follows a strict sequence:

1. **Identify active clients** — query for clients with messages since their last compaction timestamp.
2. **Flush-before-compact** — verify that all async AI extractions (note categorization, follow-up extraction, promise detection from F-13) have completed for the client. If any are pending, defer that client to the next cycle.
3. **Assemble compaction input** — load the existing compact summary (if any) plus all messages since the last compaction.
4. **LLM summarization call** — a dedicated, cheap summarization LLM call (NOT the Client Worker) merges the existing summary with new messages to produce an updated compact summary.
5. **Write versioned Memory record** — insert a new `Memory` row with `type: compact_summary`, `version: N+1`. Update the `client.summary` field with the latest version.
6. **Skip inactive clients** — clients with no activity since last compaction are not processed; no empty compaction records are created.

Compaction preserves all structured records (client profile fields, notes, follow-ups, bookings, lifecycle status) intact. It discards individual message content, exact conversation wording, tool call details, draft iterations, and the previous compact summary version — replacing them with the updated summary.

The compact summary occupies a fixed ~2,000 token budget in the context window (Architecture §3.3, slot 7) and is loaded on every Client Worker invocation. It is the primary vehicle through which the AI "remembers" a client's history beyond the last ~10 messages.

F-11 depends on F-05 (conversations must exist) and is a prerequisite for F-12 (COS Operations relies on compact summaries for contextually rich follow-up drafts).

---

## Story US-F11-01: Daily compaction cron scheduled per workspace timezone (CS-05)

**As a** workspace owner,
**I want** memory compaction to run automatically each day at a consistent time in my business timezone,
**so that** client summaries are refreshed overnight and ready for the next business day — without any manual intervention or timezone confusion.

### Acceptance criteria

```gherkin
Feature: Daily compaction cron scheduled per workspace timezone

  Background:
    Given a workspace exists with timezone set to "Asia/Hong_Kong" (UTC+8)
    And the workspace has at least one client with messages

  Scenario: Compaction runs at the configured time in the workspace timezone
    Given the system clock reaches 03:00 in the workspace timezone "Asia/Hong_Kong"
    When the DailyCompactionJob fires for this workspace
    Then the job processes all clients with activity since the last compaction
    And the job execution is logged with the workspace_id and start/end timestamps in UTC

  Scenario: Multiple workspaces in different timezones compact independently
    Given workspace A has timezone "Asia/Hong_Kong" (UTC+8)
    And workspace B has timezone "America/New_York" (UTC-5)
    When the system clock reaches 03:00 Asia/Hong_Kong time
    Then DailyCompactionJob fires for workspace A
    And DailyCompactionJob does NOT fire for workspace B
    When the system clock later reaches 03:00 America/New_York time
    Then DailyCompactionJob fires for workspace B

  Scenario: Workspace timezone change takes effect on the next cycle
    Given workspace A previously had timezone "Asia/Hong_Kong"
    And the owner changes the workspace timezone to "Europe/London"
    When the next daily compaction scheduling cycle runs
    Then workspace A's compaction is scheduled at 03:00 Europe/London time
    And no duplicate compaction runs for the transition day

  Scenario: New workspace receives its first compaction
    Given a workspace was created today and has timezone "Asia/Hong_Kong"
    And a client in the workspace has received messages
    When 03:00 Asia/Hong_Kong arrives for the first time after workspace creation
    Then DailyCompactionJob fires for the workspace
    And the client's first compact summary is generated with version 1

  Scenario: Compaction does not run twice in the same day for a workspace
    Given the DailyCompactionJob has already completed for workspace A today
    When 03:00 arrives again (e.g., due to DST clock change or job scheduler retry)
    Then the job detects the workspace was already compacted today
    And the job skips the workspace without error
    And a debug log entry records the skip reason
```

### Notes

- The 03:00 local time is a design default; the exact hour should be configurable per workspace or globally. The key requirement is that compaction runs during off-peak hours in the workspace's local timezone.
- IANA timezone strings are used (PRD §12.1: `timezone` field on workspace). Invalid IANA strings should be caught at workspace creation/update time, not at cron scheduling time.
- The cron scheduler must handle DST transitions gracefully: a "spring forward" skip or "fall back" duplication must not result in missed or double compaction.
- ADR-3 confirms daily scheduled compaction is the only compaction path. There is no emergency or reactive compaction trigger.

---

## Story US-F11-02: Flush-before-compact invariant check (CS-06)

**As a** system operator,
**I want** compaction to verify that all async AI extractions are complete for a client before summarizing their messages,
**so that** important information identified during conversation processing (notes, follow-ups, promises) is durably stored in structured records before the raw messages are summarized away.

### Acceptance criteria

```gherkin
Feature: Flush-before-compact invariant check

  Background:
    Given the DailyCompactionJob is running for a workspace
    And client "Alice" has messages since her last compaction

  Scenario: All extractions complete — compaction proceeds
    Given all async note categorization jobs for Alice are resolved
    And all follow-up extraction jobs for Alice are resolved
    And all promise detection jobs for Alice are resolved
    When the compaction job evaluates Alice
    Then compaction proceeds to the LLM summarization step for Alice

  Scenario: Pending note categorization — compaction deferred
    Given Alice has 1 pending async note categorization job
    When the compaction job evaluates Alice
    Then compaction for Alice is deferred to the next daily cycle
    And a log entry records: client_id, workspace_id, reason "pending_note_categorization", count of pending jobs
    And the compaction job continues processing other clients in the workspace

  Scenario: Pending follow-up extraction — compaction deferred
    Given Alice has 1 pending async follow-up extraction job
    When the compaction job evaluates Alice
    Then compaction for Alice is deferred to the next daily cycle
    And the deferral reason is "pending_followup_extraction"

  Scenario: Pending promise detection — compaction deferred
    Given Alice has 1 pending async promise detection job
    When the compaction job evaluates Alice
    Then compaction for Alice is deferred to the next daily cycle
    And the deferral reason is "pending_promise_detection"

  Scenario: Deferral does not lose the activity window
    Given Alice's compaction was deferred yesterday due to pending extractions
    And the pending extractions have since completed
    And Alice has had no new messages since yesterday
    When today's compaction job evaluates Alice
    Then Alice is still identified as needing compaction (activity since last successful compaction)
    And all messages since the last successful compaction are included in the summarization input
    And compaction proceeds normally

  Scenario: Multiple clients — one deferred, others proceed
    Given Alice has pending extractions and Bob does not
    When the compaction job runs for the workspace
    Then Alice's compaction is deferred
    And Bob's compaction runs to completion
    And the job summary log records: compacted=1, deferred=1
```

### Notes

- The flush-before-compact invariant is adapted from OpenClaw's most important memory pattern (Architecture §6.3). In OpenClaw, a silent agent turn writes to `memory/YYYY-MM-DD.md` before compaction. In our system, we verify that async note categorization (F-13) has completed instead.
- "Pending" means a BullMQ job or equivalent async task exists for the client that has not yet reached a terminal state (completed or failed).
- A failed extraction (as opposed to pending) should NOT block compaction. Failed extractions are a separate concern; they should be retried or escalated independently. Only in-progress or queued jobs constitute a deferral condition.
- The check is per-client, not per-workspace. One client's pending extraction must not block compaction for other clients.

---

## Story US-F11-03: Compact summary generation via LLM (CS-05)

**As a** staff member reviewing a client conversation,
**I want** the system to produce a well-structured, accurate compact summary that captures the essential history of my client relationship,
**so that** the AI assistant has reliable context for generating high-quality drafts — even for clients I haven't spoken with in weeks.

### Acceptance criteria

```gherkin
Feature: Compact summary generation via LLM

  Background:
    Given client "Alice" has passed the flush-before-compact check
    And Alice has an existing compact summary at version 3
    And Alice has 15 new messages since the last compaction

  Scenario: Updated compact summary generated from existing summary + new messages
    When the compaction job runs the LLM summarization step for Alice
    Then the LLM receives as input:
      | Input                | Content                                      |
      | existing_summary     | Alice's current compact summary (version 3)  |
      | new_messages         | all 15 messages since last compaction         |
    And the LLM produces an updated compact summary that merges existing context with new information
    And the output is a single text block suitable for injection into the context window

  Scenario: First-ever compaction for a new client (no existing summary)
    Given client "Bob" has no existing compact summary (first compaction)
    And Bob has 8 messages since workspace creation
    When the compaction job runs the LLM summarization step for Bob
    Then the LLM receives existing_summary as null or empty
    And the LLM produces an initial compact summary from the 8 messages alone
    And the summary is written as version 1

  Scenario: Summarization uses a dedicated cheap LLM call, not the Client Worker
    When the compaction LLM call is made
    Then the call uses the summarization prompt template (not the Client Worker system prompt)
    And the call does NOT include tool definitions, knowledge chunks, or SOP rules
    And the model used may be a smaller/cheaper model than the Client Worker model

  Scenario: Summary respects the token budget
    When the LLM produces an updated compact summary
    Then the summary text fits within approximately 2,000 tokens
    And the summarization prompt instructs the LLM to prioritize:
      | Priority | Content type                                    |
      | 1        | Client preferences and stated requirements      |
      | 2        | Relationship milestones and key decisions        |
      | 3        | Unresolved topics and pending items              |
      | 4        | Communication style observations                |
      | 5        | Historical context (oldest items first to drop)  |

  Scenario: Summary does not duplicate structured records
    Given Alice has 3 follow-up records and 2 booking records in the database
    When the LLM produces the compact summary
    Then the summary does NOT repeat the exact details of follow-ups or bookings
    And the summary MAY reference them in passing (e.g., "has an upcoming fitting appointment")
    And the structured records remain the authoritative source for those facts
```

### Notes

- The summarization call is explicitly separated from the Client Worker (Architecture §6.2, step 3). It uses a dedicated prompt template optimized for compression, not conversation.
- The ~2,000 token budget aligns with Architecture §3.3 (slot 7: Compact summary). The LLM prompt should include an explicit instruction about target length.
- The LLM should be instructed to write in third person, factual tone (e.g., "Alice prefers morning appointments" not "You prefer morning appointments") since the summary is consumed by the Client Worker, not shown to the client.
- Structured records (notes, follow-ups, bookings) are loaded separately in context assembly (slots 6 and 8). The summary should complement, not duplicate them.

---

## Story US-F11-04: Versioned Memory record creation (CS-05)

**As a** system operator,
**I want** each compaction cycle to produce a new versioned Memory record rather than overwriting the previous one,
**so that** there is an audit trail of summary evolution and the ability to diagnose compaction issues by comparing versions.

### Acceptance criteria

```gherkin
Feature: Versioned Memory record creation

  Background:
    Given the LLM has produced an updated compact summary for client "Alice"
    And Alice's current compact summary is version 3

  Scenario: New Memory record written with incremented version
    When the compaction job writes the result
    Then a new row is inserted into the Memory table with:
      | Field        | Value                                          |
      | memory_id    | a new UUID                                     |
      | client_id    | Alice's client UUID                            |
      | type         | compact_summary                                |
      | content      | the LLM-generated summary text                 |
      | version      | 4                                              |
      | date         | today's date in the workspace timezone         |
      | created_at   | current UTC timestamp                          |
    And the previous version 3 record is NOT deleted or modified

  Scenario: Client summary field updated to latest version
    When the new Memory record (version 4) is written
    Then Alice's client record summary field is updated with the version 4 content
    And subsequent Client Worker invocations for Alice load the version 4 summary

  Scenario: Memory write and client summary update are atomic
    When the compaction job writes the new Memory record
    Then the Memory INSERT and client summary UPDATE occur in the same database transaction
    And if either operation fails, both are rolled back
    And the client retains their version 3 summary

  Scenario: First compaction creates version 1
    Given client "Bob" has no existing Memory records of type compact_summary
    When the compaction job writes Bob's first summary
    Then a Memory record is created with version 1
    And Bob's client summary field is set for the first time

  Scenario: Version numbers are monotonically increasing per client
    Given Alice has Memory records at versions 1, 2, 3, and 4
    Then no two Memory records for Alice share the same version number
    And version numbers form a contiguous sequence starting at 1
    And the record with the highest version is the current active summary
```

### Notes

- The Memory schema is defined in PRD §12.10. The `version` field is specifically for `compact_summary` versioning.
- Previous versions are retained for auditability. A future cleanup job (not in scope for F-11) could prune versions older than a configurable retention window.
- The `date` field records the date the summary covers (in workspace timezone), not UTC date. This is important for workspaces near the date boundary (e.g., a workspace at UTC+13 compacting at 03:00 local time is still "yesterday" in UTC).
- The atomic transaction ensures that a crash between the Memory INSERT and client summary UPDATE does not leave the system in an inconsistent state.
- All Memory records are scoped by `client_id`, which in turn is scoped by `workspace_id` (ADR-2). Cross-tenant reads are structurally impossible.

---

## Story US-F11-05: Compaction skips clients with no activity (CS-05)

**As a** system operator,
**I want** the compaction job to skip clients who have had no activity since their last compaction,
**so that** the system does not waste LLM calls or create redundant Memory records for unchanged client histories.

### Acceptance criteria

```gherkin
Feature: Compaction skips clients with no activity

  Background:
    Given the DailyCompactionJob is running for a workspace with 5 clients

  Scenario: Client with no messages since last compaction is skipped
    Given client "Alice" was last compacted yesterday
    And Alice has had no inbound or outbound messages since yesterday's compaction
    When the compaction job runs
    Then Alice is not included in the compaction candidate list
    And no LLM call is made for Alice
    And no new Memory record is created for Alice
    And Alice retains her existing compact summary unchanged

  Scenario: Client with activity since last compaction is processed
    Given client "Bob" was last compacted yesterday
    And Bob has received 3 new messages since yesterday's compaction
    When the compaction job runs
    Then Bob is included in the compaction candidate list
    And the normal compaction pipeline (flush check, LLM call, Memory write) runs for Bob

  Scenario: Client who has never been compacted with no messages is skipped
    Given client "Charlie" was created yesterday during workspace onboarding
    And Charlie has received no messages yet
    When the compaction job runs
    Then Charlie is not included in the compaction candidate list
    And no Memory record exists for Charlie

  Scenario: Activity detection includes both inbound and outbound messages
    Given client "Diana" has no new inbound messages since last compaction
    But Diana has 2 outbound messages sent by staff since last compaction
    When the compaction job runs
    Then Diana IS included in the compaction candidate list
    And Diana's outbound messages are included in the summarization input

  Scenario: Compaction job reports accurate activity counts
    Given the workspace has 5 clients
    And 2 clients have activity since last compaction
    And 3 clients have no activity since last compaction
    When the compaction job completes
    Then the job summary log records:
      | Metric              | Value |
      | total_clients       | 5     |
      | active_candidates   | 2     |
      | compacted           | 2     |
      | skipped_no_activity | 3     |
```

### Notes

- "Activity" means any message (inbound or outbound) with a `created_at` timestamp after the client's last successful compaction timestamp. Staff notes added via F-09 are structured records and survive compaction regardless; they do not trigger compaction on their own.
- The activity query should be efficient: an indexed comparison of `message.created_at > client.last_compacted_at` (or equivalent). The compaction job should not load full message content during the candidate identification phase.
- Skipping inactive clients is an important cost optimization. In a workspace with 500 clients, typically only 10-50 will have daily activity. The LLM summarization cost scales with active clients, not total clients.

---

## Story US-F11-06: Error handling for LLM failure and partial compaction (CS-05, CS-06)

**As a** system operator,
**I want** the compaction job to handle LLM failures and partial errors gracefully,
**so that** one client's compaction failure does not block other clients, and no data is lost or corrupted due to transient errors.

### Acceptance criteria

```gherkin
Feature: Error handling for LLM failure and partial compaction

  Background:
    Given the DailyCompactionJob is running for a workspace with 3 active clients:
      | Client | Has activity | Flush check |
      | Alice  | Yes          | Passed      |
      | Bob    | Yes          | Passed      |
      | Carol  | Yes          | Passed      |

  Scenario: LLM call fails for one client — others proceed
    Given the LLM summarization call for Alice returns a transient error (e.g., timeout, rate limit, 500)
    When the compaction job processes all 3 clients
    Then Bob and Carol are compacted successfully
    And Alice's compaction is marked as failed for this cycle
    And Alice retains her previous compact summary unchanged
    And the job summary log records: compacted=2, failed=1

  Scenario: Failed client is retried on the next daily cycle
    Given Alice's compaction failed yesterday due to an LLM error
    And Alice has the same messages pending compaction (plus any new ones)
    When today's compaction job runs
    Then Alice is included in today's candidate list
    And compaction is attempted again with all messages since Alice's last successful compaction

  Scenario: LLM returns empty or malformed summary
    Given the LLM call for Bob returns an empty string or clearly malformed output
    When the compaction job evaluates the LLM response
    Then the response is rejected (not written to the Memory table)
    And Bob retains his previous compact summary
    And an error is logged with: client_id, workspace_id, response_length, reason "empty_or_malformed"
    And compaction continues for remaining clients

  Scenario: Database write fails after successful LLM call
    Given the LLM summarization for Carol succeeds
    But the Memory table INSERT or client summary UPDATE fails (e.g., database error)
    When the error is caught
    Then the transaction is rolled back (no partial write)
    And Carol retains her previous compact summary
    And the error is logged with: client_id, workspace_id, reason "db_write_failed"
    And the LLM-generated summary is logged for manual recovery if needed

  Scenario: All LLM calls fail — job completes without crash
    Given the LLM service is fully unavailable (e.g., outage)
    When the compaction job attempts all 3 clients and all fail
    Then the job completes with exit status indicating partial failure
    And the job summary log records: compacted=0, failed=3
    And all 3 clients retain their previous compact summaries
    And an alert-level log entry is emitted: "All compaction attempts failed for workspace {id}"

  Scenario: Compaction job itself crashes mid-run
    Given the compaction job has successfully compacted Alice
    And the job process crashes before processing Bob and Carol
    When the job scheduler detects the crash
    Then Alice's compaction is durable (committed transaction)
    And Bob and Carol are treated as unprocessed on the next cycle
    And no duplicate compaction occurs for Alice (idempotency check via last_compacted_at)
```

### Notes

- Each client's compaction is an independent unit of work. The job iterates over candidates and processes them one at a time (or in bounded parallel batches). A failure for one client must never abort the entire job.
- The LLM response validation should check for: non-empty content, minimum length (e.g., > 50 characters), and absence of obvious error patterns (e.g., the model returning "I cannot" or repeating the prompt).
- The "log for manual recovery" on database write failure is a safety net. If the LLM call was expensive and the DB failure is transient, an operator can manually insert the summary without re-running the LLM call.
- Idempotency is enforced by checking `last_compacted_at` before processing. If a client was already compacted today (e.g., due to a job scheduler retry), the job skips them (see US-F11-01, duplicate prevention scenario).
- Alert escalation: a single client failure is a warning. All clients failing in a workspace is an alert. All clients failing across all workspaces should trigger a critical alert (monitored externally, not part of F-11 scope).

---

## Story map summary

| Story | PRD Function | Actor | Scope | Priority |
|---|---|---|---|---|
| US-F11-01 | CS-05 | Workspace owner / System | Cron scheduling per timezone | Must-have |
| US-F11-02 | CS-06 | System operator | Flush-before-compact invariant | Must-have |
| US-F11-03 | CS-05 | Staff member / AI system | LLM summary generation | Must-have |
| US-F11-04 | CS-05 | System operator | Versioned Memory writes | Must-have |
| US-F11-05 | CS-05 | System operator | Skip-no-activity optimization | Must-have |
| US-F11-06 | CS-05, CS-06 | System operator | Error handling and resilience | Must-have |

All six stories are Phase 3 must-haves. US-F11-01 through US-F11-04 form the core compaction pipeline in execution order. US-F11-05 is a cost-critical optimization (without it, every client incurs a daily LLM call). US-F11-06 is the resilience layer that prevents cascading failures in a multi-tenant system.

## Open questions

1. **Compaction hour configurability** — US-F11-01 uses 03:00 local time as the default. Should this be configurable per workspace (e.g., a restaurant that is busiest at 03:00), or is a single global default acceptable for MVP? Engineering to decide.
2. **Summary version retention policy** — US-F11-04 retains all previous versions. At scale (365 versions/year per active client), this may become a storage concern. Should F-11 include a retention policy (e.g., keep last 30 versions), or defer to a future cleanup feature?
3. **Summarization model selection** — US-F11-03 notes the LLM call may use a cheaper model. Should the model be configurable per workspace, or is a single system-wide default sufficient? Cost vs. quality tradeoff to be evaluated during implementation.
4. **Activity definition edge cases** — US-F11-05 defines activity as messages only. Should staff-created notes (F-09) or booking status changes (F-07) also count as activity that triggers compaction? These are structured records that survive compaction anyway, so recompaction may not add value.
5. **Parallel compaction within a workspace** — US-F11-06 implies sequential processing. For workspaces with many active clients (50+), should the job process clients in parallel batches (e.g., 5 at a time) to reduce total job duration? Bounded parallelism with per-client isolation would maintain the error containment guarantee.
