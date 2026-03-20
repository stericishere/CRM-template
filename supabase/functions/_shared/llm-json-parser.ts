// Shared LLM JSON response parser
// Strips markdown fences and parses JSON from LLM output
// Used by onboarding-sops, onboarding-tone, onboarding-scrape, agent-runtime

/**
 * Extracts JSON from an LLM response, stripping markdown fences if present.
 * Throws on invalid JSON so the caller can handle the error.
 */
export function parseJsonFromLLM<T>(raw: string, logPrefix: string): T {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonStr = fenceMatch ? fenceMatch[1]?.trim() ?? raw.trim() : raw.trim()

  try {
    return JSON.parse(jsonStr) as T
  } catch {
    console.error(`[${logPrefix}] Failed to parse LLM JSON:`, jsonStr.slice(0, 500))
    throw new Error('LLM returned invalid JSON — retry or refine the prompt')
  }
}
