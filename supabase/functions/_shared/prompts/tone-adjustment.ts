// Prompt loader: reads the markdown prompt from global-context/
// Source of truth: global-context/tone-adjustment.md

import { loadMarkdownSection } from '../markdown-loader.ts'

export interface ToneAdjustmentInput {
  current_tone: Record<string, unknown>
  feedback: string
}

export async function buildToneAdjustmentPrompt(input: ToneAdjustmentInput): Promise<{
  system: string
  user: string
}> {
  const system = await loadMarkdownSection('tone-adjustment.md', 'System Prompt')

  const user = `Current tone profile:
${JSON.stringify(input.current_tone, null, 2)}

Feedback from business owner:
${input.feedback}`

  return { system, user }
}
