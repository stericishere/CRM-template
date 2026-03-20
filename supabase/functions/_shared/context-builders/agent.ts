// context-builders/agent.ts
// AGENT — behavior rules, SOPs, intent taxonomy, custom fields
// Defines what the agent can do and how it should behave

import type { AgentConfig } from '../sprint2-types.ts'
import { INTENT_TAXONOMY } from '../sprint2-types.ts'

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
    customFields: Array.isArray(c.custom_fields) ? c.custom_fields : [],
    appointmentTypes: Array.isArray(c.appointment_types) ? c.appointment_types : [],
    sopRules: Array.isArray(c.sop_rules) ? c.sop_rules : [],
  }
}
