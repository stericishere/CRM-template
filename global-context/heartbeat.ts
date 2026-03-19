// global-context/heartbeat.ts
// HEARTBEAT — current operational status of the workspace
// Used to determine if the agent should be active or paused

import type { AgentHeartbeat } from '../supabase/functions/_shared/sprint2-types.ts'

export function buildHeartbeat(
  workspaceId: string,
  workspace: Record<string, unknown>
): AgentHeartbeat {
  return {
    workspaceId,
    status: workspace.onboarding_status === 'active' ? 'active' : 'onboarding',
  }
}
