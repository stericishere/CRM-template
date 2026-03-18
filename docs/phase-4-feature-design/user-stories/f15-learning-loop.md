# User Stories — F-15: Learning Loop & Communication Rules

**Feature:** F-15 — Learning Loop & Communication Rules
**Phase:** 4 (Refinement & Learning)
**Size:** XL
**PRD Functions:** LL-03, LL-04, LL-05, LL-06, LL-07, LL-08
**Architecture modules:** `learning-optimization` (ClassifyDraftEdits, UpdatePatternRecurrence, PromoteToCommunicationRule, CommunicationRule, WorkspaceCommunicationProfile)
**ADR Dependencies:** ADR-1 (rules injected into single-agent context, not as a separate agent), ADR-3 (rules are part of global context assembled deterministically)
**Prerequisite features:** F-10 (Learning Signal Capture — raw DraftEditSignal data), F-14 (Draft Acceptance Metrics — aggregated signal data), F-05 (Context Assembly — rule injection target)
**Last updated:** March 2026

---

## Context

F-15 closes the learning loop. Phases 2 and 3 captured the raw data (F-10) and computed acceptance metrics (F-14). This feature analyzes *what* staff changed, detects recurring patterns, and promotes those patterns into workspace-level communication rules that improve all future AI drafts.

The architecture follows the self-improving-agent pattern (architecture spec 8.1): log immediately, classify asynchronously, track recurrence with stable keys, promote only when a threshold is met, and always allow human review of promoted rules.

**The pipeline has five stages:**

1. **Diff classification** (LL-03, LL-04) — An async LearningWorker processes `DraftEditSignal` records where `staff_action = "edited_and_sent"`. An LLM call classifies the edit into one or more `EditCategory` values (e.g., `tone_softened`, `assumption_removed`, `upsell_removed`) and assigns a stable `patternKey` for recurrence tracking.

2. **Recurrence tracking** (LL-05) — After classification, the worker updates a `PatternRecurrence` record: increments `recurrence_count`, recalculates `distinct_clients`, and updates `last_seen`.

3. **Promotion check** (LL-06) — If the pattern meets the threshold (3+ occurrences, 2+ distinct clients, within a 30-day window from `first_seen`), the pattern becomes a promotion candidate.

4. **Rule creation** (LL-07) — A promoted pattern produces a `CommunicationRule` record with a human-readable `instruction` string, linked to the `WorkspaceCommunicationProfile`. The rule is active by default.

5. **Rule injection** (LL-08) — The context assembler (F-05) loads all active rules from the `WorkspaceCommunicationProfile` into the global context section of every Client Worker invocation. Rules sit alongside the tone profile and vertical config as learned refinements.

**Key constraints:**

- The LearningWorker is async — it never blocks the staff send flow. Classification latency is irrelevant to the user experience.
- Pattern keys must be stable: the same conceptual edit (e.g., "staff always shortens booking confirmations") must resolve to the same key whether it occurs in week 1 or week 12.
- Rules are workspace-scoped. Client-level preferences are deferred to post-MVP (architecture spec 8.4).
- Staff can view, edit, and disable rules in Settings. Promotion is a suggestion, not an irreversible commitment (architecture spec 8.7, point 5).
- The LLM classifies edits but never writes rules directly. The promotion logic is deterministic application code.

**EditCategory taxonomy** (architecture spec 8.3):

`tone_softened`, `tone_warmed`, `tone_formalized`, `shortened`, `lengthened`, `assumption_removed`, `fact_corrected`, `scheduling_options_added`, `cta_softened`, `cta_strengthened`, `personalization_added`, `upsell_removed`, `policy_clarification_added`, `greeting_changed`, `closing_changed`, `emoji_added_or_removed`, `structure_reorganized`

---

## Stories

### US-F15-01: Diff classification of staff edits (LL-03)

**As a** workspace manager,
**I want** every staff-edited draft to be asynchronously classified by edit type (tone change, content correction, style adjustment, etc.),
**so that** the system understands *what* staff are consistently changing — not just *that* they changed something — and can detect recurring preferences.

#### Acceptance criteria

