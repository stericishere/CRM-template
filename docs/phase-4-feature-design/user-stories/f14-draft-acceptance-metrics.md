# User Stories — F-14: Draft Acceptance Metrics

**Feature:** F-14 — Draft Acceptance Metrics
**Phase:** 3 (Operational Memory & Follow-ups)
**Size:** S
**PRD Functions:** LL-02, LL-09
**Architecture modules:** `learning-optimization` (DraftEditSignal aggregation)
**Last updated:** March 2026

---

## Context

F-14 transforms the raw `DraftEditSignal` records written by F-10 (Learning Signal Capture) into actionable workspace-level metrics. It introduces two distinct but complementary measurement concerns:

**Draft acceptance rate (LL-02)** — For every AI draft that was acted upon, what did staff do with it? Aggregating the four categorical outcomes (`sent_as_is`, `edited_and_sent`, `regenerated`, `discarded`) per workspace gives the manager a quantitative picture of how much the AI's output is trusted. PRD §19.1 designates this a Day 1 metric: "Draft acceptance rate — tracked day 1."

**Client reply tracking (LL-09)** — Did the client respond after a message was sent? And if so, how quickly? Two new fields (`client_replied`, `client_reply_latency_minutes`) are backfilled onto existing signal records when the message pipeline observes a subsequent inbound message from the same client. This data is the downstream input for Phase 4 pattern analysis (F-15) — patterns correlated with high reply rates are stronger promotion candidates.

No LLM is involved in either function. F-14 is a pure data aggregation and backfill job against the `learning_signals` table. It depends entirely on F-10 having produced signal records, and on F-02 (WhatsApp Message Pipeline) continuing to receive inbound messages that can be matched back to sent messages.

### Schema fields involved

From `DraftEditSignal` (PRD §12.14):

| Field | Type | Populated by |
|---|---|---|
| `staff_action` | Enum | F-10 at send time |
| `client_replied` | Boolean (nullable) | F-14 on inbound match |
| `client_reply_latency_minutes` | Integer (nullable) | F-14 on inbound match |
| `edit_categories` | Array\<String\> (nullable) | F-15 in Phase 4 |
| `pattern_key` | String (nullable) | F-15 in Phase 4 |

---

## Story US-F14-01: Draft acceptance rate calculation per workspace (LL-02)

**As a** workspace manager,
**I want** to see a breakdown of how staff have acted on AI-generated drafts — sent unchanged, edited, regenerated, or discarded — across my entire workspace,
**so that** I have a quantitative baseline for AI draft quality and can identify whether the AI needs improvement before committing to Phase 4 learning.

### Acceptance criteria

