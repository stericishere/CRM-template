// Prompt loader: reads the markdown prompt from global-context/
// Source of truth: global-context/instagram-to-knowledge.md

import { loadMarkdownSection } from '../markdown-loader.ts'

export interface InstagramToKnowledgeInput {
  handle: string
  bio: string | null
  business_category: string | null
  post_captions: string[]
}

export async function buildInstagramToKnowledgePrompt(input: InstagramToKnowledgeInput): Promise<{
  system: string
  user: string
}> {
  const system = await loadMarkdownSection('instagram-to-knowledge.md', 'System Prompt')

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
