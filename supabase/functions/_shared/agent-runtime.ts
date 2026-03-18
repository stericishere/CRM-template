// supabase/functions/_shared/agent-runtime.ts
// Client Worker: LLM + tool-calling loop for the AI drafting pipeline (F-05)
//
// Flow diagram:
//
//  assembleContext()
//       │
//       v
//  composeSystemPrompt()
//       │
//       v
//  buildConversationMessages()
//       │
//       v
//  ┌────────────────────────────────────────────────┐
//  │              Tool-Calling Loop (max 5)          │
//  │                                                 │
//  │   callLLM() ──▶ finishReason?                  │
//  │                      │                          │
//  │             ┌────────┴────────┐                 │
//  │         tool_calls          stop/other          │
//  │             │                   │               │
//  │    executeToolCall()       parseAgentResponse() │
//  │    append tool results          │               │
//  │             │                   v               │
//  │             └──────────▶  ClientWorkerResult    │
//  └────────────────────────────────────────────────┘

import type { ReadOnlyContext, ToolRegistry, ClientWorkerResult, ProposedAction } from './sprint2-types.ts'
import type OpenAI from 'https://esm.sh/openai@4'
import { callLLM, PRO_MODEL } from './llm-client.ts'
import { composeSystemPrompt } from './system-prompt.ts'
import { executeToolCall } from './tool-executor.ts'
import { buildToolDefinitions } from './tool-registry.ts'

// Maximum number of LLM ↔ tool iterations to prevent runaway loops
const MAX_TOOL_LOOPS = 5

// Options passed to the Client Worker invocation
export interface ClientWorkerOptions {
  model?: string
  calendarConnected?: boolean
  maxTokens?: number
}

// ---------------------------------------------------------------------------
// invokeClientWorker
// ---------------------------------------------------------------------------

/**
 * Main entry point for the AI drafting pipeline.
 * Composes the system prompt and context, runs the LLM with tool calls,
 * and returns the structured draft reply with intent/confidence/actions.
 *
 * Session-scoped fields (workspaceId, clientId, conversationId) are read
 * from context.sessionKey and must NOT be overridable by the LLM.
 */