```gherkin
Feature: Async diff classification of edited drafts

  Background:
    Given the workspace has AI drafting active (F-05 operational)
    And the LearningWorker async job is running
    And a DraftEditSignal record exists with staff_action "edited_and_sent"
    And original_draft and final_version are both non-null, non-empty strings

  Scenario: Single-category edit is classified correctly
    Given a signal where original_draft contains "Dear Mr. Chen, I trust this message finds you well"
    And final_version contains "Hey David! Hope you're doing great"
    When the LearningWorker processes this signal
    Then a DraftEditClassification is created with:
      | Field            | Value                                      |
      | signal_id        | the UUID of the DraftEditSignal             |
      | edit_categories  | ["tone_warmed"]                             |
      | severity         | significant                                 |
      | analysis_notes   | non-empty explanation of the detected change |
    And the DraftEditSignal record's edit_categories field is updated to match
    And the signal is marked as classified (processed_at is set)

  Scenario: Multi-category edit produces multiple classifications
    Given a signal where the staff shortened the draft, removed an upsell, and softened the CTA
    When the LearningWorker processes this signal
    Then edit_categories contains ["shortened", "upsell_removed", "cta_softened"]
    And severity is "significant" or "rewrite" depending on scope of changes
    And analysis_notes describes all three detected changes

  Scenario: Minor whitespace or punctuation edit is classified as minor severity
    Given a signal where final_version differs from original_draft only by trailing punctuation
    When the LearningWorker processes this signal
    Then severity is "minor"
    And edit_categories contains the most relevant category (e.g., "tone_formalized")
    And the classification is still recorded for completeness

  Scenario: Classification uses only the diff between original and final
    Given a signal with original_draft and final_version
    When the LearningWorker invokes the LLM for classification
    Then the LLM prompt contains both the original_draft and final_version texts
    And the LLM prompt contains the intent_classified and scenario_type for context
    And the LLM prompt does NOT contain any client PII beyond what is in the draft texts
    And the LLM is instructed to select from the fixed EditCategory taxonomy

  Scenario: Only edited_and_sent signals are classified
    Given a DraftEditSignal with staff_action "sent_as_is"
    When the LearningWorker runs its processing cycle
    Then the signal is skipped without invoking an LLM call
    And no DraftEditClassification is created for this signal

  Scenario: LLM classification failure does not lose the signal
    Given the LLM API returns an error during classification
    When the LearningWorker catches the error
    Then the signal remains in "unprocessed" state (processed_at stays null)
    And the error is logged with signal_id and error details
    And the signal will be retried in the next processing cycle
    And no partial classification record is written

  Scenario: LLM returns an edit category not in the taxonomy
    Given the LLM classification response includes a category not in the EditCategory enum
    When the LearningWorker parses the response
    Then the unknown category is discarded
    And only valid EditCategory values are stored
    And a warning is logged with the unknown category value for taxonomy review
```

#### Notes

- The LearningWorker is a BullMQ job that picks up unprocessed `DraftEditSignal` records in batches. Processing order does not matter.
- The LLM prompt for classification should include 2-3 examples (few-shot) to anchor the taxonomy. The prompt is workspace-agnostic — the same classification prompt works for all verticals.
- Severity levels: `minor` (cosmetic — punctuation, whitespace, minor word swap), `significant` (meaningful change to tone, content, or structure), `rewrite` (staff replaced >50% of the draft text).
- Classification is idempotent: re-processing a signal overwrites the previous classification. This allows taxonomy updates without data migration.
- Schema reference: Architecture spec 8.3 (`DraftEditClassification` type), PRD 17.2.

---

### US-F15-02: Stable pattern key assignment (LL-04)

**As a** workspace manager,
**I want** each classified edit to receive a stable pattern key that groups conceptually identical corrections together,
**so that** the system can track recurrence across clients and time — recognizing that "staff softens the greeting" on Monday with Client A and on Thursday with Client B is the same underlying preference.

#### Acceptance criteria

```gherkin
Feature: Stable pattern key assignment for recurrence tracking

  Background:
    Given the LearningWorker has classified a DraftEditSignal
    And a DraftEditClassification exists with one or more edit_categories

  Scenario: Pattern key assigned during classification
    Given the LLM classification response includes a pattern key
    When the LearningWorker persists the classification
    Then the DraftEditClassification record has a non-null pattern_key
    And the DraftEditSignal record's pattern_key field is updated to match
    And the pattern_key is a lowercase, underscore-separated string (e.g., "shorten_booking_confirmation")

  Scenario: Same conceptual edit across different clients resolves to the same key
    Given Client A's signal was classified as "tone_softened" with analysis "staff replaced formal greeting with casual greeting"
    And Client B's signal was classified as "tone_softened" with analysis "staff changed formal opening to informal opening"
    When both signals are classified by the LearningWorker
    Then both receive the same pattern_key (e.g., "soften_greeting_tone")
    And the PatternRecurrence record for that key shows distinct_clients >= 2

  Scenario: Different edit categories produce different pattern keys
    Given one signal is classified as "upsell_removed" (staff removed cross-sell language from reminders)
    And another signal is classified as "shortened" (staff trimmed verbose booking confirmations)
    When both are classified
    Then they receive different pattern_keys
    And two separate PatternRecurrence records are created or updated

  Scenario: Pattern key includes scenario context when relevant
    Given a signal classified as "tone_softened" in a "first_contact" scenario
    And another signal classified as "tone_softened" in a "reminder" scenario
    When the LLM determines the edits reflect the same underlying preference (soften tone everywhere)
    Then both receive the same pattern_key
    When the LLM determines they reflect different preferences (formal for first contact, casual for reminders)
    Then they receive different pattern_keys

  Scenario: Multi-category edits produce one pattern key per dominant category
    Given a signal classified with edit_categories ["shortened", "upsell_removed", "cta_softened"]
    When the LearningWorker assigns pattern keys
    Then one pattern_key is assigned that captures the dominant change
    Or multiple pattern_keys are assigned if the changes are independent patterns
    And each pattern_key results in its own PatternRecurrence update

  Scenario: Pattern key stability over time
    Given a pattern_key "remove_upsell_from_reminders" was assigned in week 1
    And a conceptually identical edit occurs in week 6
    When the LearningWorker classifies the week-6 signal
    Then the LLM is provided with existing pattern keys for the workspace as reference
    And the classification reuses "remove_upsell_from_reminders" rather than creating a synonym
```

