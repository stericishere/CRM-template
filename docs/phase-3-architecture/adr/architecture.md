# DEMO-suit Architecture Specification v1.0

**System:** WhatsApp-First AI Client Ops Manager
**Pilot vertical:** Bespoke & made-to-measure suit businesses
**Status:** Architecture — ready for engineering review
**Companion documents:** PRD v1.1, OpenClaw Session Isolation Research

---

## 1. Architectural principles

### 1.1 Core rule

**The agent may think, retrieve, draft, and propose. Only deterministic application services may commit writes.**

This is the single load-bearing constraint. Every design decision follows from it.

### 1.2 Guiding decisions

| Principle | Implementation |
|---|---|
| Single agent with tools, not multi-agent | One LLM invocation per client message. Knowledge search and scheduling are tools, not workers. |
| Context assembly is deterministic code | A pure function `(workspaceId, clientId) → ReadOnlyContext` runs before the LLM. The model never chooses what data to load. |
| Session isolation by construction | The Client Worker receives only one client's data. Cross-client data never enters the context window. |
| Structured records over conversational memory | Important facts live in typed database fields. Summaries and chat history are supplementary. |
| Approval boundary before all mutations | Every write passes through policy evaluation. Staff confirms anything beyond auto-allowed actions. |
| Daily compaction on schedule | Not triggered by context window pressure. Simpler, more predictable, and cheaper than OpenClaw's reactive model. |

### 1.3 What this architecture is not

This is not a multi-agent orchestration system. The original architecture document proposed a COS dispatching to ClientWorker, SchedulingWorker, KnowledgeWorker, and WorkspaceWorker — each as separate LLM calls. That design is rejected for MVP because it multiplies LLM cost per message, adds latency, and conflicts with the PRD's explicit "single orchestrated agent with tool calling" decision (§7.2).

---

## 2. System topology

### 2.1 System hierarchy

The COS sits on top as the manager of the whole system. Below it, per-client workers handle individual conversations. On the side, a global toolkit provides shared capabilities that both the COS and workers can access.

**COS (chief of staff) — the manager layer**

The COS is the system's operational manager. It has cross-client visibility: it runs daily crons, identifies which clients need attention, prioritizes the staff's queue, and dispatches Client Worker invocations. It works from structured records only (follow-ups, bookings, lifecycle statuses) — it never reads individual client messages or memory.

Triggered by: daily cron, staff asking "who needs follow-up today?", staff requesting today's overview.

**Client Workers — per-client, isolated**

Each Client Worker is a single LLM call scoped to exactly one client. It drafts replies, proposes booking actions, summarizes context, and suggests follow-ups. Multiple workers can run concurrently for different clients, but each only sees its own client's data.

Triggered by: inbound client message, staff requesting a draft, staff reprompting, COS dispatching a follow-up task.

**Global toolkit — shared resources accessible to both**

The global toolkit contains resources scoped at the workspace level, not the client level. Both the COS and Client Workers can access these:

| Resource | Scope | Type |
|---|---|---|
| Knowledge search | Workspace | Tool — FAQs, pricing, policies |
| Google Calendar | Workspace | Tool — availability, event CRUD |
| Learned preferences (workspace communication profile) | Workspace | Context — "concise replies preferred", "avoid upsell tone" |
| Vertical fields / SOP | Workspace | Context — measurement template, appointment sequence rules |
| Tone profile | Workspace | Context — brand voice configuration |

These are **global** — they apply to every client interaction, not to a specific client.

**Per-client context — isolated, never shared**

These are the only resources that differ between workers:

| Resource | Scope | Loaded by |
|---|---|---|
| Client profile + notes | This client only | Context assembly |
| Compact summary | This client only | Context assembly |
| Recent messages | This client only | Context assembly |
| Active bookings + follow-ups | This client only | Context assembly |

The isolation boundary is enforced by context assembly: global resources are loaded from workspace config, per-client resources are loaded by `workspace_id + client_id` scoped queries. A Client Worker receives both, but the per-client portion is unique to its session.

### 2.2 Message processing pipeline

```
WhatsApp Web protocol (QR-paired session)
        │
        v
  Message listener (WhatsApp Web events)
        │
        v
  Durable message queue (BullMQ/Redis)
        │                              ← Ordering, deduplication, retry
        v
  Worker process (dequeue)
        │
        ├─→ Phone number normalization
        ├─→ Client lookup or create
        ├─→ Media pre-processing (voice note transcription, image storage)
        ├─→ WhatsApp session health check
        │
        v
  Session key resolution
        │         workspace:{workspace_id}:client:{client_id}
        v
  Context assembly (deterministic, no LLM)
        │
        v
  Client Worker invocation (single LLM call + tools)
        │
        v
  Proposed outcome (draft + proposed actions)
        │
        v
  Approval policy evaluation
        │
        ├─→ Auto-allowed → execute immediately, audit log
        ├─→ Requires review → create ConfirmationRequest, notify staff
        └─→ Human-only → flag for manual handling, skip draft
        │
        v
  Staff notification (push + in-app badge)
```

---

## 3. Session isolation model

Adapted from OpenClaw's session management architecture. OpenClaw uses `dmScope: "per-channel-peer"` to create separate conversation contexts per sender. Our system adapts this for a multi-tenant, multi-client context where isolation is enforced by database queries rather than filesystem scoping.

### 3.1 Session key scheme

Every client interaction resolves to a deterministic session key:

```
workspace:{workspace_id}:client:{client_id}
```

This key is the isolation boundary. It determines:
- Which client profile is loaded
- Which conversation history is included
- Which memory records (compact summary + daily logs) are assembled
- Which follow-ups, bookings, and notes appear in context

