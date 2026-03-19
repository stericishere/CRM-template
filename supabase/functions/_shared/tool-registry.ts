// supabase/functions/_shared/tool-registry.ts
// Defines all tools available to the Client Worker LLM agent
//
// Authority levels:
//   read          — executes immediately, returns data to LLM
//   auto_write    — executes immediately, persists data without approval
//   propose_write — returns ProposedAction; never commits directly
//
// Flow diagram:
//
//   LLM tool call
//        |
//        v
//   tool.execute(params + injected context)
//        |
//        +--[read]-----------> ToolResult { output }
//        |
//        +--[auto_write]------> ToolResult { output } (DB write done)
//        |
//        +--[propose_write]---> ToolResult { output, proposedAction }
//                                              |
//                                              v
//                                    approval queue (F-06)

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type {
  ToolDefinition,
  ToolRegistry,
  ToolResult,
  ProposedAction,
} from './sprint2-types.ts'
import { searchKnowledge } from './knowledge-search.ts'

// ---------------------------------------------------------------------------
// buildToolDefinitions
// ---------------------------------------------------------------------------

/**
 * Convert a ToolRegistry to OpenAI-compatible tool definitions.
 * Calendar tools are excluded when the workspace has no calendar connected.
 * workspaceId / clientId are NOT included in schemas — they are injected
 * by the tool executor at runtime and must not be sent to the LLM.
 */
export function buildToolDefinitions(
  registry: ToolRegistry,
  workspace: { calendarConnected: boolean }
): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  return Object.values(registry)
    .filter(tool => {
      // Exclude calendar tools if calendar is not connected
      if (
        !workspace.calendarConnected &&
        (tool.name === 'calendar_query' || tool.name === 'calendar_book')
      ) {
        return false
      }
      return true
    })
    .map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toolParamsToJsonSchema(tool.name),
      },
    }))
}

/**
 * JSON Schema parameter definitions for each tool.
 * Excludes workspaceId / clientId — injected at execution time.
 */
function toolParamsToJsonSchema(toolName: string): Record<string, unknown> {
  const schemas: Record<string, Record<string, unknown>> = {
    knowledge_search: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for the knowledge base' },
      },
      required: ['query'],
    },

    calendar_query: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date (ISO 8601)' },
        end_date: { type: 'string', description: 'End date (ISO 8601)' },
        appointment_type: {
          type: 'string',
          description: 'Type of appointment (optional)',
        },
      },
      required: ['start_date', 'end_date'],
    },

    calendar_book: {
      type: 'object',
      properties: {
        appointment_type: {
          type: 'string',
          description: 'Service type (must match one of the configured appointment types)',
        },
        start_time: {
          type: 'string',
          description: 'Proposed start time (ISO 8601, e.g. 2026-03-20T14:00:00+08:00)',
        },
        notes: { type: 'string', description: 'Additional notes (optional)' },
      },
      required: ['appointment_type', 'start_time'],
    },

    update_client: {
      type: 'object',
      properties: {
        changes: {
          type: 'object',
          description: 'Key-value pairs of fields to update on the client record',
        },
      },
      required: ['changes'],
    },

    create_note: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note content' },
        type: {
          type: 'string',
          enum: ['observation', 'preference', 'context_update'],
          description: 'Note category',
        },
      },
      required: ['content', 'type'],
    },

    create_followup: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Follow-up task description' },
        due_date: { type: 'string', description: 'Due date (ISO 8601, optional)' },
      },
      required: ['description'],
    },
  }

  return schemas[toolName] ?? { type: 'object', properties: {} }
}

// ---------------------------------------------------------------------------
// createToolRegistry
// ---------------------------------------------------------------------------

/**
 * Create the tool registry with a bound Supabase client.
 * All execute functions receive params that already contain injected
 * context (workspaceId, clientId, conversationId) from the tool executor.
 */