#### Notes

- Pattern key stability is the most architecturally important property of the learning loop. Without it, recurrence tracking fragments and the promotion threshold is never met.
- The LLM prompt for classification includes a list of existing pattern keys for the workspace (fetched from `PatternRecurrence`) so it can reuse existing keys rather than inventing synonyms. This is the primary mechanism for key stability.
- If the workspace has no existing pattern keys (first classification), the LLM generates a new key. The key format convention is `{verb}_{object}_{context}` — e.g., `soften_greeting_tone`, `remove_upsell_reminders`, `shorten_booking_confirmation`.
- The pattern key is assigned in the same LLM call as the edit classification (LL-03 and LL-04 share a single LLM invocation). There is no separate LLM call for key assignment.
- Schema reference: Architecture spec 8.3 (`patternKey` field), 8.4 (recurrence tracking relies on key stability).

---

### US-F15-03: Recurrence count update (LL-05)

**As a** workspace manager,
**I want** the system to track how many times each edit pattern has recurred and across how many distinct clients,
**so that** one-off corrections are distinguished from systematic preferences — ensuring only genuine workspace-wide patterns influence future drafts.

#### Acceptance criteria

```gherkin
Feature: Recurrence count and distinct client tracking

  Background:
    Given the LearningWorker has classified a signal and assigned a pattern_key

  Scenario: First occurrence of a new pattern
    Given no PatternRecurrence record exists for pattern_key "remove_upsell_reminders" in this workspace
    When the LearningWorker processes the classified signal
    Then a new PatternRecurrence record is created with:
      | Field            | Value                                 |
      | pattern_key      | remove_upsell_reminders               |
      | workspace_id     | the workspace UUID                    |
      | category         | upsell_removed                        |
      | recurrence_count | 1                                     |
      | distinct_clients | 1                                     |
      | first_seen       | the created_at of the DraftEditSignal |
      | last_seen        | the created_at of the DraftEditSignal |
      | promoted         | false                                 |
      | promoted_at      | null                                  |

  Scenario: Recurring pattern from the same client
    Given a PatternRecurrence record exists for "soften_greeting_tone" with recurrence_count 1 and distinct_clients 1 (Client A)
    And a new classified signal arrives for the same pattern from Client A
    When the LearningWorker updates the recurrence
    Then recurrence_count is incremented to 2
    And distinct_clients remains 1
    And last_seen is updated to the new signal's created_at

  Scenario: Recurring pattern from a different client
    Given a PatternRecurrence record exists for "soften_greeting_tone" with recurrence_count 2 and distinct_clients 1 (Client A)
    And a new classified signal arrives for the same pattern from Client B
    When the LearningWorker updates the recurrence
    Then recurrence_count is incremented to 3
    And distinct_clients is updated to 2
    And last_seen is updated

  Scenario: Distinct client count is accurate across many signals
    Given pattern "shorten_booking_confirmation" has been seen in signals from clients A, B, A, C, B, A
    When the LearningWorker has processed all 6 signals
    Then recurrence_count is 6
    And distinct_clients is 3 (A, B, C — each counted once)

  Scenario: Recurrence update is scoped to the workspace
    Given workspace "ws-1" has pattern "remove_upsell_reminders" with recurrence_count 2
    And workspace "ws-2" independently has the same pattern_key with recurrence_count 1
    When a new signal for this pattern arrives in workspace "ws-1"
    Then workspace "ws-1" recurrence_count is incremented to 3
    And workspace "ws-2" recurrence_count remains 1
    And the two PatternRecurrence records are entirely independent

  Scenario: Concurrent signal processing does not lose counts
    Given two signals for the same pattern_key arrive simultaneously
    When both are processed by the LearningWorker
    Then recurrence_count reflects both increments (no lost updates)
    And distinct_clients is correct
```

#### Notes

