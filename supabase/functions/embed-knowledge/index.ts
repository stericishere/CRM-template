// supabase/functions/embed-knowledge/index.ts
//
// Chunks text, generates embeddings via OpenAI, and upserts to knowledge_chunks.
// Called when a workspace knowledge base is created or updated (F-01 onboarding).
//
// Flow:
//
//   POST /embed-knowledge
//        │
//        ├─ validate { workspace_id, content, source }
//        │
//        ├─ DELETE existing chunks for (workspace_id, source)   ← idempotent re-embed
//        │
//        ├─ chunkText(content, 500 chars)
//        │      ├─ split on paragraph breaks (\n\n+)
//        │      └─ overflow paragraphs → sentence-level splits
//        │
//        ├─ generateEmbeddings(chunks[])   ← batch OpenAI call
//        │
//        └─ INSERT knowledge_chunks rows with pgvector embeddings

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { getSupabaseClient } from '../_shared/db.ts'
import { generateEmbeddings } from '../_shared/embedding.ts'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    const { workspace_id, content, source } = await req.json()

    if (!workspace_id || !content || !source) {
      return new Response(
        JSON.stringify({ error: 'Missing workspace_id, content, or source' }),
        { status: 400 }
      )
    }

    const supabase = getSupabaseClient()

    // 1. Delete existing chunks for this source (re-embed on update)
    await supabase
      .from('knowledge_chunks')
      .delete()
      .eq('workspace_id', workspace_id)
      .eq('source', source)

    // 2. Chunk the content
    const chunks = chunkText(content, 500)

    if (chunks.length === 0) {
      return new Response(JSON.stringify({ chunks: 0 }), { status: 200 })
    }

    // 3. Generate embeddings for all chunks
    const embeddings = await generateEmbeddings(chunks)

    // 4. Upsert chunks with embeddings
    const rows = chunks.map((text, i) => ({
      workspace_id,
      content: text,
      source,
      source_ref: `chunk-${i + 1}`,
      embedding: JSON.stringify(embeddings[i]),
    }))

    const { error } = await supabase.from('knowledge_chunks').insert(rows)

    if (error) {
      console.error('[embed-knowledge] Insert failed:', error.message)
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    console.log(`[embed-knowledge] Embedded ${chunks.length} chunks for workspace ${workspace_id}`)

    return new Response(
      JSON.stringify({ chunks: chunks.length, source }),
      { status: 200 }
    )
  } catch (err) {
    console.error('[embed-knowledge] Error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})

/**
 * Splits text into chunks of at most maxChars characters.
 *
 * Strategy:
 *  1. Split on double-newlines (paragraph boundaries).
 *  2. Accumulate paragraphs into a chunk until adding the next would exceed maxChars.
 *  3. For paragraphs that are themselves longer than maxChars, fall back to
 *     sentence-level splitting on trailing punctuation (.!?) whitespace.
 *
 * Returns an array of non-empty trimmed strings.
 */
function chunkText(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)
  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxChars) {
      current += (current ? '\n\n' : '') + para
    } else {
      if (current) chunks.push(current.trim())
      if (para.length > maxChars) {
        // Paragraph too large — split on sentence boundaries
        const sentences = para.split(/(?<=[.!?])\s+/)
        current = ''
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 <= maxChars) {
            current += (current ? ' ' : '') + sentence
          } else {
            if (current) chunks.push(current.trim())
            current = sentence
          }
        }
      } else {
        current = para
      }
    }
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks
}