```gherkin
Feature: Draft acceptance rate calculation

  Background:
    Given a workspace has at least one DraftEditSignal record
    And the workspace manager is authenticated

  Scenario: Aggregation counts all four outcomes correctly
    Given the workspace has the following DraftEditSignal records:
      | staff_action     | count |
      | sent_as_is       | 40    |
      | edited_and_sent  | 30    |
      | regenerated      | 20    |
      | discarded        | 10    |
    When the acceptance metrics are calculated for the workspace
    Then the result contains:
      | metric                 | value |
      | sent_as_is_count       | 40    |
      | edited_and_sent_count  | 30    |
      | regenerated_count      | 20    |
      | discarded_count        | 10    |
      | total_signals          | 100   |
    And the acceptance rate is calculated as (sent_as_is + edited_and_sent) / total_signals
    And the acceptance rate equals 70%

  Scenario: Workspace with no signals returns zeroed metrics
    Given a workspace has been provisioned but no drafts have been reviewed
    When the acceptance metrics are requested for the workspace
    Then all counts are 0
    And the acceptance rate is null (not 0%) to distinguish "no data" from "zero acceptance"
    And no error is raised

  Scenario: Aggregation is scoped strictly to the requesting workspace
    Given workspace A has 60 sent_as_is signals
    And workspace B has 10 sent_as_is signals
    When workspace A requests its acceptance metrics
    Then the sent_as_is_count is 60
    And workspace B's signals are not included in the result

  Scenario: Aggregation respects an optional date range filter
    Given the workspace has signals created across 90 days
    When the manager filters metrics to the last 30 days
    Then only signals with created_at within the 30-day window are included in the counts
    And signals outside the window do not affect any count or the acceptance rate

  Scenario: Regenerated signals count each regeneration event individually
    Given a staff member regenerated a draft 3 times before sending the 4th version as-is
    When the acceptance metrics are calculated
    Then regenerated_count is incremented by 3 (one per regeneration event)
    And sent_as_is_count is incremented by 1 (the final sent draft)
    And total_signals is 4

  Scenario: Scenario-type breakdown is available alongside the totals
    Given the workspace has signals covering multiple scenario types
    When the acceptance metrics are calculated
    Then the result also includes a per-scenario_type breakdown:
      | scenario_type    | sent_as_is | edited_and_sent | regenerated | discarded |
      | booking_inquiry  | ...        | ...             | ...         | ...       |
      | faq              | ...        | ...             | ...         | ...       |
      | follow_up_reply  | ...        | ...             | ...         | ...       |
    And each row sums correctly to the row's total signals
    And the scenario breakdown totals equal the workspace totals
```

### Notes

- The acceptance rate formula (`sent_as_is + edited_and_sent`) / `total_signals` follows PRD §19.1. "edited_and_sent" is included in the numerator because the message was still sent — the draft was useful, even if imperfect.
- A `null` acceptance rate for zero-signal workspaces avoids a misleading "0% acceptance" display on newly provisioned workspaces.
- Aggregation must be workspace-scoped at the database query level (WHERE workspace_id = ?), not filtered in application code, to prevent accidental cross-tenant data leakage.
- The per-scenario breakdown is a should-have for the first delivery; it surfaces which intent categories have the lowest acceptance, giving managers actionable context before they wait for Phase 4 rule promotion.
- Schema reference: PRD §12.14 (DraftEditSignal), §17.4 (Phase 3 ships acceptance rate metrics), §19.1 (Draft acceptance rate Day 1 metric).

---

## Story US-F14-02: Client reply tracking — did the client respond? (LL-09)

**As a** workspace manager,
**I want** the system to detect when a client replies to a sent message and record that fact against the original draft's learning signal,
**so that** I can see which types of AI-drafted messages actually generate client engagement — not just whether staff approved them.

### Acceptance criteria

```gherkin
Feature: Client reply detection backfilled onto learning signals

  Background:
    Given a DraftEditSignal record exists with staff_action "sent_as_is" or "edited_and_sent"
    And the signal's client_replied field is currently null
    And the WhatsApp Message Pipeline (F-02) is operational

  Scenario: Client replies to a sent message — reply detected within the observation window
    Given a message was sent to the client at T=0
    And the client sends an inbound WhatsApp message at T+45 minutes
    When the inbound message is received and processed by the message pipeline
    Then the DraftEditSignal for the most recent sent draft in this conversation is updated:
      | Field                          | Value |
      | client_replied                 | true  |
      | client_reply_latency_minutes   | 45    |
    And client_reply_latency_minutes is rounded to the nearest whole minute
    And no other DraftEditSignal records are modified

  Scenario: Client does not reply within the observation window
    Given a message was sent to the client
    And 72 hours have elapsed since the send timestamp
    And no inbound message has been received from that client in that conversation
    When the observation window closes for that signal
    Then the DraftEditSignal is updated:
      | Field          | Value |
      | client_replied | false |
    And client_reply_latency_minutes remains null

  Scenario: Client replies after the observation window has closed
    Given the observation window has closed and client_replied was set to false
    When the client subsequently sends an inbound message
    Then the DraftEditSignal is not modified retroactively
    And the new inbound message is processed normally by the pipeline
    And a new conversation context is available for the next draft generation

  Scenario: Discarded and regenerated drafts do not receive reply tracking
    Given a DraftEditSignal with staff_action "discarded" or "regenerated"
    When the client sends any subsequent inbound message
    Then client_replied and client_reply_latency_minutes on that signal remain null
    And no update is written to the discarded or regenerated signal record

  Scenario: Multiple sent messages in a conversation — only the latest is tracked
    Given two DraftEditSignal records exist for the same client and workspace:
      | signal | staff_action    | sent_at |
      | A      | sent_as_is      | T-60min |
      | B      | edited_and_sent | T-0min  |
    When the client replies at T+30 minutes
    Then signal B (the most recent sent signal) is updated with client_replied = true and latency = 30
    And signal A is not modified

  Scenario: Inbound message in a different conversation does not affect prior signal
    Given a client has two separate conversation threads (two different conversation_ids)
    And a sent signal exists in thread 1
    When the client sends an inbound message in thread 2
    Then the signal in thread 1 is not updated
    And reply tracking is evaluated only within the same conversation context
```