- `distinct_clients` is recalculated from the source signals each time, not maintained as a simple counter. This avoids drift if signals are reprocessed or deleted.
- Concurrency safety: the `PatternRecurrence` update uses an atomic increment (e.g., `UPDATE ... SET recurrence_count = recurrence_count + 1`) or an optimistic lock. The worker processes signals sequentially per workspace to minimize contention, but concurrent processing must not lose updates.
- The `category` field on `PatternRecurrence` stores the primary `EditCategory`. If a pattern spans multiple categories (rare), the most frequent category is stored.
- Schema reference: Architecture spec 8.4 (`PatternRecurrence` type).

---

### US-F15-04: Promotion threshold check (LL-06)

**As a** workspace manager,
**I want** a pattern to be automatically flagged as a promotion candidate only when it meets the defined threshold (3+ occurrences, 2+ distinct clients, within a 30-day window),
**so that** one-off edits and single-client quirks do not pollute the workspace communication profile with noise.

#### Acceptance criteria

```gherkin
Feature: Promotion threshold evaluation

  Background:
    Given the LearningWorker has just updated a PatternRecurrence record
    And the promotion check runs immediately after each recurrence update

  Scenario: Pattern meets all three threshold criteria
    Given pattern "remove_upsell_reminders" has:
      | Field            | Value       |
      | recurrence_count | 3           |
      | distinct_clients | 2           |
      | first_seen       | 15 days ago |
      | last_seen        | today       |
      | promoted         | false       |
    When the promotion threshold check runs
    Then the pattern is flagged as a promotion candidate
    And the system proceeds to create a CommunicationRule (US-F15-05)

  Scenario: Pattern has enough occurrences but only one client
    Given pattern "soften_greeting_tone" has:
      | Field            | Value |
      | recurrence_count | 5     |
      | distinct_clients | 1     |
    When the promotion threshold check runs
    Then the pattern is NOT flagged for promotion
    And the pattern remains in tracking state
    And no CommunicationRule is created

  Scenario: Pattern has enough clients but fewer than 3 occurrences
    Given pattern "shorten_booking_confirmation" has:
      | Field            | Value |
      | recurrence_count | 2     |
      | distinct_clients | 2     |
    When the promotion threshold check runs
    Then the pattern is NOT flagged for promotion

  Scenario: Pattern exceeds the 30-day window
    Given pattern "tone_formalized" has:
      | Field            | Value        |
      | recurrence_count | 4            |
      | distinct_clients | 3            |
      | first_seen       | 45 days ago  |
      | last_seen        | 2 days ago   |
    When the promotion threshold check runs
    Then the 30-day window is evaluated from first_seen to last_seen
    And since all occurrences span more than 30 days, the window check fails
    Then the pattern is NOT flagged for promotion

  Scenario: Pattern accumulates signals within a rolling window
    Given pattern "cta_softened" was first seen 40 days ago (signal 1)
    And signals 2, 3, and 4 occurred within the last 20 days across 2 clients
    When the promotion threshold check evaluates the most recent 30-day window
    Then the check considers only signals within the last 30 days
    And since 3 signals from 2 clients fall within that window, the pattern qualifies
    And the pattern is flagged for promotion

  Scenario: Already-promoted pattern is not re-promoted
    Given pattern "remove_upsell_reminders" has promoted = true
    And a new signal for this pattern arrives, incrementing recurrence_count to 7
    When the promotion threshold check runs
    Then no new CommunicationRule is created
    And the existing rule remains unchanged
    And recurrence_count continues to be tracked for analytics

  Scenario: Pattern meets threshold at exactly the boundary values
    Given pattern "greeting_changed" has:
      | Field            | Value        |
      | recurrence_count | 3            |
      | distinct_clients | 2            |
      | first_seen       | 30 days ago  |
      | last_seen        | today        |
    When the promotion threshold check runs
    Then the pattern qualifies (thresholds are inclusive: >= 3, >= 2, <= 30 days)
    And the pattern is flagged for promotion
```

#### Notes

- The 30-day window is evaluated as a rolling window, not a fixed calendar window. The check considers whether enough qualifying signals exist within any 30-day span, anchored to the most recent signal. This prevents old, stale patterns from promoting while allowing recently active patterns to qualify even if the first signal was older.
- The promotion check is deterministic application code — no LLM is involved. It reads `PatternRecurrence` fields and applies the three threshold conditions.
- The thresholds (3 occurrences, 2 clients, 30 days) are defined as workspace configuration constants, not hardcoded. Post-MVP, workspace owners may adjust them.
- Schema reference: Architecture spec 8.4 (promotion rules table).

---

### US-F15-05: Communication rule creation from promoted pattern (LL-07)

**As a** workspace manager,
**I want** a promoted pattern to automatically produce a human-readable communication rule that is added to my workspace's communication profile,
**so that** recurring staff corrections are codified into persistent instructions that improve all future AI drafts without requiring manual configuration.

#### Acceptance criteria

