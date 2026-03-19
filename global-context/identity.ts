// global-context/identity.ts
// BUSINESS.md — who this business is
// Editable by owner during onboarding and in workspace settings

import type { BusinessIdentity } from '../supabase/functions/_shared/sprint2-types.ts'

export function buildIdentity(workspace: Record<string, unknown>): BusinessIdentity {
  return {
    businessName: workspace.business_name as string,
    vertical: (workspace.vertical_type as string) ?? 'general',
    description: (workspace.business_description as string) ?? null,
    toneProfile: (workspace.tone_profile as string) ?? null,
  }
}
