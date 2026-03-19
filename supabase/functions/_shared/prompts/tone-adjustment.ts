// Prompt loader: reads the markdown prompt from global-context/prompts/
// Source of truth: global-context/prompts/tone-adjustment.md

export interface ToneAdjustmentInput {
  current_tone: Record<string, unknown>
  feedback: string
}

let _systemPrompt: string | null = null

async function loadSystemPrompt(): Promise<string> {
  if (_systemPrompt) return _systemPrompt
  const md = await Deno.readTextFile(
    new URL('../../../../global-context/prompts/tone-adjustment.md', import.meta.url)
  )
  const match = md.match(/## System Prompt\n\n([\s\S]*?)(?=\n## )/m)
  _systemPrompt = match?.[1]?.trim() ?? ''
  return _systemPrompt
}

export async function buildToneAdjustmentPrompt(input: ToneAdjustmentInput): Promise<{
  system: string
  user: string
}> {
  const system = await loadSystemPrompt()

  const user = `Current tone profile:
${JSON.stringify(input.current_tone, null, 2)}

Feedback from business owner:
${input.feedback}`

  return { system, user }
}