```gherkin
Feature: Communication rule creation from promoted patterns

  Background:
    Given a pattern has been flagged for promotion by the threshold check (US-F15-04)
    And the PatternRecurrence record has promoted = false

  Scenario: Rule is created from a promoted pattern
    Given pattern "remove_upsell_reminders" with category "upsell_removed" has met the promotion threshold
    When the system creates a CommunicationRule
    Then a new CommunicationRule record is created with:
      | Field              | Value                                                      |
      | rule_id            | a new UUID                                                 |
      | workspace_id       | the workspace UUID                                         |
      | category           | upsell_removed                                             |
      | instruction        | a human-readable instruction (e.g., "Do not include upsell or cross-sell language in appointment reminders") |
      | confidence         | a value derived from recurrence_count (higher count = higher confidence) |
      | source_pattern_key | remove_upsell_reminders                                    |
      | promoted_at        | the current UTC timestamp                                  |
      | active             | true                                                       |
    And the PatternRecurrence record is updated with promoted = true and promoted_at set
    And the WorkspaceCommunicationProfile's updated_at timestamp is refreshed

  Scenario: Instruction text is human-readable and actionable
    Given pattern "shorten_booking_confirmation" with category "shortened" is promoted
    When the CommunicationRule is created
    Then the instruction field contains a clear, imperative sentence
    And the instruction is specific enough for the LLM to act on (e.g., "Keep booking confirmation replies concise — under 3 sentences for routine confirmations")
    And the instruction does not reference internal system concepts (pattern keys, signal IDs, recurrence counts)

  Scenario: Instruction is generated from representative edit examples
    Given pattern "soften_greeting_tone" has 4 source signals
    When the system generates the instruction text
    Then the LLM is provided with 2-3 representative original_draft / final_version pairs from the source signals
    And the LLM produces an instruction that generalizes the common edit pattern
    And the instruction is stored verbatim as the rule instruction

  Scenario: Rule is added to the WorkspaceCommunicationProfile
    Given the workspace already has 2 active communication rules
    When a new CommunicationRule is created
    Then the WorkspaceCommunicationProfile contains 3 active rules
    And all 3 rules will be loaded during the next context assembly (US-F15-06)

  Scenario: Duplicate rule prevention
    Given a CommunicationRule already exists with source_pattern_key "remove_upsell_reminders"
    And the same pattern somehow triggers promotion again
    When the system attempts to create a rule
    Then no duplicate rule is created
    And the existing rule remains unchanged
    And a log entry records the duplicate prevention

  Scenario: Confidence score reflects recurrence strength
    Given pattern A has recurrence_count 3 and distinct_clients 2
    And pattern B has recurrence_count 12 and distinct_clients 6
    When both are promoted to rules
    Then pattern B's rule has a higher confidence value than pattern A's rule
    And confidence is a number between 0 and 1
```

#### Notes

- The rule `instruction` is generated by an LLM call that receives 2-3 representative edit pairs from the pattern's source signals. This is a one-time generation at promotion time, not a per-draft call.
- The instruction must be written in the imperative voice, addressed to the AI drafter (e.g., "Always offer 2-3 scheduling options" not "The staff prefers multiple scheduling options"). This matches how tone profile and SOP rules are phrased in the system prompt.
- Confidence is calculated as `min(1.0, recurrence_count / 10)` — a simple linear scale capped at 1.0. Post-MVP, more sophisticated confidence models may incorporate distinct_clients weight and signal severity.
- The `WorkspaceCommunicationProfile` is a lightweight wrapper around the `CommunicationRule` table rows for the workspace. It does not duplicate data — `rules` is a query result, not a denormalized array.
- Schema reference: Architecture spec 8.5 (`CommunicationRule`, `WorkspaceCommunicationProfile` types).

---

### US-F15-06: Rule injection into context assembly (LL-08)

**As a** staff member handling client conversations,
**I want** all active communication rules to be automatically included in the AI's context for every draft it generates,
**so that** the AI learns from our team's collective editing patterns and produces drafts that reflect our actual communication preferences — without me having to repeat the same corrections.

#### Acceptance criteria

