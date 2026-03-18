// Shared types for Sprint 2 Edge Functions
// Covers F-05 (Context Assembly & Agent Runtime), F-06 (Approval & Governance), F-10 (Learning Signals)

// === Context Assembly (F-05) ===
// Structured like OpenClaw: BUSINESS.md, AGENT, TOOLS, MEMORY, HEARTBEAT

/** Workspace-level context — cacheable, does not change per message */
export interface GlobalContext {
  /** BUSINESS.md — who this business is */
  identity: BusinessIdentity
  /** AGENT — behavior rules, SOPs, what the agent can/cannot do */
  agent: AgentConfig
  /** TOOLS — available tools and their config */
  tools: ToolsConfig
  /** Business context — hours, calendar, scheduling, reminders */
  businessContext: BusinessContext
  /** MEMORY — learned patterns from past interactions */
  memory: AgentMemory
  /** HEARTBEAT — current operational status */
  heartbeat: AgentHeartbeat
}

// --- BUSINESS.md (was WorkspaceContext) ---

export interface BusinessIdentity {
  businessName: string
  vertical: string
  description: string | null
  toneProfile: string | null
}

// --- AGENT ---

export interface AgentConfig {
  sopRules: string[]
  intentTaxonomy: readonly string[]
  customFields: Array<{ name: string; description: string }>
  appointmentTypes: Array<{ name: string; description: string }>
}

// --- TOOLS ---

export interface ToolsConfig {
  calendarConnected: boolean
  knowledgeBaseEnabled: boolean
}

// --- Business Context ---

export interface BusinessContext {
  timezone: string
  businessHours: Record<string, { open: string; close: string }> | null
  scheduledReminder: ScheduledReminderConfig
}

export interface ScheduledReminderConfig {
  enabled: boolean
  daysBefore: number  // default: 1
}

// --- MEMORY ---

export interface AgentMemory {
  communicationRules: CommunicationRule[]
}

// --- HEARTBEAT ---

export interface AgentHeartbeat {
  workspaceId: string
  status: string  // 'active', 'paused', etc.
}

/** Per-client, per-message context — fresh on every invocation */
export interface MessageContext {
  sessionKey: string
  knowledgeChunks: KnowledgeChunk[]
  client: ClientContext
  compactSummary: string | null
  recentMessages: RecentMessage[]
  activeBookings: BookingContext[]
  openFollowUps: FollowUpContext[]
  recentNotes: NoteContext[]
  conversationState: string
  inboundMessage: InboundMessage
}

/** Combined context passed to the agent runtime */
export interface ReadOnlyContext extends GlobalContext, MessageContext {}

export interface CommunicationRule {
  rule: string
  source: string
  createdAt: string
}

export interface KnowledgeChunk {
  id: string
  content: string
  source: string
  sourceRef: string | null
  similarity: number
}

export interface ClientContext {
  id: string
  name: string | null
  phone: string
  lifecycleStatus: string
  tags: string[]
  preferences: Record<string, unknown>
  lastContactedAt: string | null
}

export interface RecentMessage {
  direction: 'inbound' | 'outbound'
  content: string | null
  timestamp: string
  senderType: string
}

export interface BookingContext {
  appointmentType: string
  startTime: string
  status: string
  confirmationStatus: string
}

export interface FollowUpContext {
  content: string
  dueDate: string | null
  status: string
}

export interface NoteContext {
  content: string
  source: string
  createdAt: string
}

export interface InboundMessage {
  content: string | null
  mediaType: string | null
  mediaTranscription: string | null
  timestamp: string
}

// === Agent Runtime (F-05) ===

export interface ClientWorkerResult {
  draft: string
  intent: string
  confidence: number
  scenarioType: string
  knowledgeSources: string[]
  proposedActions: ProposedAction[]
  usage: { tokensIn: number; tokensOut: number }
}

export interface LLMToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  output: unknown
  proposedAction?: ProposedAction
}

export interface ToolDefinition {
  name: string
  description: string
  authority: 'read' | 'auto_write' | 'propose_write'
  fixedParams: Record<string, unknown>
  execute: (params: Record<string, unknown>) => Promise<ToolResult>
}

export type ToolRegistry = Record<string, ToolDefinition>

// === Approval & Governance (F-06) ===

export interface ProposedAction {
  id?: string
  workspaceId: string
  clientId: string
  conversationId: string
  draftId?: string
  actionType: ProposedActionType
  summary: string
  tier: ApprovalTier
  payload: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'expired'
}

export type ProposedActionType =
  | 'client_update'
  | 'booking_create'
  | 'followup_create'
  | 'message_send'
  | 'note_create'
  | 'last_contacted_update'
  | 'tag_attach'

export type ApprovalTier = 'auto' | 'review' | 'human_only'

export interface ApprovalPolicy {
  autoActions: Set<string>
  humanOnlyActions: Set<string>
  // Everything else defaults to 'review'
}

// === Learning Signals (F-10) ===

export type StaffAction = 'sent_as_is' | 'edited_and_sent' | 'regenerated' | 'discarded'

export interface DraftEditSignalInput {
  workspaceId: string
  clientId: string
  draftId: string
  staffAction: StaffAction
  originalDraft: string
  finalVersion: string | null
  intentClassified: string
  scenarioType: string
}

// === Intent Taxonomy ===

export const INTENT_TAXONOMY = [
  'booking_inquiry',
  'pricing_question',
  'general_question',
  'follow_up',
  'greeting',
  'complaint',
  'cancellation',
  'reschedule',
  'out_of_scope',
] as const

export type IntentType = typeof INTENT_TAXONOMY[number]

export const SCENARIO_TYPES = [
  'first_contact',
  'returning_client',
  'booking_flow',
  'faq_response',
  'follow_up_reply',
  'complaint_handling',
  'general',
] as const

export type ScenarioType = typeof SCENARIO_TYPES[number]
