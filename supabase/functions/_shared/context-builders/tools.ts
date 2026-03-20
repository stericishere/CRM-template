// context-builders/tools.ts
// TOOLS — available capabilities and their connection status
// Controls which tools the agent can use in conversation

import type { ToolsConfig } from '../sprint2-types.ts'

export function buildToolsConfig(workspace: Record<string, unknown>): ToolsConfig {
  return {
    calendarConnected: !!workspace.calendar_config,
    knowledgeBaseEnabled: true,
  }
}
