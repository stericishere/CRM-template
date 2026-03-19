// supabase/functions/_shared/embedding.ts
// Embeddings via OpenRouter (EMBEDDING_MODEL from env)
// Reuses the shared LLM client — same OpenRouter connection

import { getLLMClient, EMBEDDING_MODEL } from './llm-client.ts'

// Simple per-request cache to avoid duplicate embedding calls for the same text
const _cache = new Map<string, number[]>()

/**
 * Generate an embedding for a text string.
 * Caches by input text within the request lifetime.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const cached = _cache.get(text)
  if (cached) return cached

  const client = getLLMClient()

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000), // Hard limit to prevent token overflow
  })

  const embedding = response.data[0]?.embedding
  if (!embedding) throw new Error('Embedding API returned no data')

  _cache.set(text, embedding)
  return embedding
}

/**
 * Generate embeddings for multiple texts in a single API call.
 */
export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const client = getLLMClient()

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map(t => t.slice(0, 8000)),
  })

  const results = response.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding)

  // Cache individual results
  texts.forEach((t, i) => _cache.set(t, results[i]))

  return results
}
