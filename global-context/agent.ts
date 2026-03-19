// global-context/agent.ts
// AGENT — behavior rules, SOPs, intent taxonomy, custom fields
// Defines what the agent can do and how it should behave

import type { AgentConfig } from '../supabase/functions/_shared/sprint2-types.ts'
import { INTENT_TAXONOMY } from '../supabase/functions/_shared/sprint2-types.ts'

interface VerticalConfig {
  customFields: Array<{ name: string; description: string }>
  appointmentTypes: Array<{ name: string; description: string }>
  sopRules: string[]
}

export function buildAgentConfig(workspace: Record<string, unknown>): AgentConfig {
  const verticalConfig = parseVerticalConfig(workspace.vertical_config)
  return {
    sopRules: verticalConfig.sopRules,
    intentTaxonomy: INTENT_TAXONOMY,
    customFields: verticalConfig.customFields,
    appointmentTypes: verticalConfig.appointmentTypes,
  }
}

function parseVerticalConfig(config: unknown): VerticalConfig {
  if (!config || typeof config !== 'object') {
    return { customFields: [], appointmentTypes: [], sopRules: [] }
  }
  const c = config as Record<string, unknown>
  return {
    customFields: Array.isArray(c.customFields) ? c.customFields : [],
    appointmentTypes: Array.isArray(c.appointmentTypes) ? c.appointmentTypes : [],
    sopRules: Array.isArray(c.sopRules) ? c.sopRules : [],
  }
}
