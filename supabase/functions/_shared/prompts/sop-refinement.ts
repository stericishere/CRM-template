// Prompt loader: reads the markdown prompt from global-context/
// Source of truth: global-context/sop-refinement.md

import { loadMarkdownSection } from '../markdown-loader.ts'

export interface SopRefinementInput {
  current_config: Record<string, unknown>
  instruction: string
}

export async function buildSopRefinementPrompt(input: SopRefinementInput): Promise<{
  system: string
  user: string
}> {
  const system = await loadMarkdownSection('sop-refinement.md', 'System Prompt')

  const user = `Current configuration:
${JSON.stringify(input.current_config, null, 2)}

Requested change:
${input.instruction}`

  return { system, user }
}