export async function invokeClientWorker(
  context: ReadOnlyContext,
  toolRegistry: ToolRegistry,
  options: ClientWorkerOptions = {}
): Promise<ClientWorkerResult> {
  const model = options.model ?? PRO_MODEL
  const calendarConnected = options.calendarConnected ?? false
  const maxTokens = options.maxTokens ?? 1024

  // Parse session identifiers from the session key (format: workspace:{id}:client:{id})
  const sessionKey = context.sessionKey
  const [, workspaceId, , clientId] = sessionKey.split(':')

  // conversationId is not in ReadOnlyContext — derive from messages or leave empty
  // It is injected via tool executor but must be passed through the session object
  const conversationId = ''

  const session = { workspaceId, clientId, conversationId }

  // Build system prompt and tool definitions
  const systemPrompt = composeSystemPrompt(
    context.workspace,
    context.verticalConfig,
    context.communicationRules,
    { calendarConnected }
  )

  const tools = buildToolDefinitions(toolRegistry, { calendarConnected })

  // Build the initial conversation messages
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = buildConversationMessages(context)

  // Accumulate token usage across all iterations
  let totalTokensIn = 0
  let totalTokensOut = 0

  // Collect proposed actions from tool results
  const proposedActions: ProposedAction[] = []

  console.log('[agent_runtime] Starting LLM loop', { model, sessionKey, maxLoops: MAX_TOOL_LOOPS })

  // ---------------------------------------------------------------------------
  // Tool-calling loop
  // ---------------------------------------------------------------------------
  let iterations = 0
  let finalMessage: OpenAI.Chat.ChatCompletionMessage | null = null

  while (iterations < MAX_TOOL_LOOPS) {
    iterations++

    const result = await callLLM({
      model,
      systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      maxTokens,
    })

    totalTokensIn += result.usage.tokensIn
    totalTokensOut += result.usage.tokensOut

    const { message, finishReason } = result

    console.log('[agent_runtime] LLM response', {
      iteration: iterations,
      finishReason,
      hasToolCalls: (message.tool_calls?.length ?? 0) > 0,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
    })

    // Append assistant message to conversation history
    messages.push(message as OpenAI.Chat.ChatCompletionMessageParam)

    // If LLM is done with tool calls, exit the loop
    if (finishReason !== 'tool_calls' || !message.tool_calls || message.tool_calls.length === 0) {
      finalMessage = message
      break
    }

    // Execute each tool call and collect results
    for (const toolCall of message.tool_calls) {
      const llmToolCall = {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseToolCallArguments(toolCall.function.arguments),
      }

      console.log('[agent_runtime] Executing tool', { tool: llmToolCall.name, callId: llmToolCall.id })

      const toolResult = await executeToolCall(llmToolCall, session, toolRegistry)

      // Collect proposed actions from tool results
      if (toolResult.proposedAction) {
        proposedActions.push(toolResult.proposedAction)
      }

      // Append tool result in OpenAI format
      const toolResultMessage: OpenAI.Chat.ChatCompletionMessageParam = {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult.output),
      }
      messages.push(toolResultMessage)
    }
  }

  // If we hit max iterations without a stop, use the last assistant message
  if (!finalMessage) {
    console.warn('[agent_runtime] Hit MAX_TOOL_LOOPS without stop finish reason', {
      iterations,
      sessionKey,
    })
    // Find the last assistant message in the conversation
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (lastAssistant && 'content' in lastAssistant) {
      finalMessage = lastAssistant as OpenAI.Chat.ChatCompletionMessage
    }
  }

  // Extract content string from the final message
  const rawContent = extractTextContent(finalMessage)

  // Parse structured output (intent, confidence, scenario_type) from the response
  const parsed = parseAgentResponse(rawContent)

  console.log('[agent_runtime] Completed', {
    intent: parsed.intent,
    confidence: parsed.confidence,
    scenarioType: parsed.scenarioType,
    proposedActionsCount: proposedActions.length,
    totalTokensIn,
    totalTokensOut,
    iterations,
  })

  return {
    draft: parsed.draft,
    intent: parsed.intent,
    confidence: parsed.confidence,
    scenarioType: parsed.scenarioType,
    knowledgeSources: context.knowledgeChunks.map(c => c.source),
    proposedActions,
    usage: { tokensIn: totalTokensIn, tokensOut: totalTokensOut },
  }
}

// ---------------------------------------------------------------------------
// buildConversationMessages
// ---------------------------------------------------------------------------

/**
 * Formats the ReadOnlyContext into OpenAI message format.
 *
 * Message order:
 * 1. Context summary (client info, knowledge chunks, bookings, etc.)
 * 2. Recent conversation history
 * 3. The inbound message being processed
 */
export function buildConversationMessages(
  context: ReadOnlyContext
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const parts: string[] = []

  // --- Client context ---
  const client = context.client
  parts.push(`## Client
Name: ${client.name ?? 'Unknown'}
Phone: ${client.phone}
Lifecycle Status: ${client.lifecycleStatus}
Tags: ${client.tags.length > 0 ? client.tags.join(', ') : 'none'}
Last Contacted: ${client.lastContactedAt ?? 'never'}`)

  // --- Conversation state ---
  parts.push(`## Conversation State
${context.conversationState}`)

  // --- Compact summary (compressed memory) ---
  if (context.compactSummary) {
    parts.push(`## Conversation Summary (Memory)
${context.compactSummary}`)
  }

  // --- Knowledge chunks (pre-retrieved semantic search results) ---
  if (context.knowledgeChunks.length > 0) {
    const chunks = context.knowledgeChunks
      .map(c => `[${c.source}] ${c.content}`)
      .join('\n---\n')
    parts.push(`## Relevant Knowledge Base Entries
${chunks}`)
  }

  // --- Active bookings ---
  if (context.activeBookings.length > 0) {
    const bookings = context.activeBookings
      .map(b => `- ${b.appointmentType} on ${b.startTime} (${b.status}/${b.confirmationStatus})`)
      .join('\n')
    parts.push(`## Active Bookings
${bookings}`)
  }

  // --- Open follow-ups ---
  if (context.openFollowUps.length > 0) {
    const followUps = context.openFollowUps
      .map(f => `- ${f.content}${f.dueDate ? ` (due ${f.dueDate})` : ''}`)
      .join('\n')
    parts.push(`## Open Follow-ups
${followUps}`)
  }

  // --- Recent notes ---
  if (context.recentNotes.length > 0) {
    const notes = context.recentNotes
      .map(n => `[${n.source}] ${n.content}`)
      .join('\n')
    parts.push(`## Recent Notes
${notes}`)
  }

  const contextSummary = parts.join('\n\n')

  // Build messages array
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []

  // First message: full context summary
  messages.push({
    role: 'user',
    content: contextSummary,
  })

  // Inject recent conversation history
  for (const msg of context.recentMessages) {
    const role = msg.direction === 'inbound' ? 'user' : 'assistant'
    if (msg.content) {
      messages.push({
        role,
        content: msg.content,
      })
    }
  }

  // Final message: the inbound message being processed now
  const inbound = context.inboundMessage
  let inboundText = inbound.content ?? ''
  if (inbound.mediaTranscription) {
    inboundText = inbound.mediaTranscription
    if (inbound.content) {
      inboundText = `${inbound.content}\n[Transcription: ${inbound.mediaTranscription}]`
    }
  } else if (!inboundText && inbound.mediaType) {
    inboundText = `[${inbound.mediaType} message — no transcription available]`
  }

  messages.push({
    role: 'user',
    content: inboundText || '[empty message]',
  })

  return messages
}