```gherkin
Feature: Communication rules injected into Client Worker context

  Background:
    Given workspace "ws-abc" has a WorkspaceCommunicationProfile
    And the profile contains active CommunicationRule records

  Scenario: Active rules are included in the global context section
    Given workspace "ws-abc" has 3 active communication rules:
      | instruction                                                             |
      | Keep booking confirmation replies concise — under 3 sentences           |
      | Always offer 2-3 scheduling options, not just one                       |
      | Do not include upsell language in appointment reminders                 |
    When context assembly runs for any client in workspace "ws-abc"
    Then the assembled context includes a "Learned Communication Preferences" section
    And all 3 rule instructions are listed in that section
    And the section appears after the tone profile and before client-scoped context
    And the total token usage for the learned preferences section does not exceed ~500 tokens

  Scenario: Disabled rules are excluded from context
    Given workspace "ws-abc" has 4 communication rules, but 1 has active = false
    When context assembly runs
    Then only the 3 active rules are included in the context
    And the disabled rule's instruction does not appear in the assembled context

  Scenario: Rules are formatted as system prompt instructions
    Given 2 active rules exist
    When the rules are injected into the context
    Then each rule is formatted as a bullet point or numbered instruction
    And the rules are prefixed with a section header (e.g., "## Learned Communication Preferences")
    And the format matches the existing tone profile and SOP rule formatting conventions

  Scenario: No rules exist yet (new workspace or pre-learning-loop)
    Given workspace "ws-abc" has no WorkspaceCommunicationProfile or zero active rules
    When context assembly runs
    Then the "Learned Communication Preferences" section is omitted entirely
    And no placeholder text is inserted
    And the token budget for this section is not reallocated
    And context assembly completes without error

  Scenario: Rules are identical across all clients in the workspace
    Given workspace "ws-abc" has 2 active rules
    When context assembly runs for Client A and then for Client B
    Then the "Learned Communication Preferences" section is byte-identical in both contexts
    And the rules are part of the cacheable global context (not the client-scoped section)

  Scenario: Context budget is respected when many rules exist
    Given workspace "ws-abc" has 15 active communication rules totaling ~800 tokens
    When context assembly runs
    Then rules are included up to the ~500 token budget
    And rules are prioritized by confidence score (highest confidence first)
    And rules that exceed the budget are omitted
    And a warning is logged indicating rule truncation

  Scenario: Newly created rule appears in the next draft
    Given a CommunicationRule was just created and committed to the database
    When the next inbound client message triggers context assembly
    Then the new rule is included in the assembled context
    And the Client Worker's draft reflects the new instruction
```

#### Notes

- Rules are part of the global context section (architecture spec 2.1, section 2). They are assembled deterministically alongside workspace config, vertical config, and tone profile. The context assembler queries `CommunicationRule WHERE workspace_id = ? AND active = true ORDER BY confidence DESC`.
- The ~500 token budget for learned preferences is defined in the context assembly token allocation (architecture spec 3.3). If the workspace has few rules, the unused budget is not reallocated to other sections.
- Rules are cached with the global context for the duration of a workspace's processing batch. A new rule created mid-batch will appear in the next batch, not mid-flight.
- This story integrates with F-05 (Context Assembly) story F05-S01, which already has a scenario for loading learned communication preferences. F-15's implementation fulfills the data that F-05 consumes.
- Schema reference: Architecture spec 8.5, 8.6 (the full loop diagram shows rules flowing into context assembly).

---

### US-F15-07: Staff rule management in Settings (no PRD function — UI requirement from architecture spec 8.7)

**As a** workspace owner or staff member,
**I want** to view, edit, and disable communication rules that the system has learned from our editing patterns,
**so that** I maintain control over the AI's behavior — I can refine imprecise rules, disable rules that no longer apply, and understand why the AI drafts the way it does.

#### Acceptance criteria

```gherkin
Feature: Staff management of communication rules in Settings

  Background:
    Given the staff member is authenticated and viewing the Settings page
    And the workspace has at least one CommunicationRule

  Scenario: Staff views the list of communication rules
    When the staff member navigates to Settings > Communication Rules
    Then a list of all communication rules for the workspace is displayed
    And each rule shows:
      | Field              | Display                                              |
      | instruction        | the human-readable rule text                         |
      | category           | a readable label (e.g., "Tone" for tone_softened)    |
      | confidence         | displayed as a percentage or strength indicator       |
      | promoted_at        | the date the rule was created                        |
      | active             | a toggle switch showing on/off state                 |
    And rules are sorted by promoted_at (newest first) by default
    And the total count of rules is displayed

  Scenario: Staff disables a rule
    Given a rule "Do not include upsell language in appointment reminders" is active
    When the staff member toggles the active switch to off
    Then the rule's active field is set to false in the database
    And the rule is visually dimmed or moved to a "Disabled" section
    And the next context assembly for any client in this workspace excludes this rule
    And an audit event is recorded: actor=staff, action=rule_disabled, rule_id

  Scenario: Staff re-enables a previously disabled rule
    Given a rule was disabled by staff
    When the staff member toggles the active switch back to on
    Then the rule's active field is set to true
    And the rule reappears in the active rules list
    And subsequent context assemblies include this rule again
    And an audit event is recorded: actor=staff, action=rule_enabled, rule_id

  Scenario: Staff edits a rule's instruction text
    Given a rule with instruction "Keep replies concise — under 3 sentences"
    When the staff member clicks "Edit" on the rule
    Then the instruction text becomes editable in an inline text field
    When the staff member changes it to "Keep replies concise — under 2 sentences for routine messages, up to 5 for complex topics"
    And clicks "Save"
    Then the rule's instruction is updated in the database
    And the updated instruction is used in all subsequent context assemblies
    And an audit event is recorded with the before and after instruction text

  Scenario: Staff cannot edit system fields
    Given a rule is displayed in the Settings page
    Then the category, source_pattern_key, confidence, and promoted_at fields are read-only
    And only the instruction text and active toggle are editable by staff

  Scenario: Empty state when no rules exist
    Given the workspace has no communication rules (Phase 4 learning loop has not promoted any patterns yet)
    When the staff member navigates to Settings > Communication Rules
    Then an empty state is displayed with an explanation:
      "No communication rules yet. As your team edits AI drafts, the system will detect patterns and suggest rules to improve future drafts."
    And no error is shown

  Scenario: Staff views the source pattern behind a rule
    Given a rule was promoted from pattern "remove_upsell_reminders"
    When the staff member clicks "View details" or expands the rule
    Then the rule detail shows:
      | Detail              | Value                                            |
      | source pattern      | the pattern_key                                  |
      | times detected      | the recurrence_count at promotion time           |
      | clients affected    | the distinct_clients count at promotion time     |
      | example edits       | 1-2 representative original/final pairs          |
    And this helps the staff member understand why the rule was created
```

