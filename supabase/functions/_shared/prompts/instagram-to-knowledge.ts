// Prompt loader: reads the markdown prompt from global-context/prompts/
// Source of truth: global-context/prompts/instagram-to-knowledge.md

export interface InstagramToKnowledgeInput {
  handle: string
  bio: string | null
  business_category: string | null
  post_captions: string[]
}

let _systemPrompt: string | null = null

async function loadSystemPrompt(): Promise<string> {
  if (_systemPrompt) return _systemPrompt
  const md = await Deno.readTextFile(
    new URL('../../../../global-context/prompts/instagram-to-knowledge.md', import.meta.url)
  )
  // Extract content between "## System Prompt" and the next "##" heading
  const match = md.match(/## System Prompt\n\n([\s\S]*?)(?=\n## )/m)
  _systemPrompt = match?.[1]?.trim() ?? ''
  return _systemPrompt
}

export async function buildInstagramToKnowledgePrompt(input: InstagramToKnowledgeInput): Promise<{
  system: string
  user: string
}> {
  const system = await loadSystemPrompt()

  const captionsBlock = input.post_captions.length > 0
    ? input.post_captions.map((c, i) => `[Post ${i + 1}]: ${c}`).join('\n')
    : 'No post captions available.'

  const user = `Instagram handle: @${input.handle}
Bio: ${input.bio ?? 'Not available'}
Business category: ${input.business_category ?? 'Not specified'}

Recent post captions:
${captionsBlock}`

  return { system, user }
}