In OpenClaw, the session key routes to a transcript file. In our system, the session key parameterizes a set of database queries — all scoped by `workspace_id` AND `client_id`.

### 3.2 Context assembly

Context assembly is a deterministic function executed before the LLM is invoked. It is not an LLM operation. The agent cannot influence what data it receives.

```typescript
type ClientSessionContext = {
  // Identity
  sessionKey: string;                    // workspace:{id}:client:{id}

  // ── GLOBAL (workspace-level, same for every client worker) ──
  workspace: WorkspaceConfig;            // timezone, business_hours, booking_rules, tone_profile
  verticalConfig: VerticalConfig;        // SOP: custom fields, appointment sequences, measurement template
  workspaceCommunicationProfile: CommunicationProfile | null;  // learned from edit-loop
  knowledgeContext: string[];            // pre-retrieved knowledge chunks (semantic search on inbound message)

  // ── CLIENT-SCOPED (this client only, the isolation boundary) ──
  client: ClientProfile;                 // name, phone, lifecycle_status, tags, preferences
  conversationState: ConversationState;  // idle, booking_in_progress, awaiting_client_reply, etc.
  compactSummary: string | null;         // latest compact_summary from Memory table
  recentMessages: Message[];             // last ~10 messages (recent conversation window)
  activeBookings: Booking[];             // upcoming/confirmed bookings for this client
  activeFollowUps: FollowUp[];           // open/pending follow-ups for this client
  recentNotes: Note[];                   // last N notes for this client

  // The inbound message being processed
  inboundMessage: InboundMessage;
};
```

**Scoping rules:**

The global section (workspace config, vertical config/SOP, learned preferences, knowledge base) is the same for every client worker invocation within a workspace. These are the "global toolkit" — shared business knowledge and operational rules.

The client-scoped section is the isolation boundary. Each worker sees only its own client's profile, compact summary, recent messages (last ~10), notes, follow-ups, and bookings. This data never crosses between workers.

**What is explicitly excluded from context assembly:**
- Any other client's profile, messages, notes, bookings, or memory
- Cross-client queries or aggregations
- Full conversation history (only last ~10 messages; older history is captured in the compact summary)
- Staff-to-staff internal communications

### 3.3 Assembly order and token budget

Context is assembled in a fixed order with explicit token allocation. This mirrors OpenClaw's `buildAgentSystemPrompt()` approach where bootstrap files are injected in a deterministic order with per-file character caps.

| Section | Scope | Source | Token budget | Truncation strategy |
|---|---|---|---|---|
| 1. System prompt | Global | Static template + workspace tone profile | ~1,500 | None (fixed) |
| 2. Tool definitions | Global | Static definitions for all available tools | ~800 | None (fixed) |
| 3. Vertical config / SOP | Global | Workspace `vertical_config` (field defs, appointment rules) | ~500 | None (fixed per workspace) |
| 4. Learned preferences | Global | Workspace communication profile from edit-loop | ~500 | Omit if empty |
| 5. Knowledge chunks | Global | Semantic search results for inbound message | ~2,000 | Top-K by relevance score |
| 6. Client profile | Client | Client record + custom field values | ~500 | Omit least-recent tags |
| 7. Compact summary | Client | Latest `compact_summary` from Memory table | ~2,000 | Truncate oldest sections |
| 8. Active items | Client | Bookings + follow-ups + recent notes | ~1,000 | Cap at 5 most recent per category |
| 9. Conversation state | Client | Current state enum + transition context | ~100 | None (fixed) |
| 10. Recent messages | Client | Last ~10 messages (recent conversation window) | ~3,000 | Hard cap at 10 messages |
| 11. Inbound message | Client | The message being processed | Variable | None |

**Total budget:** ~12,000 tokens of context per invocation. Global sections are cached/reused across client workers within the same workspace. Client sections are assembled fresh per invocation.

### 3.4 Isolation enforcement

Isolation is enforced at three levels, following the defense-in-depth lesson from OpenClaw's IDOR vulnerability (Issue #11793, where HTTP endpoints accepted arbitrary session keys without ownership validation):

**Level 1: Query scoping.** Every database query in context assembly includes `WHERE workspace_id = $1 AND client_id = $2`. There is no query path that returns another client's data.

**Level 2: Tool scoping.** Every tool the Client Worker can call receives `clientId` and `workspaceId` as fixed parameters injected by the runtime — not passed by the LLM. The LLM cannot override these parameters. If the model outputs a tool call with a different client ID, the runtime rejects it.

**Level 3: Audit logging.** Every context assembly, tool call, and proposed action is logged with the session key. Cross-client access attempts (should they occur through a bug) are detectable in the audit trail.

### 3.5 Concurrency control

OpenClaw uses file-based locking (`session-write-lock.ts`) to serialize access to session transcripts. Our system uses database-level concurrency control:

**Conversation-level optimistic locking.** The `Conversation` record carries a `version` field. When the worker begins processing, it reads the current version. When it writes results (updated summary, new draft, state transition), it uses `UPDATE ... WHERE version = $expected_version`. If another process modified the conversation concurrently, the update fails and the worker retries with fresh context.

**Message queue ordering.** BullMQ processes messages for the same client sequentially (using the session key as the queue group key). This prevents two inbound messages from the same client being processed concurrently by different workers.

---

## 4. Client Worker specification

### 4.1 What the Client Worker is

A single LLM invocation (one API call) with tool-calling capability. It receives a fully-assembled read-only context and a set of typed tools. It returns a response that may include text (the draft reply) and tool calls (proposed actions).

It is the equivalent of OpenClaw's agent runtime executing a single turn: context assembly → LLM call → tool execution loop → response. The key difference is that our tools never commit writes directly — they return `ProposedAction` objects that pass through the approval boundary.

