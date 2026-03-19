// Prompt loader: reads the markdown prompt from global-context/prompts/
// Source of truth: global-context/prompts/tone-extraction.md

export interface ToneExtractionInput {
  source: 'instagram' | 'description'
  instagram_data?: {
    bio: string | null
    post_captions: string[]
  }
  description?: string
  business_name: string
  vertical: string
}

let _systemPrompt: string | null = null

async function loadSystemPrompt(): Promise<string> {
  if (_systemPrompt) return _systemPrompt
  const md = await Deno.readTextFile(
    new URL('../../../../global-context/prompts/tone-extraction.md', import.meta.url)
  )
  const match = md.match(/## System Prompt\n\n([\s\S]*?)(?=\n## )/m)
  _systemPrompt = match?.[1]?.trim() ?? ''
  return _systemPrompt
}

export async function buildToneExtractionPrompt(input: ToneExtractionInput): Promise<{
  system: string
  user: string
}> {
  const system = await loadSystemPrompt()

  let user: string

  if (input.source === 'instagram' && input.instagram_data) {
    const captions = input.instagram_data.post_captions.length > 0
      ? input.instagram_data.post_captions.map((c, i) => `[Post ${i + 1}]: ${c}`).join('\n')
      : 'No post captions available.'

    user = `Business: ${input.business_name} (${input.vertical})
Source: Instagram profile

Bio: ${input.instagram_data.bio ?? 'Not available'}

Recent post captions:
${captions}`
  } else {
    user = `Business: ${input.business_name} (${input.vertical})
Source: Owner description

${input.description ?? 'No description provided. Use sensible defaults for the vertical.'}`
  }

  return { system, user }
}
