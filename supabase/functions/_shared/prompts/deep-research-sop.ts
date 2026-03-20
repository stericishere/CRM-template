// Prompt loader: reads the markdown prompt from global-context/
// Source of truth: global-context/deep-research-sop.md

import { loadMarkdownSection } from '../markdown-loader.ts'

export interface DeepResearchSopInput {
  vertical: string
  business_name: string
  description?: string
  knowledge_base?: string
}

export async function buildDeepResearchSopPrompt(input: DeepResearchSopInput): Promise<{
  system: string
  user: string
}> {
  const system = await loadMarkdownSection('deep-research-sop.md', 'System Prompt')

  let userContent = `Business name: ${input.business_name}
Vertical: ${input.vertical}`

  if (input.description) {
    userContent += `\nDescription: ${input.description}`
  }

  if (input.knowledge_base) {
    userContent += `\n\nKnowledge base (extracted from their online presence):\n${input.knowledge_base}`
  }

  return { system, user: userContent }
}
