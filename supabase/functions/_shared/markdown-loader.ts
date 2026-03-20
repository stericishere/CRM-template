// supabase/functions/_shared/markdown-loader.ts
// Shared utility: loads a section from a markdown file in global-context/
// Used by system-prompt.ts and all prompt loaders in prompts/

const _cache: Record<string, string> = {}

/**
 * Load a specific `## Heading` section from a markdown file in global-context/.
 * Caches results per file:section for the lifetime of the Deno isolate.
 *
 * @param filename - markdown file name (e.g. 'role.md')
 * @param section  - plain heading text (e.g. 'System Prompt') — NOT a regex
 */
export async function loadMarkdownSection(filename: string, section: string): Promise<string> {
  const key = `${filename}\0${section}`
  if (_cache[key] !== undefined) return _cache[key]

  const md = await Deno.readTextFile(
    new URL(`../../../global-context/${filename}`, import.meta.url)
  )

  // Escape regex metacharacters so callers pass plain heading text
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`## ${escaped}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, 'm')
  const match = md.match(pattern)

  if (!match) {
    console.warn(`[markdown-loader] Section "## ${section}" not found in ${filename}`)
  }

  _cache[key] = match?.[1]?.trim() ?? ''
  return _cache[key]
}
