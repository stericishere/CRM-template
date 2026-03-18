// supabase/functions/_shared/embedding.ts
// Embeddings via OpenRouter (EMBEDDING_MODEL from env)
// Used for knowledge base indexing and query-time search

import OpenAI from 'https://esm.sh/openai@4'

const EMBEDDING_MODEL = Deno.env.get('EMBEDDING_MODEL') ?? 'text-embedding-3-small'

let _client: OpenAI | null = null

function getEmbeddingClient(): OpenAI {
  if (_client) return _client

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY environment variable')
  }

  _client = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': Deno.env.get('SITE_URL') ?? 'https://crm-template.vercel.app',
      'X-Title': 'CRM Template',
    },
  })
  return _client
}

/**
 * Generate an embedding for a text string.
 * Dimension depends on the model configured via EMBEDDING_MODEL env var.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getEmbeddingClient()

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000), // Hard limit to prevent token overflow
  })

  const embedding = response.data[0]?.embedding
  if (!embedding) throw new Error('Embedding API returned no data')
  return embedding
}

/**
 * Generate embeddings for multiple texts in a single API call.
 */
export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const client = getEmbeddingClient()

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map(t => t.slice(0, 8000)),
  })

  return response.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding)
}
