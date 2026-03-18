// supabase/functions/_shared/tool-executor.ts
// Critical safety mechanism: injects workspaceId + clientId on EVERY tool call
// LLM-provided values are silently overwritten (architecture-final.md SS 6.4)
//
// ┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
// │ LLM tool call│────▶│ Parameter Injector │────▶│ Tool Execute │
// │ (untrusted)  │     │ workspaceId ←session│    │ (trusted)    │
// └──────────────┘     │ clientId   ←session │    └──────────────┘
//                      └───────────────────┘

import type { ToolRegistry, ToolResult, LLMToolCall } from './sprint2-types.ts'

interface Session {
  workspaceId: string
  clientId: string
  conversationId: string
}

export async function executeToolCall(
  call: LLMToolCall,
  session: Session,
  toolRegistry: ToolRegistry
): Promise<ToolResult> {
  const tool = toolRegistry[call.name]
  if (!tool) {
    console.warn('[tool_executor] Unknown tool:', call.name)
    return { output: { error: `Unknown tool: ${call.name}` } }
  }

  // Security: log if LLM attempted to override session-scoped fields
  const args = call.arguments ?? {}
  if (args.workspaceId && args.workspaceId !== session.workspaceId) {
    console.warn('[security] LLM attempted to override workspaceId', {
      attempted: args.workspaceId,
      injected: session.workspaceId,
      tool: call.name,
    })
  }
  if (args.clientId && args.clientId !== session.clientId) {
    console.warn('[security] LLM attempted to override clientId', {
      attempted: args.clientId,
      injected: session.clientId,
      tool: call.name,
    })
  }

  // Merge: LLM args first, then session overwrite, then fixed params
  const params = {
    ...args,
    workspaceId: session.workspaceId,
    clientId: session.clientId,
    conversationId: session.conversationId,
    ...tool.fixedParams,
  }

  try {
    return await tool.execute(params)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[tool_executor] ${call.name} failed:`, message)
    return { output: { error: message } }
  }
}
