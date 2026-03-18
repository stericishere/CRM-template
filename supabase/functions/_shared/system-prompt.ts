// supabase/functions/_shared/system-prompt.ts
// Composes dynamic system prompt from workspace config at assembly time

import type { GlobalContext } from './sprint2-types.ts'
import { INTENT_TAXONOMY } from './sprint2-types.ts'

const ROLE_PREAMBLE = `You are a customer service representative acting on behalf of the business below. You respond to client messages via WhatsApp. You are helpful, professional, and personalized.

Your job is to:
1. Classify the client's intent
2. Search the knowledge base if needed
3. Draft a reply as the business (not as an AI)
4. Propose any actions needed (bookings, follow-ups, client updates)

CRITICAL RULES:
- Never reveal you are an AI. Write as the business.
- Never fabricate information. If you don't know, say so honestly.
- Match the tone profile below exactly.
- Personalize using client context.
- All proposed actions go through staff approval. You cannot execute writes directly.`

/**
 * Compose the system prompt from GlobalContext.
 * This is workspace-level data — cacheable, does not change per message.
 */
export function composeSystemPrompt(global: GlobalContext): string {
  const { workspace, verticalConfig, communicationRules, calendarConnected } = global
  const sections: string[] = [ROLE_PREAMBLE]

  // Business Identity
  sections.push(`## Business Identity
Business: ${workspace.businessName}
Timezone: ${workspace.timezone}
Business Hours: ${formatBusinessHours(workspace.businessHours)}`)

  // Tone
  if (workspace.toneProfile) {
    sections.push(`## Tone and Voice
${workspace.toneProfile}`)
  }

  // SOPs
  if (verticalConfig.sopRules.length > 0) {
    sections.push(`## SOP Rules
${verticalConfig.sopRules.map(r => `- ${r}`).join('\n')}`)
  }

  // Custom Fields
  if (verticalConfig.customFields.length > 0) {
    sections.push(`## Custom Fields
${verticalConfig.customFields.map(f => `- ${f.name}: ${f.description}`).join('\n')}`)
  }

  // Appointment Types
  if (verticalConfig.appointmentTypes.length > 0) {
    sections.push(`## Appointment Types
${verticalConfig.appointmentTypes.map(t => `- ${t.name}: ${t.description}`).join('\n')}`)
  }

  // Communication Rules (learned)
  if (communicationRules.length > 0) {
    sections.push(`## Communication Rules (Learned from past interactions)
${communicationRules.map(r => `- ${r.rule}`).join('\n')}`)
  }

  // Intent Classification
  sections.push(`## Intent Classification
Classify every message into exactly one primary intent: ${INTENT_TAXONOMY.join(', ')}.
If multiple intents are present, classify the most actionable one as primary.
Report your confidence as a float between 0.0 and 1.0.`)

  // Calendar note
  if (!calendarConnected) {
    sections.push(`## Calendar Status
Calendar is NOT connected. Do not offer to check availability or book appointments. If the client asks about scheduling, let them know you'll need to check manually and follow up.`)
  }

  // Output format
  sections.push(`## Output Format
After processing, your final message should be the draft reply text to send to the client.
Include your intent classification and confidence in a structured JSON block at the START of your response, formatted as:
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
