// global-context/index.ts
// Router — assembles GlobalContext from individual context modules
//
// ┌──────────────┐  ┌───────────┐  ┌───────────┐
// │ BUSINESS.md  │  │  AGENT    │  │  TOOLS    │
// │ (identity)   │  │ (SOPs)    │  │ (config)  │
// └──────┬───────┘  └─────┬─────┘  └─────┬─────┘
//        │                │              │
//        v                v              v
//  ┌─────────────────────────────────────────────┐
//  │            GlobalContext                      │
//  │  ┌──────────┐  ┌────────┐  ┌───────────┐   │
//  │  │ BUSINESS │  │ MEMORY │  │ HEARTBEAT │   │
//  │  └──────────┘  └────────┘  └───────────┘   │
//  └─────────────────────────────────────────────┘

import type { GlobalContext } from '../supabase/functions/_shared/sprint2-types.ts'
import { buildIdentity } from './identity.ts'
import { buildAgentConfig } from './agent.ts'
import { buildToolsConfig } from './tools.ts'
import { buildBusinessContext } from './business.ts'
import { buildAgentMemory } from './memory.ts'
import { buildHeartbeat } from './heartbeat.ts'

/**
 * Build the complete GlobalContext from a workspace record.
 * Each section is built by its own module for clarity and editability.
 */
export function buildGlobalContext(
  workspaceId: string,
  workspace: Record<string, unknown>
): GlobalContext {
  return {
    identity: buildIdentity(workspace),
    agent: buildAgentConfig(workspace),
    tools: buildToolsConfig(workspace),
    businessContext: buildBusinessContext(workspace),
    memory: buildAgentMemory(workspace),
    heartbeat: buildHeartbeat(workspaceId, workspace),
  }
}

// Re-export individual builders for direct access
export { buildIdentity } from './identity.ts'
export { buildAgentConfig } from './agent.ts'
export { buildToolsConfig } from './tools.ts'
export { buildBusinessContext } from './business.ts'
export { buildAgentMemory } from './memory.ts'
export { buildHeartbeat } from './heartbeat.ts'
