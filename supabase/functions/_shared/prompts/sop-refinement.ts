// Prompt loader: reads the markdown prompt from global-context/prompts/
// Source of truth: global-context/prompts/sop-refinement.md

export interface SopRefinementInput {
  current_config: Record<string, unknown>
  instruction: string
}

let _systemPrompt: string | null = null

async function loadSystemPrompt(): Promise<string> {
  if (_systemPrompt) return _systemPrompt
  const md = await Deno.readTextFile(
    new URL('../../../../global-context/prompts/sop-refinement.md', import.meta.url)
  )
  const match = md.match(/## System Prompt\n\n([\s\S]*?)(?=\n## )/m)
  _systemPrompt = match?.[1]?.trim() ?? ''
  return _systemPrompt
}

export async function buildSopRefinementPrompt(input: SopRefinementInput): Promise<{
  system: string
  user: string
}> {
  const system = await loadSystemPrompt()

  const user = `Current configuration:
${JSON.stringify(input.current_config, null, 2)}

Requested change:
${input.instruction}`

  return { system, user }
}