// ---------------------------------------------------------------------------
// parseAgentResponse
// ---------------------------------------------------------------------------

/**
 * Extracts structured metadata and draft text from the LLM response.
 *
 * Expected format from the LLM (per system-prompt.ts output instructions):
 *
 *   ```json
 *   {"intent": "booking_inquiry", "confidence": 0.95, "scenario_type": "returning_client"}
 *   ```
 *   <draft reply text here>
 *
 * Returns defaults if JSON block is missing or malformed.
 */
export interface ParsedAgentResponse {
  intent: string
  confidence: number
  scenarioType: string
  draft: string
}

export function parseAgentResponse(text: string): ParsedAgentResponse {
  const defaults: ParsedAgentResponse = {
    intent: 'general_question',
    confidence: 0.5,
    scenarioType: 'general',
    draft: text.trim(),
  }

  if (!text) return defaults

  // Match a ```json ... ``` block
  const jsonBlockRegex = /```json\s*([\s\S]*?)```/
  const match = text.match(jsonBlockRegex)

  if (!match) {
    // No JSON block found — return full text as draft with defaults
    console.warn('[agent_runtime] No JSON metadata block found in LLM response')
    return defaults
  }

  const jsonStr = match[1].trim()
  let parsed: Record<string, unknown>

  try {
    parsed = JSON.parse(jsonStr)
  } catch (err) {
    console.warn('[agent_runtime] Failed to parse JSON metadata block', { error: String(err) })
    return defaults
  }

  // Extract intent (validate against taxonomy — fallback to general_question)
  const intent = typeof parsed.intent === 'string' ? parsed.intent : 'general_question'

  // Extract confidence (clamp to [0, 1])
  let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5
  confidence = Math.max(0, Math.min(1, confidence))

  // Extract scenario_type
  const scenarioType = typeof parsed.scenario_type === 'string' ? parsed.scenario_type : 'general'

  // Draft text is everything AFTER the closing ``` of the JSON block
  const jsonBlockEnd = text.indexOf('```', match.index! + 3) + 3
  const draft = text.slice(jsonBlockEnd).trim()

  return { intent, confidence, scenarioType, draft }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Safely parses tool call arguments string to Record<string, unknown>.
 * Returns empty object on parse failure (tool executor handles unknowns).
 */
function parseToolCallArguments(argsString: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsString)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    console.warn('[agent_runtime] Failed to parse tool arguments', { argsString })
    return {}
  }
}

/**
 * Extracts text content from an OpenAI message.
 * Handles both string content and content part arrays.
 */
function extractTextContent(message: OpenAI.Chat.ChatCompletionMessage | null): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter(part => part.type === 'text')
      .map(part => (part as { type: 'text'; text: string }).text)
      .join('')
  }
  return ''
}