### Notes

- The observation window for reply tracking is 72 hours from send time. This value balances practical reply patterns (most WhatsApp business replies occur within 24 hours) with the risk of false negatives from slow responders. Engineering can make this workspace-configurable in future.
- Reply matching uses `conversation_id` and `client_id` as the join key — not just `client_id` — to avoid cross-thread contamination.
- `client_reply_latency_minutes` is written as a rounded integer (not float) for simplicity in aggregation. Sub-minute precision is not meaningful for the use cases in scope.
- Only signals with `staff_action` in (`sent_as_is`, `edited_and_sent`) are eligible for reply tracking. Discarded and regenerated drafts represent drafts that were never sent, so there is no reply to await.
- The backfill is triggered by the inbound message event (pipeline-driven), not a polling cron, to minimise latency between the client replying and the signal being updated.
- Schema reference: PRD §12.14 (client_replied, client_reply_latency_minutes), §21.9 (LL-09 Client reply tracking).

---

## Story US-F14-03: Reply latency measurement and storage (LL-09)

**As a** workspace manager,
**I want** to know not just whether clients replied but how long they took,
**so that** I can identify which message types generate fast engagement versus slow or no engagement — giving me signal about message quality beyond the binary replied/not-replied distinction.

### Acceptance criteria

```gherkin
Feature: Reply latency calculation and storage

  Background:
    Given a DraftEditSignal with staff_action "sent_as_is" or "edited_and_sent" has been created
    And the signal's reviewed_at timestamp (the moment the message was dispatched) is recorded on the draft record

  Scenario: Latency is calculated from dispatch time, not draft creation time
    Given a draft was generated at 10:00 and reviewed/sent by staff at 10:45
    And the client replied at 11:15
    When reply tracking is applied
    Then client_reply_latency_minutes is 30 (from 10:45 to 11:15)
    And the draft generation time (10:00) is not used in the latency calculation

  Scenario: Latency rounds sub-minute gaps to the nearest whole minute
    Given a message was sent at T=0 seconds
    And the client replied at T=92 seconds (1 minute 32 seconds)
    When reply tracking writes the latency
    Then client_reply_latency_minutes is 2

  Scenario: Zero-minute latency is stored when client replies within the same minute
    Given a message was sent at T=0
    And the client replies at T=25 seconds
    When reply tracking writes the latency
    Then client_reply_latency_minutes is 0
    And client_replied is true

  Scenario: Latency is null when client_replied is false
    Given the observation window has elapsed and client_replied was set to false
    Then client_reply_latency_minutes is null
    And the null is not treated as 0 in any aggregation

  Scenario: Latency aggregation by workspace returns median and p90
    Given a workspace has 100 DraftEditSignal records with client_replied = true
    When the workspace requests reply latency metrics
    Then the result includes:
      | metric                         | description                              |
      | median_reply_latency_minutes   | median of all non-null latency values    |
      | p90_reply_latency_minutes      | 90th percentile of non-null latency values |
      | replied_count                  | count of signals with client_replied = true |
      | no_reply_count                 | count of signals with client_replied = false |
      | pending_count                  | count of signals with client_replied = null (still in window) |
    And signals with client_replied = null are excluded from latency aggregations
    And signals with client_replied = false are excluded from latency aggregations

  Scenario: Latency breakdown by scenario_type
    Given the workspace has reply latency data across multiple scenario types
    When reply latency metrics are requested
    Then the result also includes median_reply_latency_minutes per scenario_type
    And scenario types with fewer than 5 replied signals display "insufficient data" rather than a potentially misleading median
```