#### Notes

- The Settings > Communication Rules page is the primary governance surface for the learning loop. It implements the self-improving-agent principle that "promotion is a suggestion, not an irreversible commitment" (architecture spec 8.7, point 5).
- All mutations (enable, disable, edit) produce audit events via F-04 (Notifications & Audit Foundation). The audit trail tracks who changed what and when.
- The "example edits" in the detail view are stored at promotion time (2-3 representative signal pairs are snapshotted). They are not live queries against the signal table.
- Rule editing does not retroactively change past drafts — it only affects future context assemblies.
- Post-MVP consideration: bulk actions (disable all tone rules, export rules) and rule categories/filters.

---

### US-F15-08: Staff explicit "always do this" flag for immediate promotion (architecture spec 8.4)

**As a** staff member who just made a deliberate, important edit to an AI draft,
**I want** to flag my edit as "always do this" so it is immediately promoted to a workspace communication rule,
**so that** I don't have to wait for the system to detect the pattern 3 times across 2 clients — I can teach the AI a new rule in a single action when I know it should apply universally.

#### Acceptance criteria

```gherkin
Feature: Immediate rule promotion via staff "always do this" flag

  Background:
    Given a staff member has edited an AI draft and is about to send it
    And the edited text differs from the original draft

  Scenario: Staff flags an edit as "always do this" at send time
    Given the staff member has edited a draft (original_draft differs from final_version)
    And an "Always do this" checkbox or button is visible next to the Send button
    When the staff member checks "Always do this" and clicks "Send"
    Then the DraftEditSignal is recorded with staff_action "edited_and_sent" as normal
    And the signal is additionally flagged with always_do_this = true
    And the LearningWorker prioritizes this signal for immediate classification

  Scenario: Flagged edit bypasses the standard promotion threshold
    Given a signal with always_do_this = true has been classified by the LearningWorker
    And the classification produced edit_categories and a pattern_key
    When the promotion check runs for this signal
    Then the pattern is immediately promoted regardless of recurrence_count, distinct_clients, or time window
    And a CommunicationRule is created with:
      | Field              | Value                                    |
      | source_pattern_key | the assigned pattern_key                 |
      | confidence         | 0.5 (lower than threshold-promoted rules to reflect single-signal basis) |
      | active             | true                                     |
    And the PatternRecurrence record is created or updated with promoted = true

  Scenario: "Always do this" is only available when the draft was edited
    Given the staff member is viewing a draft they have not modified
    Then the "Always do this" option is not visible or is disabled
    And the tooltip explains: "Edit the draft first, then flag your change as a permanent rule"

  Scenario: Flagged edit produces a rule with instruction from the single edit
    Given the staff member flagged an edit that changed "Dear valued customer" to "Hi there!"
    When the LearningWorker classifies and promotes this signal
    Then the generated instruction reflects this specific edit (e.g., "Use casual, friendly greetings instead of formal salutations")
    And the instruction is generated by the same LLM call that produces instructions for threshold-promoted rules

  Scenario: "Always do this" rule appears in Settings immediately
    Given a staff member flagged an edit 30 seconds ago
    And the LearningWorker has processed the signal
    When the staff member navigates to Settings > Communication Rules
    Then the new rule appears in the list with a badge or label indicating "Staff-created"
    And the rule is editable and disableable like any other rule

  Scenario: "Always do this" on an edit that matches an existing pattern
    Given pattern "soften_greeting_tone" already exists with recurrence_count 2 (below threshold)
    And the staff member edits a draft in the same pattern and flags "always do this"
    When the signal is classified and receives pattern_key "soften_greeting_tone"
    Then the existing PatternRecurrence is updated and promoted
    And a CommunicationRule is created using the existing pattern data
    And the rule benefits from the additional context of prior signals (not just the flagged one)

  Scenario: Explicit flag does not suppress future signal collection
    Given a rule was created via "always do this" for pattern "remove_upsell_reminders"
    And staff subsequently edit drafts in the same pattern
    When those signals are classified
    Then the PatternRecurrence recurrence_count continues to increment
    And the rule's confidence may be updated upward as more signals confirm the pattern
```

