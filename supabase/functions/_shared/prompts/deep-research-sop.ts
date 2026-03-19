// Prompt loader: reads the markdown prompt from global-context/prompts/
// Source of truth: global-context/prompts/deep-research-sop.md

export interface DeepResearchSopInput {
  vertical: string
  business_name: string
  description?: string
  knowledge_base?: string
}

let _systemPrompt: string | null = null

async function loadSystemPrompt(): Promise<string> {
  if (_systemPrompt) return _systemPrompt
  const md = await Deno.readTextFile(
    new URL('../../../../global-context/prompts/deep-research-sop.md', import.meta.url)
  )
  const match = md.match(/## System Prompt\n\n([\s\S]*?)(?=\n## )/m)
  _systemPrompt = match?.[1]?.trim() ?? ''
  return _systemPrompt
}

export async function buildDeepResearchSopPrompt(input: DeepResearchSopInput): Promise<{
  system: string
  user: string
}> {
  const system = await loadSystemPrompt()

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