### 4.2 System prompt structure

The system prompt is composed from workspace configuration at assembly time. It is not a static file.

```
# Role
You are the client operations assistant for {workspace.business_name}.
You help staff manage client conversations, schedule appointments,
and maintain client context. You draft replies for staff to review
before sending. You never send messages directly to clients.

# Tone
{workspace.tone_profile}

# Behavior rules
- Use the client profile and conversation summary before searching knowledge.
- If you don't know something, say so. Do not guess.
- When proposing a booking, always check availability first.
- When referencing business policies or pricing, cite the knowledge source.
- Never mention other clients or cross-reference client data.
- All draft replies are for staff review. Draft in the voice of the business, not as an AI.

# Current client context
{assembled context sections 3-7 from §3.3}

# Conversation history
{assembled context sections 8-9 from §3.3}
```

### 4.3 Tool inventory

Each tool has a fixed `authority` level (read, propose_write, or auto_write) that determines whether its output passes through approval.

| Tool | Authority | Input (from LLM) | Fixed params (from runtime) | Output |
|---|---|---|---|---|
| `knowledge_search` | read | `query: string` | `workspaceId` | Relevant chunks with source attribution |
| `calendar_query` | read | `dateRange, appointmentType` | `workspaceId, calendarConfig` | Available time slots |
| `calendar_book` | propose_write | `slotId, appointmentType, notes` | `workspaceId, clientId` | `ProposedAction<BookingCreate>` |
| `update_client_record` | propose_write | `changes: FieldChanges` | `workspaceId, clientId` | `ProposedAction<ClientUpdate>` |
| `create_note` | auto_write | `content: string, type: NoteType` | `workspaceId, clientId, source: "ai_extracted"` | `NoteId` (saved immediately, audit logged) |
| `create_followup` | propose_write | `description, dueDate?` | `workspaceId, clientId` | `ProposedAction<FollowUpCreate>` |

**Tools the Client Worker does NOT have:**
- Any tool that queries across clients
- Any tool that reads another client's data
- Any tool that sends messages directly (only draft generation)
- Any tool that modifies workspace-level settings

### 4.4 Tool parameter injection

This is the critical safety mechanism. When the Client Worker outputs a tool call, the runtime injects `workspaceId` and `clientId` from the session key before executing the tool. The LLM cannot override these values.

```typescript
async function executeToolCall(
  call: LLMToolCall,
  session: ClientSessionContext
): Promise<ToolResult> {
  const tool = toolRegistry.get(call.toolName);

  // Inject session-scoped params — LLM cannot override these
  const params = {
    ...call.arguments,                        // LLM-provided params
    workspaceId: session.workspace.id,        // Runtime-injected (immutable)
    clientId: session.client.id,              // Runtime-injected (immutable)
  };

  // Validate LLM-provided params against tool schema
  const validated = tool.inputSchema.parse(params);

  return tool.execute(validated);
}
```

### 4.5 Draft generation

The Client Worker's primary output is a draft reply. This is not a tool call — it's the model's text response. The draft is:

1. Saved to the `Draft` table with `intent_classified`, `confidence_score`, and `knowledge_sources_used`.
2. If confidence is below threshold or intent matches human-only categories, the draft is skipped and the conversation is flagged for manual handling.
3. Otherwise, staff is notified that a draft is ready for review.

### 4.6 Reprompting

When staff reprompts (e.g., "make it shorter", "include the Saturday option"), the system makes a new LLM call with the same assembled context plus the staff's instruction appended. The previous draft is included in the conversation history. This replaces the draft — the old one is preserved in audit only.

---

## 5. COS operations specification

### 5.1 What the COS is

A separate LLM invocation path for workspace-level operations. It never receives a single client's conversational context. It works from structured records only.

### 5.2 Trigger paths

| Trigger | Input | Output |
|---|---|---|
| Daily cron (per workspace timezone) | All open follow-ups, stale conversations, unconfirmed bookings | Ranked action list + follow-up draft queue |
| Staff query: "who needs follow-up?" | Same as above, on-demand | Ranked list with client names and reasons |
| Staff query: "what's today's schedule?" | Today's bookings across all clients | Schedule summary |

### 5.3 COS context assembly

The COS assembles a different context than the Client Worker:

```typescript
type COSOperationsContext = {
  workspace: WorkspaceConfig;
  overdueFollowUps: Array<{ clientName, followUpContent, dueDate, daysPastDue }>;
  staleConversations: Array<{ clientName, lastMessageAt, conversationState, daysSinceContact }>;
  todayBookings: Array<{ clientName, appointmentType, startTime, confirmationStatus }>;
  atRiskBookings: Array<{ clientName, appointmentType, startTime, reason }>;
};
```

Note: this contains client names and operational metadata, but never conversational content, messages, or client-specific memory. The COS cannot read what a client said — only that a follow-up is overdue or a booking is unconfirmed.

### 5.4 COS outputs

