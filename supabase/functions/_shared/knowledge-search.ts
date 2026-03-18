// supabase/functions/_shared/knowledge-search.ts
// pgvector cosine similarity search, workspace-scoped

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { KnowledgeChunk } from './sprint2-types.ts'
import { generateEmbedding } from './embedding.ts'

interface SearchOptions {
  topK?: number
  minSimilarity?: number
  tokenBudget?: number
}

/**
 * Semantic search against workspace knowledge base.
 * Returns top-K chunks by cosine similarity, within token budget.
 */
export async function searchKnowledge(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
  options: SearchOptions = {}
): Promise<KnowledgeChunk[]> {
  const { topK = 5, minSimilarity = 0.7, tokenBudget = 2000 } = options

  if (!query || query.trim().length === 0) return []

  // 1. Generate query embedding
  const embedding = await generateEmbedding(query)

  // 2. Call pgvector search RPC
  const { data: chunks, error } = await supabase.rpc('search_knowledge_chunks', {
    query_embedding: JSON.stringify(embedding),
    match_workspace_id: workspaceId,
    match_count: topK,
    min_similarity: minSimilarity,
  })

  if (error) {
    console.error('[knowledge_search] RPC failed:', error.message)
    return []
  }

  if (!chunks || chunks.length === 0) return []

  // 3. Apply token budget (rough estimate: 1 token ~= 4 chars)
  return applyTokenBudget(
    chunks.map((c: Record<string, unknown>) => ({
      id: c.id as string,
      content: c.content as string,
      source: c.source as string,
      sourceRef: (c.source_ref as string) ?? null,
      similarity: c.similarity as number,
    })),
    tokenBudget
  )
}

function applyTokenBudget(
  chunks: KnowledgeChunk[],
  tokenBudget: number
): KnowledgeChunk[] {
  const result: KnowledgeChunk[] = []
  let tokenCount = 0

  for (const chunk of chunks) {
    const chunkTokens = Math.ceil(chunk.content.length / 4)
    if (tokenCount + chunkTokens > tokenBudget) break
    result.push(chunk)
    tokenCount += chunkTokens
  }

  return result
}