#### Notes

- The "always do this" flag is the escape hatch for staff who know a correction should be universal. It maps directly to the self-improving-agent's principle of allowing explicit promotion alongside automatic promotion (architecture spec 8.4, third row of the promotion rules table).
- The initial confidence of 0.5 for staff-flagged rules is intentionally lower than threshold-promoted rules (which have more supporting evidence). As the pattern recurs naturally, the confidence increases.
- The flag is a UI-level addition to the send flow. It adds one boolean field (`always_do_this`) to the `DraftEditSignal` record. No new tables are required.
- The LearningWorker processes `always_do_this = true` signals with higher priority (e.g., separate higher-priority BullMQ queue or priority flag) to minimize the delay between flagging and rule creation.
- Post-MVP: the "always do this" concept could extend to "always do this for *this client*" (client-level preference) vs. "always do this for *everyone*" (workspace-level rule). MVP treats all flags as workspace-level.

---

## Story map summary

| Story | PRD Function | Summary | Actor | Priority |
|---|---|---|---|---|
| US-F15-01 | LL-03 | Async LLM classification of edit type | System (LearningWorker) | Must-have |
| US-F15-02 | LL-04 | Stable pattern key assignment for recurrence tracking | System (LearningWorker) | Must-have |
| US-F15-03 | LL-05 | Recurrence count and distinct client tracking | System (LearningWorker) | Must-have |
| US-F15-04 | LL-06 | Promotion threshold check (3+/2+/30d) | System (deterministic) | Must-have |
| US-F15-05 | LL-07 | Communication rule creation from promoted pattern | System (LearningWorker + deterministic) | Must-have |
| US-F15-06 | LL-08 | Rule injection into context assembly | System (ContextAssembler) | Must-have |
| US-F15-07 | — (UI) | Staff views, edits, and disables rules in Settings | Staff / Owner | Must-have |
| US-F15-08 | — (arch 8.4) | Staff "always do this" explicit flag for immediate promotion | Staff | Should-have |

All stories except US-F15-08 are must-haves for the learning loop to function end-to-end. US-F15-08 is a should-have that provides a valuable shortcut but is not required for the automatic promotion path to work.

## Implementation sequence

```
US-F15-01 + US-F15-02  (classification + key assignment — single LLM call)
        │
        v
US-F15-03  (recurrence tracking — depends on classified signals)
        │
        v
US-F15-04  (threshold check — depends on recurrence data)
        │
        v
US-F15-05  (rule creation — depends on promotion candidates)
        │
        v
US-F15-06  (context injection — depends on rules existing)
        │
        v
US-F15-07  (Settings UI — can start in parallel with US-F15-06)
        │
        v
US-F15-08  (explicit flag — depends on US-F15-01 through US-F15-05)
```

## Open questions

1. **Pattern key drift over time** — As the workspace accumulates many pattern keys, the LLM prompt that includes existing keys for stability may become large. Should we cap the number of keys sent to the LLM (e.g., top 50 by recurrence count), or paginate by category? Engineering to decide before implementation.

2. **Rule instruction quality** — The instruction text is generated by a one-time LLM call at promotion time. If the representative edit examples are not diverse enough, the instruction may be too narrow or too broad. Should we allow the LearningWorker to regenerate the instruction if more signals accumulate after promotion? Or is staff editing in Settings sufficient?

3. **Rolling window implementation** — US-F15-04 specifies a 30-day rolling window. The simplest implementation checks `last_seen - first_seen <= 30 days`, but this penalizes patterns that had an early outlier signal. The alternative (checking whether 3+ signals exist within any 30-day sub-window) is more complex. Engineering to decide which semantics to implement.

4. **Confidence updates post-promotion** — US-F15-08 mentions that confidence "may be updated upward" as more signals confirm the pattern. Should the system actively update rule confidence as recurrence_count grows, or is confidence static after creation? If dynamic, what triggers the update — every new signal, or a periodic batch?

5. **Cross-category pattern merging** — If two pattern keys represent the same underlying preference (e.g., "soften_greeting" and "warm_opening_tone"), should the system detect and merge them? This is likely a post-MVP concern, but engineering should flag if the schema makes merging difficult later.

6. **Token budget pressure** — The ~500 token budget for learned preferences (architecture spec 3.3) limits the number of active rules. With an average of ~30 tokens per rule instruction, this caps at roughly 15-16 rules before truncation. Is this sufficient for mature workspaces? Should the budget be configurable?