The COS produces:
- A ranked list of "next actions" for staff (displayed in the Today's View)
- Draft follow-up messages queued for Client Worker generation (each follow-up is processed through the normal Client Worker path with full per-client context)

The COS does NOT draft messages itself. It identifies which clients need attention, then the system uses the Client Worker (with proper per-client context) to generate the actual drafts.

---

## 6. Memory and compaction

Adapted from OpenClaw's two-layer memory model (`MEMORY.md` + `memory/YYYY-MM-DD.md`), translated to database-backed records.

### 6.1 Memory layers

| Layer | OpenClaw equivalent | Our implementation | Purpose |
|---|---|---|---|
| Compact summary | `MEMORY.md` | `Memory` record, `type: compact_summary` | Curated, durable context. Loaded every invocation. |
| Daily log | `memory/YYYY-MM-DD.md` | Raw messages since last compaction | Recent conversational context. Dropped after compaction. |
| Structured records | No equivalent (OpenClaw is single-user) | Client profile, notes, follow-ups, bookings | Typed facts that survive compaction without summarization. |

### 6.2 Compaction cycle

OpenClaw compacts reactively when the context window fills. Our system compacts on a daily schedule, which is simpler for a multi-tenant system.

```
Daily cron (timed to workspace timezone)
  │
  ├─ For each client with activity since last compaction:
  │     │
  │     ├─ 1. Ensure all async AI categorization of notes is complete
  │     │     (this is our equivalent of OpenClaw's flush-before-compact)
  │     │
  │     ├─ 2. Load existing compact summary + messages since last compaction
  │     │
  │     ├─ 3. LLM call: generate updated compact summary
  │     │     Input:  existing summary + new messages
  │     │     Output: updated summary text
  │     │     (This is a SEPARATE, cheap summarization call — not the Client Worker)
  │     │
  │     ├─ 4. Write new Memory record (type: compact_summary, version: N+1)
  │     │
  │     └─ 5. Update client.summary field with latest version
  │
  └─ For each client needing follow-up:
        │
        └─ Queue Client Worker invocations to generate follow-up drafts
```

### 6.3 The flush-before-compact invariant

OpenClaw's most important memory pattern: before compaction, persist everything that must survive.

In OpenClaw, this is a silent agent turn that writes to `memory/YYYY-MM-DD.md`. In our system, the equivalent is ensuring that async note categorization (§9.3 of the PRD) has completed before the compaction job runs for that client. Specifically:

1. When a message is processed, the system may extract notes or follow-ups asynchronously.
2. These extractions are written to the `Note` and `FollowUp` tables.
3. The compaction job checks that all pending extractions for the client are resolved before compacting.
4. If pending extractions exist, the compaction for that client is deferred to the next cycle.

This ensures that information identified as important during conversation processing is durably stored in structured records before the raw messages are summarized away.

### 6.4 What compaction preserves vs. discards

| Preserved (survives compaction) | Discarded (replaced by summary) |
|---|---|
| Client profile fields | Individual message content |
| All notes (staff and AI-extracted) | Exact wording of conversations |
| All follow-ups and promises | Tool call details from agent invocations |
| All booking records | Draft iterations |
| Lifecycle status | Media transcriptions (original media retained) |
| Compact summary (updated version) | Previous compact summary version |

---

## 7. Approval boundary

### 7.1 Trust tiers (from PRD §8)

| Tier | Actions | Agent behavior |
|---|---|---|
| **Auto-allowed** | Update `last_contacted_at`, append conversation summary, save AI-extracted note, attach low-risk tags, propose time slots (read-only) | Agent executes via auto_write tools. Logged in audit. |
| **Suggest for review** | Change client name, change appointment details, add preferences, log promises with deadlines, modify lifecycle status, update sensitive notes, draft replies, propose follow-up actions, create bookings | Agent returns `ProposedAction`. Staff sees confirmation card. Applied only after staff confirms. |
| **Human-only** | Refunds, pricing changes, policy exceptions, negotiation, complaint handling, liability commitments | Agent does not draft or propose. Flags conversation for manual handling. |

### 7.2 ProposedAction contract

```typescript
type ProposedAction = {
  id: string;                              // UUID
  sessionKey: string;                      // workspace:{id}:client:{id}
  actionType:
    | "client_update"
    | "booking_create"
    | "booking_reschedule"
    | "followup_create"
    | "message_send"
    | "note_create";
  summary: string;                         // Human-readable description for staff
  tier: "auto" | "review" | "human_only";  // Determined by ApprovalPolicyEvaluator
  payload: Record<string, unknown>;        // Typed per actionType
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: Timestamp;
  reviewedAt: Timestamp | null;
  reviewedBy: string | null;               // staff_id
};
```

### 7.3 Approval flow

```
Client Worker returns ProposedAction[]
        │
        v
ApprovalPolicyEvaluator
        │
        ├─→ tier = "auto"
        │     └─→ ActionExecutor runs immediately
        │         └─→ AuditEvent logged
        │
        ├─→ tier = "review"
        │     └─→ ConfirmationRequest created
        │         └─→ Staff sees card in app
        │             ├─→ Staff approves → ActionExecutor runs → AuditEvent logged
        │             └─→ Staff rejects → ProposedAction.status = "rejected" → AuditEvent logged
        │
        └─→ tier = "human_only"
              └─→ Conversation flagged for manual handling
                  └─→ No draft, no proposal — staff handles from scratch
```

---

## 8. Learning loop specification

Adapted from the OpenClaw `self-improving-agent` skill by pskoett, which captures learnings, errors, and corrections as structured markdown entries with recurrence tracking and promotion rules. Our system applies the same pattern to draft editing: every staff edit is a learning signal that feeds back into future draft generation.

### 8.1 Core principle

The self-improving-agent skill's insight: **the agent is already making mistakes and learning from corrections in every session — the system just needs to make that process explicit, persistent, and structured.**

In OpenClaw, this means logging corrections to `.learnings/LEARNINGS.md` with pattern keys, recurrence counts, and promotion thresholds. In our system, the "correction" is the diff between what the AI drafted and what the staff actually sent.

### 8.2 Signal capture (Phase 2 — record immediately)

Every time staff acts on a draft, the system records a `DraftEditSignal`:

```typescript
type DraftEditSignal = {
  signalId: string;
  workspaceId: string;
  clientId: string;
  conversationId: string;
  draftId: string;

  // What happened
  staffAction: "sent_as_is" | "edited_and_sent" | "regenerated" | "discarded";
  originalDraft: string;
  finalVersion: string | null;          // null if discarded

  // Classification context
  intentClassified: string;             // booking, question, follow_up, etc.
  scenarioType: string;                 // first_contact, reschedule, reminder, etc.
  confidenceScore: number;

  // Timestamps
  draftCreatedAt: Timestamp;
  staffActedAt: Timestamp;

  // Downstream signal (filled async)
  clientReplied: boolean | null;        // did the client respond to the sent message?
  clientReplyLatency: number | null;    // minutes until client response
};
```

This is recorded immediately at send time. No LLM call needed — it's a structured database write. This mirrors the self-improving-agent's principle of "log immediately — context is freshest right after the issue."

### 8.3 Diff analysis (Phase 4 — classify what changed)

An async worker (the LearningWorker) processes `DraftEditSignal` records where `staffAction = "edited_and_sent"`. It runs an LLM call to classify the edit type. This is analogous to the self-improving-agent's categorization step where entries get tagged with `category`, `Pattern-Key`, and `Area`.

```typescript
type DraftEditClassification = {
  signalId: string;
  editCategories: EditCategory[];       // multiple categories per edit
  patternKey: string | null;            // stable key for recurrence tracking
  severity: "minor" | "significant" | "rewrite";
  analysisNotes: string;                // LLM's explanation of what changed
};

type EditCategory =
  | "tone_softened"
  | "tone_warmed"
  | "tone_formalized"
  | "shortened"
  | "lengthened"
  | "assumption_removed"
  | "fact_corrected"
  | "scheduling_options_added"
  | "cta_softened"
  | "cta_strengthened"
  | "personalization_added"
  | "upsell_removed"
  | "policy_clarification_added"
  | "greeting_changed"
  | "closing_changed"
  | "emoji_added_or_removed"
  | "structure_reorganized";
```

The `patternKey` is critical — borrowed directly from the self-improving-agent's `Pattern-Key` field. It enables recurrence tracking: if "tone_softened" appears 15 times across different clients, that's a workspace-level preference, not a one-off correction.

### 8.4 Recurrence tracking and promotion

The self-improving-agent promotes learnings to system prompt files when: `Recurrence-Count >= 3`, seen across at least 2 distinct tasks, within a 30-day window. Our equivalent:

```typescript
type PatternRecurrence = {
  patternKey: string;
  workspaceId: string;
  category: EditCategory;
  recurrenceCount: number;
  distinctClients: number;              // across how many clients?
  firstSeen: Date;
  lastSeen: Date;
  promoted: boolean;
  promotedAt: Date | null;
};
```

**Promotion rules:**

| Condition | Threshold | Promotes to |
|---|---|---|
| Same edit pattern across 3+ drafts, 2+ clients, within 30 days | Automatic candidate | `WorkspaceCommunicationProfile` |
| Same edit pattern for same client across 3+ drafts | Automatic candidate | `ClientCommunicationPreference` (future, post-MVP) |
| Staff explicitly flags "always do this" | Immediate | `WorkspaceCommunicationProfile` |

### 8.5 Learned outputs

Promotion targets mirror the self-improving-agent's `CLAUDE.md` / `AGENTS.md` / `SOUL.md` / `TOOLS.md` targets, but as structured database records rather than markdown files:

**WorkspaceCommunicationProfile** (global — loaded for every client worker invocation):

```typescript
type WorkspaceCommunicationProfile = {
  workspaceId: string;
  rules: CommunicationRule[];
  updatedAt: Timestamp;
};

type CommunicationRule = {
  ruleId: string;
  category: EditCategory;
  instruction: string;                  // "Keep replies under 3 sentences"
  confidence: number;                   // based on recurrence count
  sourcePatternKey: string;
  promotedAt: Timestamp;
  active: boolean;                      // staff can disable
};
```

Example rules (extracted from real edit patterns):
- "Keep replies concise — under 3 sentences for routine confirmations"
- "Always offer 2–3 scheduling options, not just one"
- "Never use upsell language in appointment reminders"
- "Restate booking details explicitly in confirmation messages"
- "Use a warmer closing than 'Best regards' — match the tone profile"

**These rules are injected into the Client Worker's system prompt** as part of the global workspace context (§2.1). They sit alongside the tone profile and vertical config — they're learned refinements to the workspace's communication style.

### 8.6 The full loop

```
Staff sends message (original draft or edited version)
        │
        v
  DraftEditSignal recorded immediately (Phase 2)
        │         staffAction, originalDraft, finalVersion
        v
  Async: LearningWorker classifies the edit (Phase 4)
        │         editCategories, patternKey, severity
        v
  PatternRecurrence updated
        │         recurrenceCount++, distinctClients recalculated
        v
  Promotion check
        │
        ├─→ Below threshold → wait for more signals
        │
        └─→ Meets threshold (3+ occurrences, 2+ clients, 30 days)
              │
              v
        New CommunicationRule created
              │
              v
        WorkspaceCommunicationProfile updated
              │
              v
        Rule included in context assembly for all future Client Worker calls
              │
              v
        Future drafts reflect the learned preference
```

### 8.7 What the self-improving-agent teaches us

Key patterns borrowed from pskoett's skill:

1. **Structured format over free-form notes.** The self-improving-agent uses typed entries (`LRN-YYYYMMDD-XXX`) with mandatory fields (Priority, Status, Area, Pattern-Key). We do the same — `DraftEditSignal` and `DraftEditClassification` are typed records, not freeform text.

2. **Recurrence tracking with stable keys.** The `Pattern-Key` field enables the self-improving-agent to detect when the same issue recurs across sessions. Our `patternKey` does the same across client interactions.

3. **Promotion thresholds, not immediate action.** The self-improving-agent doesn't promote a one-off correction — it waits for 3+ recurrences across 2+ tasks. We do the same: a single staff edit doesn't change the system prompt. A pattern that repeats across clients does.

4. **Promotion targets match the context hierarchy.** The self-improving-agent promotes to `CLAUDE.md` (project-level), `AGENTS.md` (workflow-level), `SOUL.md` (personality-level). We promote to `WorkspaceCommunicationProfile` which is injected into the system prompt at the workspace level — equivalent to promoting a learning to `SOUL.md`.

5. **Human review of promoted rules.** The self-improving-agent recommends reviewing `.learnings/` weekly. Our system allows staff to view, disable, or edit promoted rules in the Settings page. Promotion is a suggestion, not an irreversible commitment.

### 8.8 Phase boundaries

| Phase | What ships |
|---|---|
| Phase 2 | `DraftEditSignal` recording on every send. Raw data collection. No analysis. |
| Phase 3 | Draft acceptance rate metrics (sent_as_is / edited / discarded counts). |
| Phase 4 | LearningWorker diff analysis. Recurrence tracking. Promotion to `WorkspaceCommunicationProfile`. Rules visible in Settings. |
| Post-MVP | Client-level preferences. Scenario-specific drafting rules. Draft quality feedback (thumbs up/down). |

---

## 9. Bounded contexts and codebase structure

The original architecture document's bounded contexts are correct. We keep them exactly as designed — they organize code around business meaning, not technical layers.

### 9.1 Module structure

```
apps/api/src/
  app/
    server.ts
    register-routes.ts

  modules/
    client-relationship/
      domain/
        Client.ts                    # Entity + lifecycle status transitions
        ClientProfile.ts             # Value object: profile + vertical fields
        ClientRepository.ts          # Repository contract (interface)
      application/
        AssembleClientContext.ts      # Context assembly for Client Worker
        ProposeClientUpdate.ts       # Returns ProposedAction<ClientUpdate>
      infrastructure/
        SupabaseClientRepository.ts

    conversation/
      domain/
        Conversation.ts              # Entity + state machine (§12.4 states)
        ConversationState.ts         # State enum + transition rules
        Message.ts                   # Entity
        Draft.ts                     # Entity (audit-tracked)
        ConversationRepository.ts
      application/
        ProcessInboundMessage.ts     # Main pipeline: dequeue → context → agent → draft
        GenerateReplyDraft.ts        # Invokes Client Worker
        RegenerateDraft.ts           # Reprompt flow
        CompactConversation.ts       # Daily compaction for one client
      infrastructure/
        SupabaseConversationRepository.ts
        BullMQMessageQueue.ts

    booking-operations/
      domain/
        Booking.ts                   # Entity + status transitions
        AvailabilityWindow.ts        # Value object
        BookingRules.ts              # Appointment types, durations, buffers
        BookingRepository.ts
      application/
        QueryAvailability.ts         # Read-only: returns slots
        ProposeBooking.ts            # Returns ProposedAction<BookingCreate>
        DetectConflict.ts            # Check at confirmation time
      infrastructure/
        SupabaseBookingRepository.ts
        GoogleCalendarGateway.ts

    follow-up-management/
      domain/
        FollowUp.ts                  # Entity
        FollowUpRepository.ts
      application/
        ProposeFollowUp.ts           # Returns ProposedAction<FollowUpCreate>
        SurfaceOverdueFollowUps.ts   # For daily cron / COS
      infrastructure/
        SupabaseFollowUpRepository.ts

    workspace-knowledge/
      domain/
        KnowledgeChunk.ts            # Entity (embedded text chunk)
        KnowledgeRepository.ts
      application/
        SearchKnowledge.ts           # Semantic search tool implementation
        IndexKnowledge.ts            # Chunk + embed on knowledge update
      infrastructure/
        PgVectorKnowledgeRepository.ts

    agent-governance/
      domain/
        ProposedAction.ts            # Entity (§7.2)
        ConfirmationRequest.ts       # Entity
        ApprovalPolicy.ts            # Trust tier rules
        AuditEvent.ts                # Entity
      application/
        EvaluateApprovalPolicy.ts    # Classify action → tier
        ExecuteApprovedAction.ts     # Run after staff confirms
      infrastructure/
        SupabaseAuditRepository.ts

    learning-optimization/
      domain/
        DraftEditSignal.ts           # Raw signal: draft vs. edited version (Phase 2)
        DraftEditClassification.ts   # LLM-classified edit categories (Phase 4)
        PatternRecurrence.ts         # Recurrence tracking per pattern key
        CommunicationRule.ts         # Promoted rule entity
        WorkspaceCommunicationProfile.ts  # Collection of active rules (global)
      application/
        RecordDraftEditSignal.ts     # Save draft/edit pair immediately at send time
        ClassifyDraftEdits.ts        # Async LLM analysis of what changed (Phase 4)
        UpdatePatternRecurrence.ts   # Increment counts, check promotion threshold
        PromoteToCommunicationRule.ts # Create rule from recurring pattern
      infrastructure/
        SupabaseLearningRepository.ts

  agent/
    ClientWorkerRuntime.ts           # Orchestrates single LLM call + tool loop
    COSOperationsRuntime.ts          # Cross-client operational queries
    ContextAssembler.ts              # Pure function: (workspaceId, clientId) → context
    ToolRegistry.ts                  # Tool definitions with schemas
    ToolParamInjector.ts             # Injects session-scoped params
    SystemPromptBuilder.ts           # Composes prompt from workspace config

  integrations/
    whatsapp/
      WhatsAppSessionManager.ts      # QR code pairing, session persistence, reconnection
      MessageListener.ts             # Receives messages from WhatsApp Web protocol
      MessageSender.ts               # Sends staff-approved messages via connected session
      HistoryImporter.ts             # Imports existing conversation history on first connection
    google-calendar/
      CalendarAdapter.ts             # OAuth + availability + event CRUD
    llm/
      ModelGateway.ts                # LLM provider abstraction
      PromptComposer.ts             # Template rendering

  jobs/
    DailyCompactionJob.ts            # Cron: compact summaries for active clients
    DailyFollowUpJob.ts              # Cron: surface overdue follow-ups
    NotionSyncJob.ts                 # Cron: optional export to Notion
    InactivityDetectionJob.ts        # Cron: mark clients inactive after 30 days
```

### 9.2 Clean architecture layers

| Layer | Contains | Depends on |
|---|---|---|
| **Domain** | Entities, value objects, repository interfaces, domain rules | Nothing external |
| **Application** | Use cases, context assembly, tool implementations | Domain only |
| **Infrastructure** | Supabase repositories, BullMQ, Google Calendar adapter, LLM gateway | Domain + Application interfaces |
| **Interface** | HTTP routes, webhook handlers, SSE endpoints | Application use cases |

---

## 10. Conversation state machine

The PRD defines conversation states (§12.4) but the original architecture document didn't model the state machine. This is required because both the Client Worker's routing logic and the daily cron depend on conversation state.

### 10.1 States and transitions

```
                    ┌──────────┐
                    │   idle   │ ◄─── conversation resolved
                    └────┬─────┘
                         │ inbound message
                         v
              ┌─────────────────────┐
              │ awaiting_staff_review│ ◄─── AI draft ready
              └─────────┬───────────┘
                        │ staff sends reply
                        v
              ┌─────────────────────┐
              │ awaiting_client_reply│
              └────┬───────────┬────┘
                   │           │ 24h timeout
                   │           v
                   │  ┌────────────────┐
                   │  │follow_up_pending│ ──→ daily cron generates follow-up draft
                   │  └────────────────┘
                   │
                   │ client replies with booking intent
                   v
           ┌───────────────────┐
           │booking_in_progress│
           └───────┬───────────┘
                   │ booking confirmed by staff
                   v
              ┌──────────┐
              │   idle   │
              └──────────┘
```

### 10.2 State machine implementation

The `Conversation` entity owns its state transitions. Transitions are validated by domain logic — not by the LLM.

```typescript
class Conversation {
  transition(event: ConversationEvent): void {
    const allowed = TRANSITION_TABLE[this.state]?.[event];
    if (!allowed) throw new InvalidTransitionError(this.state, event);
    this.state = allowed;
    this.updatedAt = new Date();
    this.version += 1;
  }
}

const TRANSITION_TABLE = {
  idle: {
    inbound_message: "awaiting_staff_review",
  },
  awaiting_staff_review: {
    staff_sends: "awaiting_client_reply",
    staff_discards: "idle",
  },
  awaiting_client_reply: {
    inbound_message: "awaiting_staff_review",
    timeout_24h: "follow_up_pending",
  },
  follow_up_pending: {
    followup_draft_ready: "awaiting_staff_review",
    staff_resolves: "idle",
  },
  booking_in_progress: {
    inbound_message: "awaiting_staff_review",
    booking_confirmed: "idle",
    timeout_24h: "follow_up_pending",
  },
};
```

---

## 11. WhatsApp integration details

### 11.1 WhatsApp Web session management

The system connects to the owner's existing WhatsApp via QR code pairing (WhatsApp Web protocol). This gives full access to existing conversations, contacts, and message history — no WABA application or separate business number needed.

**Session lifecycle:**

```typescript
async function sendMessage(conversationId: string, content: string): Promise<SendResult> {
  const conversation = await repo.getConversation(conversationId);
  const session = await whatsappSessionManager.getSession(conversation.workspaceId);

  if (!session || session.status !== "connected") {
    return { status: "blocked", reason: "whatsapp_session_disconnected" };
  }

  return session.sendMessage(conversation.clientPhone, content);
}
```

**Session persistence:** Stored credentials (auth keys) allow reconnection without QR re-scan. When the session expires or is revoked (e.g., user logs out from phone), the system detects disconnection and prompts staff to re-scan the QR code.

**Conversation history import:** On first connection, the system imports existing conversation history to bootstrap client context. Messages are processed through the normal pipeline (phone normalization, client lookup/create, storage) but skip AI drafting.

### 11.2 Media handling pipeline

Per PRD §10.2, three tiers:

| Tier | Types | Processing |
|---|---|---|
| AI-processed | Images, voice notes | Voice notes: transcribed (Whisper or equivalent) before agent invocation. Images: passed to multimodal LLM within Client Worker call. Transcriptions stored in `Message.media_transcription`. |
| Staff-visible | PDFs, videos, documents | Stored and displayed in client thread. Not sent to LLM. |
| Acknowledged | Location pins, contacts, stickers | Stored as metadata. Agent generates acknowledgment in draft. |

Voice note transcription happens in the worker pipeline **before** context assembly, so the transcribed text is available as part of `recentMessages`.

---

## 12. Vertical configuration layer

Per PRD §11.0, the system supports vertical-specific fields without hardcoding suit-specific schema.

### 12.1 Schema

```typescript
type VerticalConfig = {
  customFields: Array<{
    key: string;                          // e.g., "chest_inches"
    label: string;                        // e.g., "Chest measurement"
    type: "string" | "number" | "date" | "boolean" | "enum";
    enumValues?: string[];                // for type "enum"
    required: boolean;
  }>;
  appointmentSequence: Array<{
    appointmentType: string;              // e.g., "first_fitting"
    prerequisite: string | null;          // e.g., "initial_consultation"
  }>;
  measurementTemplate: Array<{
    key: string;                          // e.g., "shoulder_width"
    label: string;
    unit: string;                         // e.g., "inches", "cm"
  }>;
};
```

Custom fields are stored in the `Client.preferences` JSON column, keyed by `customFields[].key`. The context assembler reads the workspace's `vertical_config` to know which fields exist and includes them in the client profile section of the assembled context.

---

## 13. Technology decisions

### 13.1 Stack

| Component | Choice | Rationale |
|---|---|---|
| Database | Supabase (managed Postgres) | Point-in-time recovery, pgvector for knowledge search, row-level security for tenant isolation |
| Message queue | BullMQ + Redis | Durable, ordered, supports queue groups for per-client serialization |
| LLM gateway | OpenRouter (or direct provider API) | Model flexibility, fallback routing |
| Knowledge embeddings | pgvector with Postgres | Single database, no separate vector store |
| Auth | Supabase Auth | Built-in, no custom implementation |
| Server framework | Fastify (Node.js/TypeScript) | Fast, schema validation, good ecosystem |
| Staff app | React (mobile-first responsive web) | PWA-capable, push notifications |
| Schema validation | Zod | Shared between API, tool definitions, and client |
| Job scheduling | BullMQ scheduled jobs | Already in stack for message queue |
| LLM observability | Langfuse | Trace every LLM call, tool execution, and draft generation |

### 13.2 Library-first decisions

Use existing libraries. Custom code only for domain-specific logic.

| Use library | For |
|---|---|
| `zod` | All schema validation (tools, API, config) |
| `bullmq` | Message queue + job scheduling |
| `cockatiel` | Retry / circuit breaker for external APIs |
| `googleapis` | Google Calendar integration |
| `langfuse` | LLM tracing and cost tracking |

| Write custom code | For |
|---|---|
| Context assembly | Domain-specific token budgeting and assembly order |
| Approval policy evaluation | Business-specific trust tier rules |
| Conversation state machine | Domain transitions |
| Compaction logic | Summary generation with structured record awareness |

---

## 14. MVP scope

### 14.1 In scope (Phase 1-2)

- Client Worker with single-agent tool calling
- Context assembly with session isolation
- WhatsApp webhook ingestion → BullMQ → worker pipeline
- Client find-or-create by phone number
- AI draft generation with knowledge search
- Draft review UX (edit, send, reprompt)
- Google Calendar availability + booking
- Conversation state machine
- Approval boundary (fixed trust model)
- Audit logging for all mutations
- Push notifications + in-app badges
- Vertical config layer for suit pilot

### 14.2 In scope (Phase 3)

- Daily compaction cron
- Follow-up and promise capture
- Note capture with async AI categorization
- COS operations (daily follow-up surfacing, today's view)
- Appointment confirmation flow

### 14.3 Deferred (Phase 4+)

- Learning optimization (draft edit analysis → communication profiles)
- Trust model tuning
- Notion sync
- Multi-staff accounts
- Performance metrics dashboard

### 14.4 Skill packages for MVP

| Package | Skills |
|---|---|
| Supabase | client-read, conversation-read, booking-read, draft-save, note-save, followup-read, audit-write |
| Google Calendar | calendar-read-availability, calendar-read-events, calendar-propose-booking |

Notion is explicitly deferred. The PRD (§13.3) says it's an optional export layer. It does not need agent-accessible skills.

---

## 15. ADR summary

### ADR-1: Single agent with tools, not multi-agent hierarchy

**Context:** The original architecture proposed COS → ClientWorker → SchedulingWorker → KnowledgeWorker.
**Decision:** Single LLM call per client message. Scheduling and knowledge are tools, not agents.
**Why:** PRD §7.2 says "single orchestrated agent with tool calling." Multi-agent multiplies cost and latency. The domain doesn't require separate reasoning processes for scheduling vs. knowledge.
**Consequence:** Knowledge retrieval is a tool call (fast), not a reasoning step (slow). Calendar queries return structured data, not LLM-interpreted summaries.

### ADR-2: Database-backed session isolation, not file-based

**Context:** OpenClaw isolates sessions via filesystem scoping (separate JSONL files per session key, separate workspace directories per agent).
**Decision:** Session isolation via database queries scoped by `workspace_id + client_id`. No filesystem state.
**Why:** Multi-tenant SaaS with many clients per workspace. File-per-client doesn't scale. Postgres gives us ACID, concurrent access, and backup for free.
**Consequence:** Concurrency uses optimistic locking + queue ordering instead of file locks. Context assembly is a set of SQL queries, not file reads.

### ADR-3: Daily scheduled compaction, not reactive

**Context:** OpenClaw compacts when context window pressure exceeds a threshold. This requires soft threshold monitoring, emergency overflow handling, and a flush mechanism.
**Decision:** Compact daily via cron, per workspace timezone.
**Why:** Simpler. Predictable. No dual-path (maintenance vs. overflow) complexity. Our context budget (§3.3) is fixed at ~12.5K tokens — well within any model's window — so we never hit context pressure during a single invocation.
**Consequence:** No need for real-time token counting, threshold monitoring, or emergency compaction. The daily cron is the only compaction path.

### ADR-4: COS does not draft messages

**Context:** The COS identifies clients needing follow-up. Should it also draft the follow-up messages?
**Decision:** No. COS identifies clients. Client Worker drafts messages.
**Why:** The COS has no client conversational context — it works from structured records. A good follow-up message needs tone, recent context, and client preferences. Only the Client Worker has these. The COS queues Client Worker invocations for each client needing follow-up.
**Consequence:** Follow-up drafts take slightly longer (one COS invocation + N Client Worker invocations). But each draft is contextually rich and consistent with the normal drafting path.