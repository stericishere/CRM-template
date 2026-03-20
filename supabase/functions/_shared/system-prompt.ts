// supabase/functions/_shared/system-prompt.ts
// Composes dynamic system prompt from GlobalContext + global-context/*.md templates
//
// ┌──────────────────────┐     ┌──────────────────────────┐
// │ global-context/*.md   │     │ GlobalContext (from DB)   │
// │ (prompt templates)    │     │ (workspace data)          │
// └──────────┬───────────┘     └────────────┬─────────────┘
//            │                              │
//            v                              v
//     ┌──────────────────────────────────────────┐
//     │         composeSystemPrompt()             │
//     │  template sections + dynamic data → str   │
//     └──────────────────────────────────────────┘

import type { GlobalContext } from './sprint2-types.ts'
import { loadMarkdownSection } from './markdown-loader.ts'

/**
 * Compose the system prompt from GlobalContext + global-context/ markdown templates.
 * Each section maps to a .md file in global-context/.
 */
export async function composeSystemPrompt(global: GlobalContext): Promise<string> {
  const { identity, agent, tools, businessContext, memory } = global

  // Load static prompt sections from markdown
  const [rolePreamble, outputFormat, calendarDisabledMsg] = await Promise.all([
    loadMarkdownSection('role.md', 'System Prompt'),
    loadMarkdownSection('role.md', 'Output Format'),
    loadMarkdownSection('tools.md', 'Calendar Not Connected'),
  ])

  const sections: string[] = [rolePreamble]

  // --- IDENTITY (identity.md) ---
  sections.push(`## Business Identity
Business: ${identity.businessName}
Vertical: ${identity.vertical}${identity.description ? `\nDescription: ${identity.description}` : ''}`)

  if (identity.toneProfile) {
    sections.push(`## Tone and Voice
${identity.toneProfile}`)
  }

  // --- AGENT (agent.md) ---
  if (agent.sopRules.length > 0) {
    sections.push(`## SOP Rules
${agent.sopRules.map(r => `- ${r}`).join('\n')}`)
  }

  if (agent.customFields.length > 0) {
    sections.push(`## Custom Fields
${agent.customFields.map(f => `- ${f.name}: ${f.description}`).join('\n')}`)
  }

  if (agent.appointmentTypes.length > 0) {
    sections.push(`## Appointment Types
${agent.appointmentTypes.map(t => `- ${t.name}: ${t.description}`).join('\n')}`)
  }

  sections.push(`## Intent Classification
Classify every message into exactly one primary intent: ${agent.intentTaxonomy.join(', ')}.
If multiple intents are present, classify the most actionable one as primary.
Report your confidence as a float between 0.0 and 1.0.`)

  // --- TOOLS (tools.md) ---
  if (!tools.calendarConnected) {
    sections.push(calendarDisabledMsg)
  }

  // --- BUSINESS CONTEXT (business.md) ---
  sections.push(`## Business Context
Timezone: ${businessContext.timezone}
Business Hours: ${formatBusinessHours(businessContext.businessHours)}
Appointment Reminders: ${businessContext.scheduledReminder.enabled ? `Enabled (${businessContext.scheduledReminder.daysBefore} day before)` : 'Disabled'}`)

  // --- MEMORY (memory.md) ---
  if (memory.communicationRules.length > 0) {
    sections.push(`## Communication Rules (Learned from past interactions)
${memory.communicationRules.map(r => `- ${r.rule}`).join('\n')}`)
  }

  // --- OUTPUT FORMAT (role.md) ---
  sections.push(`## Output Format\n${outputFormat}`)

  return sections.join('\n\n')
}

function formatBusinessHours(
  hours: Record<string, { open: string; close: string }> | null
): string {
  if (!hours) return 'Not specified'
  return Object.entries(hours)
    .map(([day, h]) => `${day}: ${h.open}-${h.close}`)
    .join(', ')
}