export function createToolRegistry(supabase: SupabaseClient): ToolRegistry {
  const tools: Record<string, ToolDefinition> = {
    // -----------------------------------------------------------------------
    // knowledge_search — read
    // Semantic search over workspace knowledge base via pgvector
    // -----------------------------------------------------------------------
    knowledge_search: {
      name: 'knowledge_search',
      description:
        'Search the workspace knowledge base for relevant information about services, pricing, policies, etc.',
      authority: 'read',
      fixedParams: {},
      execute: async (params): Promise<ToolResult> => {
        const chunks = await searchKnowledge(
          supabase,
          params.workspaceId as string,
          params.query as string,
          { topK: 3, tokenBudget: 1500 }
        )
        return {
          output: chunks.map(c => ({
            content: c.content,
            source: c.source,
            similarity: c.similarity,
          })),
        }
      },
    },

    // -----------------------------------------------------------------------
    // calendar_query — read (stub for Sprint 3)
    // Returns a stub response until Google Calendar is integrated
    // -----------------------------------------------------------------------
    calendar_query: {
      name: 'calendar_query',
      description: 'Query available appointment slots from the business calendar.',
      authority: 'read',
      fixedParams: {},
      execute: async (_params): Promise<ToolResult> => {
        // Sprint 3: Google Calendar integration
        return {
          output: { message: 'Calendar not yet connected. Suggest manual scheduling.' },
        }
      },
    },

    // -----------------------------------------------------------------------
    // calendar_book — propose_write
    // Proposes a booking; never commits directly — goes to approval queue
    // -----------------------------------------------------------------------
    calendar_book: {
      name: 'calendar_book',
      description:
        'Propose a booking for a client. Specify the service type and start time. ' +
        'Duration is determined by the service type configuration. Requires staff approval.',
      authority: 'propose_write',
      fixedParams: {},
      execute: async (params): Promise<ToolResult> => {
        const appointmentType = params.appointment_type as string
        const startTime = params.start_time as string

        const action: ProposedAction = {
          workspaceId: params.workspaceId as string,
          clientId: params.clientId as string,
          conversationId: params.conversationId as string,
          actionType: 'booking_create',
          summary: `Book ${appointmentType} at ${startTime}`,
          tier: 'review',
          payload: {
            appointmentType,
            startTime,
            notes: params.notes ?? null,
          },
          status: 'pending',
        }
        return { output: { proposed: true, summary: action.summary }, proposedAction: action }
      },
    },

    // -----------------------------------------------------------------------
    // update_client — propose_write
    // Proposes a client record change; never commits directly
    // -----------------------------------------------------------------------
    update_client: {
      name: 'update_client',
      description: 'Propose an update to the client record (name, preferences, tags, etc.).',
      authority: 'propose_write',
      fixedParams: {},
      execute: async (params): Promise<ToolResult> => {
        const changes = params.changes as Record<string, unknown>
        const action: ProposedAction = {
          workspaceId: params.workspaceId as string,
          clientId: params.clientId as string,
          conversationId: params.conversationId as string,
          actionType: 'client_update',
          summary: `Update client: ${Object.keys(changes).join(', ')}`,
          tier: 'review',
          payload: { changes },
          status: 'pending',
        }
        return { output: { proposed: true, summary: action.summary }, proposedAction: action }
      },
    },

    // -----------------------------------------------------------------------
    // create_note — auto_write
    // Immediately persists an observation note; no approval needed
    // fixedParams: { source: 'ai_extracted' } — always stamped at execution time
    // -----------------------------------------------------------------------
    create_note: {
      name: 'create_note',
      description: 'Create an observation note about this client interaction. Auto-saved.',
      authority: 'auto_write',
      fixedParams: { source: 'ai_extracted' },
      execute: async (params): Promise<ToolResult> => {
        const { error } = await supabase.from('notes').insert({
          workspace_id: params.workspaceId,
          client_id: params.clientId,
          content: params.content,
          source: 'ai_extracted',
        })

        if (error) {
          console.error('[create_note] Failed:', error.message)
          return { output: { success: false, error: error.message } }
        }

        return { output: { success: true } }
      },
    },

    // -----------------------------------------------------------------------
    // create_followup — propose_write
    // Proposes a follow-up task; never commits directly
    // -----------------------------------------------------------------------
    create_followup: {
      name: 'create_followup',
      description: 'Propose a follow-up task for this client. Requires staff approval.',
      authority: 'propose_write',
      fixedParams: {},
      execute: async (params): Promise<ToolResult> => {
        const action: ProposedAction = {
          workspaceId: params.workspaceId as string,
          clientId: params.clientId as string,
          conversationId: params.conversationId as string,
          actionType: 'followup_create',
          summary: `Follow up: ${params.description as string}`,
          tier: 'review',
          payload: {
            description: params.description,
            dueDate: (params.due_date as string | undefined) ?? null,
          },
          status: 'pending',
        }
        return { output: { proposed: true, summary: action.summary }, proposedAction: action }
      },
    },
  }

  return tools
}
