// supabase/functions/_shared/system-prompt.ts
// Composes dynamic system prompt from GlobalContext sections
// Mirrors the global-context/ folder structure:
//   IDENTITY → AGENT → TOOLS → BUSINESS → MEMORY → HEARTBEAT

import type { GlobalContext } from './sprint2-types.ts'

const ROLE_PREAMBLE = `You are a customer service representative acting on behalf of the business below. You respond to client messages via WhatsApp. You are helpful, professional, and personalized.

CRITICAL RULES:
- Never reveal you are an AI. Write as the business.
- Never fabricate information. If you don't know, say so honestly.
- Match the tone profile exactly.
- Personalize using client context.
- All proposed actions go through staff approval. You cannot execute writes directly.`

/**
 * Compose the system prompt from GlobalContext.
 * Each section maps to a file in global-context/.
 */
export function composeSystemPrompt(global: GlobalContext): string {
  const { identity, agent, tools, businessContext, memory } = global
  const sections: string[] = [ROLE_PREAMBLE]

  // --- IDENTITY (BUSINESS.md) ---
  sections.push(`## Business Identity
Business: ${identity.businessName}
Vertical: ${identity.vertical}${identity.description ? `\nDescription: ${identity.description}` : ''}`)

  if (identity.toneProfile) {
    sections.push(`## Tone and Voice
${identity.toneProfile}`)
  }

  // --- AGENT ---
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

  // --- TOOLS ---
  if (!tools.calendarConnected) {
    sections.push(`## Calendar Status
Calendar is NOT connected. Do not offer to check availability or book appointments. If the client asks about scheduling, let them know you'll need to check manually and follow up.`)
  }

  // --- BUSINESS CONTEXT ---
  sections.push(`## Business Context
Timezone: ${businessContext.timezone}
Business Hours: ${formatBusinessHours(businessContext.businessHours)}
Appointment Reminders: ${businessContext.scheduledReminder.enabled ? `Enabled (${businessContext.scheduledReminder.daysBefore} day before)` : 'Disabled'}`)

  // --- MEMORY ---
  if (memory.communicationRules.length > 0) {
    sections.push(`## Communication Rules (Learned from past interactions)
${memory.communicationRules.map(r => `- ${r.rule}`).join('\n')}`)
  }

  // --- OUTPUT FORMAT ---
  sections.push(`## Output Format
Your final message should be the draft reply text to send to the client.
Include your intent classification and confidence in a structured JSON block at the START of your response:
\`\`\`json
{"intent": "booking_inquiry", "confidence": 0.95, "scenario_type": "returning_client"}
\`\`\`
Then write the draft reply text below it.`)

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