### Notes

- Using `reviewed_at` (the draft dispatch timestamp from the draft record) as the latency start point is intentional. It measures client response time to the actual sent message, not to the AI's draft generation — these can differ by minutes if the draft was queued for review.
- Median and p90 are the preferred summary statistics over mean, because a small number of very slow replies (or automated out-of-office messages) would inflate a mean disproportionately.
- The "fewer than 5 signals" threshold for displaying "insufficient data" on per-scenario breakdowns prevents spurious conclusions from small sample sizes. This threshold is a product decision and may be adjusted.
- `pending_count` (signals still within the observation window with `client_replied = null`) is surfaced so the manager understands the data is still being collected for recent messages, not lost.
- Schema reference: PRD §12.14 (client_reply_latency_minutes), §21.9 (LL-09).

---

## Story US-F14-04: Metrics display in workspace settings (LL-02, LL-09)

**As a** workspace manager,
**I want** to view draft acceptance and client reply metrics in the workspace settings dashboard,
**so that** I have a single place to assess AI draft quality and client engagement trends without needing to query the database directly.

### Acceptance criteria

```gherkin
Feature: Metrics display in workspace settings

  Background:
    Given the manager is logged in to the staff app
    And the workspace has at least one week of DraftEditSignal data

  Scenario: Settings screen shows draft acceptance summary
    When the manager navigates to Settings > AI Performance
    Then the screen displays:
      | Element                      | Content                                          |
      | Acceptance rate              | Percentage (sent_as_is + edited_and_sent / total)|
      | Sent unchanged               | Count of sent_as_is signals                      |
      | Edited and sent              | Count of edited_and_sent signals                 |
      | Regenerated                  | Count of regenerated signals                     |
      | Discarded                    | Count of discarded signals                       |
      | Total drafts reviewed        | Sum of all four counts                           |
    And the metrics reflect the default 30-day rolling window
    And a date range picker allows the manager to change the window (7 / 30 / 90 days)

  Scenario: Client reply metrics are shown below the acceptance rate section
    When the manager views Settings > AI Performance
    Then the screen also displays:
      | Element                          | Content                                      |
      | Client reply rate                | replied_count / (replied_count + no_reply_count) as percentage |
      | Median reply latency             | In minutes, formatted as "X min" or "Xh Ym" for values > 60 |
      | Pending signals                  | Count of signals still in the observation window |
    And signals with client_replied = null are excluded from the reply rate calculation
    And a tooltip explains that "pending" signals represent messages sent within the last 72 hours

  Scenario: Insufficient data state is handled gracefully
    Given a workspace has fewer than 10 total DraftEditSignal records
    When the manager views Settings > AI Performance
    Then the acceptance rate and reply rate display "Not enough data yet"
    And the raw counts are still shown (even if small)
    And a message reads "Metrics become meaningful after ~10 drafts have been reviewed"

  Scenario: Per-scenario breakdown is accessible via expansion
    When the manager clicks "See breakdown by message type"
    Then a table expands showing the per-scenario_type acceptance counts and reply rate
    And scenario types with fewer than 5 signals are labelled "insufficient data" in their reply latency cell
    And the expansion does not require a separate page navigation

  Scenario: Metrics page is read-only
    When the manager views the AI Performance metrics
    Then no create, edit, or delete actions are available on this screen
    And all values are display-only
    And the data refreshes at page load (not real-time)

  Scenario: Manager with no workspace access cannot view another workspace's metrics
    Given a manager authenticated to workspace A
    When they attempt to access the metrics endpoint for workspace B
    Then the request returns 403 Forbidden
    And no data from workspace B is returned
```

