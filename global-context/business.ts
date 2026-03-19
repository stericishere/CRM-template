// global-context/business.ts
// Business Context — hours, timezone, scheduling, reminders
// Operational details that affect how the agent handles time-sensitive requests

import type { BusinessContext } from '../supabase/functions/_shared/sprint2-types.ts'

export function buildBusinessContext(workspace: Record<string, unknown>): BusinessContext {
  return {
    timezone: (workspace.timezone as string) ?? 'UTC',
    businessHours: workspace.business_hours as Record<string, { open: string; close: string }> | null,
    scheduledReminder: {
      enabled: (workspace.scheduled_reminder_enabled as boolean) ?? true,
      daysBefore: (workspace.scheduled_reminder_days_before as number) ?? 1,
    },
  }
}
