// global-context/memory.ts
// MEMORY — learned patterns from past interactions
// Communication rules promoted from learning signals

import type { AgentMemory, CommunicationRule } from '../supabase/functions/_shared/sprint2-types.ts'

export function buildAgentMemory(workspace: Record<string, unknown>): AgentMemory {
  return {
    communicationRules: parseCommunicationRules(workspace.communication_profile),
  }
}

function parseCommunicationRules(profile: unknown): CommunicationRule[] {
  if (!profile || typeof profile !== 'object') return []
  const p = profile as Record<string, unknown>
  return Array.isArray(p.rules) ? p.rules : []
}