### Notes

- "Settings > AI Performance" is the proposed navigation path. The exact label and location within the settings hierarchy are subject to UX review — the acceptance criteria describe the content, not the final visual design.
- The 10-draft threshold for "not enough data" is a product heuristic. Below this, acceptance rate percentages are statistically unreliable and could mislead the manager about AI performance.
- Latency formatting (`Xh Ym` for values over 60 minutes) is a display concern; the stored value in the database remains in raw minutes throughout.
- This story covers the initial read-only display surface. Comparative views (e.g., week-over-week trend lines) are deferred to post-MVP.
- The per-scenario breakdown expansion is a should-have; it reuses data already computed by US-F14-01 and US-F14-03 — no additional aggregation queries are required.
- Authentication scoping (403 on cross-workspace access) mirrors the workspace isolation requirement that applies to all queries in this system (PRD §18.2).
- Schema reference: PRD §17.4 (Phase 3 ships acceptance rate metrics), §19.1 (Draft acceptance rate Day 1 metric).

---

## Story map summary

| Story | PRD Functions | Actor | Priority |
|---|---|---|---|
| US-F14-01 | LL-02 | Workspace Manager | Must-have |
| US-F14-02 | LL-09 | System / Message Pipeline | Must-have |
| US-F14-03 | LL-09 | Workspace Manager | Must-have |
| US-F14-04 | LL-02, LL-09 | Workspace Manager | Should-have |

All four stories are Phase 3 deliverables. US-F14-01 through US-F14-03 are data-layer stories with no UI surface — they can be verified by querying the `learning_signals` table. US-F14-04 is the display layer; it depends on US-F14-01 and US-F14-03 producing correct aggregated values.

None of these stories require an LLM call. The feature is deliberately lightweight: it reads and aggregates data F-10 already collected, and backfills two nullable fields when observable events occur in the message pipeline.

F-14's output (populated `client_replied` and `client_reply_latency_minutes` fields, and pre-computed acceptance rate values) feeds directly into F-15 (Learning Loop & Communication Rules) in Phase 4, where the LearningWorker uses reply signal correlation to weight pattern promotion decisions.

---

## Open questions

1. **Observation window duration** — 72 hours is proposed for the client reply window. For some verticals (e.g., beauty salons with same-day appointments) a shorter window (e.g., 24 hours) may be more meaningful. Should this be a workspace-level configuration in `vertical_config`, or a fixed platform constant?

2. **Reply attribution for multi-staff workspaces** — if workspace B has three staff members all sending messages to the same client across a short window, which sent signal does the client reply attach to? The current spec says "most recent sent signal in the same conversation." Confirm this is correct for multi-staff threads.

3. **Metrics refresh cadence** — the current spec says metrics refresh at page load. If the manager leaves the settings tab open for an extended period, should there be a manual refresh button, or is stale data acceptable given the non-real-time nature of this feature?

4. **Minimum signal threshold for metrics** — the spec uses 10 drafts as the "not enough data" threshold for the display layer. Should this same threshold gate the scenario-type breakdown, or should the breakdown always display raw counts even when the acceptance rate is suppressed?

5. **Backfill for pre-F-14 signals** — when F-14 ships in Phase 3, existing signals written by F-10 in Phase 2 will have `client_replied = null`. For messages sent more than 72 hours before F-14's deploy date, should a one-time migration job attempt to backfill reply status from conversation history, or should those signals be left as permanently null?
