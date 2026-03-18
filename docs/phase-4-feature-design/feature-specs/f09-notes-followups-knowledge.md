# Feature Spec -- F-09: Notes, Follow-ups & Knowledge Management

**Feature:** F-09 Notes, Follow-ups & Knowledge Management
**Phase:** 2 (AI Drafting & Booking)
**Size:** L (1-2 weeks)
**Status:** Implementable spec
**PRD Functions:** NF-01, NF-05, NF-06, ON-08, CI-03, CI-04
**User Stories:** US-F09-01 through US-F09-08
**Base Architecture:** `architecture-final.md` (Next.js API routes for staff CRUD, `embed-knowledge` Edge Function, pgvector, Supabase Storage, flat codebase)
**Dependencies:** F-01 (knowledge indexing pipeline for embed-knowledge), F-03 (client records exist)

---

## 0. Overview

F-09 covers four distinct staff-driven subsystems that share a common design principle: **no AI on the write path**. Notes, follow-ups, and knowledge edits are pure database writes via Next.js API routes. Document upload is the exception -- it triggers the `embed-knowledge` Edge Function for async chunking and embedding.

| Subsystem | Write path | AI involvement | Latency target |
|-----------|-----------|----------------|----------------|
| Notes CRUD | Next.js API route -> Supabase INSERT | None on write. Notes feed into context assembly (F-05) on read. | < 1s |
| Follow-ups CRUD | Next.js API route -> Supabase INSERT/UPDATE | None on write. Follow-ups feed into context assembly and COS (F-12). | < 1s |
| Document upload + knowledge management | Next.js API route -> Supabase Storage + Edge Function `embed-knowledge` | Embedding generation (OpenAI `text-embedding-3-small`) | Upload: < 2s. Processing: < 30s per document. |
| Client merge | Next.js API route -> Supabase transaction | None | < 5s |

All records are scoped by `workspace_id` per ADR-2. RLS policies enforce isolation. `workspace_id` is denormalized on `notes` for Supabase Realtime filtering.

---

## 1. Component Breakdown

Files follow the flat codebase structure from `architecture-final.md` section 13.

### 1.1 Next.js API Routes (Staff CRUD)

All staff-facing mutations go through Next.js API routes on Vercel. These are authenticated via Supabase Auth JWT and scoped by `workspace_id`.

```
src/
  app/
    api/
      notes/
        route.ts                         # NEW: POST (create note), GET (list notes for client)
      notes/[noteId]/
        route.ts                         # NEW: GET (single note), DELETE (delete note, blocked for merge_history)
      follow-ups/
        route.ts                         # NEW: POST (create follow-up), GET (list for client)
      follow-ups/[followUpId]/
        route.ts                         # NEW: PATCH (update status/content), DELETE
      knowledge/
        route.ts                         # NEW: GET (list chunks for workspace), POST (create settings_editor entry)
      knowledge/[chunkId]/
        route.ts                         # NEW: PATCH (edit chunk content), DELETE (single chunk)
      knowledge/upload/
        route.ts                         # NEW: POST (upload document to Storage, invoke embed-knowledge)
      knowledge/document/[sourceRef]/
        route.ts                         # NEW: DELETE (remove all chunks for a source_ref)
      clients/merge/
        route.ts                         # NEW: POST (execute client merge)
```

### 1.2 Edge Function: `embed-knowledge`

Existing Edge Function from architecture section 3.2. Handles document chunking + embedding generation + upsert.

```
supabase/functions/
  embed-knowledge/
    index.ts                             # Chunk text, generate embeddings, upsert to knowledge_chunks
  _shared/
    chunker.ts                           # NEW: text splitting with overlap
    embedder.ts                          # NEW: OpenAI text-embedding-3-small call
    text-extractor.ts                    # NEW: PDF text extraction, plain text passthrough
    types.ts                             # Modified: add KnowledgeProcessingRequest, ChunkResult types
```

### 1.3 Next.js UI Components

```
src/
  components/
    thread/
      note-input.tsx                     # NEW: inline note creation form (content textarea + save button)
      note-card.tsx                      # NEW: renders a note with source badge, timestamp, author
      followup-input.tsx                 # NEW: follow-up creation form (content, type dropdown, due_date picker)
      followup-card.tsx                  # NEW: renders follow-up with status badge, due date, action buttons
      followup-status-toggle.tsx         # NEW: status update dropdown (open/completed/pending)
    settings/
      knowledge-base-panel.tsx           # NEW: knowledge base list, grouped by source
      knowledge-entry-editor.tsx         # NEW: inline editor for chunk content
      document-upload.tsx                # NEW: file upload with progress indicator
    client/
      merge-dialog.tsx                   # NEW: merge confirmation dialog with record counts
      merge-client-search.tsx            # NEW: search for target client during merge
```

### 1.4 Modified Files

| File | Modification |
|------|-------------|
| `src/components/thread/client-thread.tsx` | Add notes section and follow-ups section with inline creation forms |
| `src/app/settings/page.tsx` | Add Knowledge Base tab with upload, list, and edit capabilities |
| `src/app/clients/[clientId]/page.tsx` | Add "Merge into another client" action in client profile |
| `supabase/functions/_shared/types.ts` | Add `KnowledgeProcessingRequest`, `ChunkResult`, `MergeResult` types |

---

## 2. Data Model

### 2.1 Existing: `notes` Table (Architecture Section 9.1)

The architecture already defines this table. One column addition is needed.

```sql
-- Already exists in architecture-final.md schema:
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL,              -- 'staff_manual', 'ai_extracted', 'conversation_update', 'merge_history'
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_client ON notes(client_id, created_at DESC);
CREATE INDEX idx_notes_workspace ON notes(workspace_id, created_at DESC);
```

**Schema delta -- add `merge_history` to source enum and add CHECK constraint:**

```sql
-- Migration: add source constraint and merge_history value
ALTER TABLE notes ADD CONSTRAINT notes_source_check
  CHECK (source IN ('staff_manual', 'ai_extracted', 'conversation_update', 'merge_history'));
```

### 2.2 Existing: `follow_ups` Table (Architecture Section 9.1)

Already defined. No schema changes needed.

```sql
-- Already exists in architecture-final.md schema:
CREATE TABLE follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL DEFAULT 'follow_up',     -- 'follow_up', 'promise', 'reminder'
  content TEXT NOT NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open',        -- 'open', 'completed', 'pending', 'overdue'
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_followups_client ON follow_ups(client_id);
CREATE INDEX idx_followups_workspace_status ON follow_ups(workspace_id, status)
  WHERE status IN ('open', 'pending', 'overdue');
```

**Schema delta -- add CHECK constraints:**

```sql
-- Migration: add enum constraints for follow_ups
ALTER TABLE follow_ups ADD CONSTRAINT followups_type_check
  CHECK (type IN ('follow_up', 'promise', 'reminder'));

ALTER TABLE follow_ups ADD CONSTRAINT followups_status_check
  CHECK (status IN ('open', 'completed', 'pending', 'overdue'));
```

### 2.3 Existing: `knowledge_chunks` Table (Architecture Section 9.1)

Already defined. One column addition is needed for edit tracking.

```sql
-- Already exists in architecture-final.md schema:
CREATE TABLE knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL,                   -- 'instagram_scrape', 'manual_upload', 'settings_editor'
  source_ref TEXT,                        -- URL or filename
  embedding vector(1536),                 -- OpenAI text-embedding-3-small
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_workspace ON knowledge_chunks(workspace_id);
CREATE INDEX idx_knowledge_embedding ON knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

**Schema delta -- add `updated_at` column for edit tracking (referenced in US-F09-08):**

```sql
-- Migration: add updated_at to knowledge_chunks for edit tracking
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Add source constraint
ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_source_check
  CHECK (source IN ('instagram_scrape', 'manual_upload', 'settings_editor'));

-- Index for listing chunks by source_ref (document grouping in Settings UI)
CREATE INDEX idx_knowledge_source_ref ON knowledge_chunks(workspace_id, source_ref)
  WHERE source_ref IS NOT NULL;
```

### 2.4 Full Migration

```sql
-- Migration: 00X_notes_followups_knowledge.sql
-- Purpose: F-09 Notes, Follow-ups & Knowledge Management support

-- 1. Notes source constraint (add merge_history to enum)
ALTER TABLE notes ADD CONSTRAINT notes_source_check
  CHECK (source IN ('staff_manual', 'ai_extracted', 'conversation_update', 'merge_history'));

-- 2. Follow-ups type and status constraints
ALTER TABLE follow_ups ADD CONSTRAINT followups_type_check
  CHECK (type IN ('follow_up', 'promise', 'reminder'));

ALTER TABLE follow_ups ADD CONSTRAINT followups_status_check
  CHECK (status IN ('open', 'completed', 'pending', 'overdue'));

-- 3. Knowledge chunks: add updated_at for edit tracking
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 4. Knowledge chunks: source constraint
ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_source_check
  CHECK (source IN ('instagram_scrape', 'manual_upload', 'settings_editor'));

-- 5. Index for document grouping by source_ref
CREATE INDEX IF NOT EXISTS idx_knowledge_source_ref ON knowledge_chunks(workspace_id, source_ref)
  WHERE source_ref IS NOT NULL;

-- 6. Index for overdue follow-up detection (daily cron query)
CREATE INDEX IF NOT EXISTS idx_followups_overdue_check ON follow_ups(workspace_id, due_date, status)
  WHERE status = 'open' AND due_date IS NOT NULL;

-- 7. Supabase Storage bucket for documents (done via Supabase dashboard or API)
-- Bucket: 'documents'
-- Public: false (signed URLs required)
-- File size limit: 10MB
-- Allowed MIME types: application/pdf, text/plain, text/markdown
```

### 2.5 Supabase Storage Structure

```
documents/                              # Bucket name
  workspaces/
    {workspace_id}/
      uploads/
        {filename}                      # e.g., services-menu-2026.pdf
```

Storage bucket RLS policy:

```sql
-- Staff can read documents in their workspace
CREATE POLICY "workspace_documents_read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[2] = auth.workspace_id()::text
  );

-- No INSERT policy for authenticated users -- only service role uploads via API route.
```

---

## 3. API Endpoints

All endpoints are Next.js API routes. Authentication via Supabase Auth JWT. Workspace scoping via `auth.workspace_id()` RLS or application-level `WHERE workspace_id = $1` using the service role client.

### 3.1 Notes

#### `POST /api/notes` -- Create Note (US-F09-01)

```typescript
// Request body
type CreateNoteRequest = {
  clientId: string;
  content: string;        // required, non-empty after trim
};

// Validation (Zod)
const createNoteSchema = z.object({
  clientId: z.string().uuid(),
  content: z.string().trim().min(1, "Note content cannot be empty"),
});

// Handler
async function POST(req: Request) {
  const supabase = createServerClient(cookies());
  const { data: { user } } = await supabase.auth.getUser();
  const body = createNoteSchema.parse(await req.json());

  // Verify client belongs to staff's workspace (RLS handles this)
  const { data: note, error } = await supabase
    .from("notes")
    .insert({
      workspace_id: user.workspace_id,    // from JWT
      client_id: body.clientId,
      content: body.content,
      source: "staff_manual",
      created_by: user.id,
    })
    .select()
    .single();

  if (error) throw error;

  // Audit event (service role client)
  await logAuditEvent(serviceClient, {
    workspaceId: user.workspace_id,
    actorType: "staff",
    actorId: user.id,
    actionType: "note_created",
    targetType: "note",
    targetId: note.id,
    metadata: { client_id: body.clientId },
  });

  return Response.json(note, { status: 201 });
}
```

**Latency target:** < 1 second. This is a single INSERT -- no LLM, no queue, no async dependency.

#### `GET /api/notes?clientId={id}` -- List Notes

```typescript
// Query params
type ListNotesQuery = {
  clientId: string;       // required
  limit?: number;         // default 50, max 100
  offset?: number;        // default 0
};

// Returns notes ordered by created_at DESC, with staff full_name joined
```

#### `DELETE /api/notes/{noteId}` -- Delete Note

```typescript
// Blocks deletion if source = 'merge_history' (immutable audit record)
async function DELETE(req: Request, { params }: { params: { noteId: string } }) {
  const { data: note } = await supabase
    .from("notes")
    .select("id, source")
    .eq("id", params.noteId)
    .single();

  if (note?.source === "merge_history") {
    return Response.json(
      { error: "Merge history notes cannot be deleted" },
      { status: 403 }
    );
  }

  // Proceed with DELETE
}
```

### 3.2 Follow-ups

#### `POST /api/follow-ups` -- Create Follow-up (US-F09-02, US-F09-04)

```typescript
type CreateFollowUpRequest = {
  clientId: string;
  content: string;            // required, non-empty
  type: "follow_up" | "promise" | "reminder";  // default: "follow_up"
  dueDate?: string | null;    // ISO date string (YYYY-MM-DD), nullable
};

const createFollowUpSchema = z.object({
  clientId: z.string().uuid(),
  content: z.string().trim().min(1, "Follow-up content cannot be empty"),
  type: z.enum(["follow_up", "promise", "reminder"]).default("follow_up"),
  dueDate: z.string().date().nullable().optional(),
});

// Handler inserts with status = 'open', logs audit event
```

#### `GET /api/follow-ups?clientId={id}&status={status}` -- List Follow-ups

```typescript
type ListFollowUpsQuery = {
  clientId?: string;          // filter by client (optional -- workspace-wide listing for Today's View)
  status?: string;            // 'open', 'pending', 'overdue', 'completed', or 'active' (= open+pending+overdue)
  limit?: number;             // default 50
  offset?: number;
};

// 'active' is a virtual status that maps to: status IN ('open', 'pending', 'overdue')
```

#### `PATCH /api/follow-ups/{followUpId}` -- Update Follow-up Status (US-F09-03)

```typescript
type UpdateFollowUpRequest = {
  status?: "open" | "completed" | "pending" | "overdue";
  content?: string;           // allow content edits
  dueDate?: string | null;    // allow due date updates
};

const updateFollowUpSchema = z.object({
  status: z.enum(["open", "completed", "pending", "overdue"]).optional(),
  content: z.string().trim().min(1).optional(),
  dueDate: z.string().date().nullable().optional(),
}).refine(data => Object.keys(data).length > 0, "At least one field required");

// Handler:
// 1. Verify follow-up exists and belongs to workspace (RLS)
// 2. Update fields
// 3. Log audit event with before/after status values
```

**Status transitions:** No strict state machine. Any status can move to any other status per US-F09-03 notes. The database CHECK constraint enforces valid values.

### 3.3 Knowledge Base

#### `GET /api/knowledge` -- List Knowledge Chunks (US-F09-08)

```typescript
type ListKnowledgeQuery = {
  source?: "instagram_scrape" | "manual_upload" | "settings_editor";  // filter by source
  sourceRef?: string;   // filter by filename/URL
  limit?: number;       // default 100
  offset?: number;
};

// Returns chunks grouped by source_ref for manual_upload entries.
// For settings_editor entries, each chunk is standalone.
```

#### `POST /api/knowledge` -- Create Settings Editor Entry (US-F09-08)

```typescript
type CreateKnowledgeEntryRequest = {
  content: string;      // required, non-empty
};

// Handler:
// 1. Insert knowledge_chunk with source = 'settings_editor', source_ref = null
// 2. Invoke embed-knowledge Edge Function to generate embedding for this single chunk
// 3. Return created chunk (embedding populated async -- brief window where search may miss it)
```

#### `PATCH /api/knowledge/{chunkId}` -- Edit Knowledge Entry (US-F09-08)

```typescript
type UpdateKnowledgeEntryRequest = {
  content: string;      // new content
};

// Handler:
// 1. Update content and updated_at
// 2. Invoke embed-knowledge Edge Function to regenerate embedding
// Content update is immediate. Embedding regeneration is async.
```

#### `DELETE /api/knowledge/{chunkId}` -- Delete Single Entry

```typescript
// Hard delete. No soft delete for knowledge chunks.
```

#### `DELETE /api/knowledge/document/{sourceRef}` -- Delete All Chunks for a Document (US-F09-08)

```typescript
// Deletes all chunks where source_ref = {sourceRef} AND workspace_id matches.
// Also deletes the file from Supabase Storage if source = 'manual_upload'.
```

#### `POST /api/knowledge/upload` -- Upload Document (US-F09-05)

```typescript
// Accepts multipart/form-data with a single file.
// See Section 4 for full document processing flow.
```

### 3.4 Client Merge

#### `POST /api/clients/merge` -- Execute Merge (US-F09-06, US-F09-07)

```typescript
type MergeRequest = {
  sourceClientId: string;    // client to be soft-deleted
  targetClientId: string;    // client that absorbs all records
};

// See Section 6 for full merge flow.
```

---

## 4. Document Processing Pipeline (US-F09-05)

Document upload triggers a two-phase flow: synchronous file upload via Next.js API route, then async chunking + embedding via the `embed-knowledge` Edge Function.

### 4.1 Upload Flow

```
Staff uploads file in Settings > Knowledge Base
    |
    v
POST /api/knowledge/upload (Next.js API route)
    |
    v
1. Validate file:
   - Type: PDF (.pdf), plain text (.txt), Markdown (.md)
   - Size: <= 10 MB
   - MIME type whitelist: application/pdf, text/plain, text/markdown
    |
    v
2. Upload to Supabase Storage:
   Path: documents/workspaces/{workspace_id}/uploads/{filename}
   (Overwrites existing file with same filename)
    |
    v
3. Delete existing chunks for this workspace + source_ref (idempotent re-upload):
   DELETE FROM knowledge_chunks
   WHERE workspace_id = $1 AND source_ref = $2 AND source = 'manual_upload'
    |
    v
4. Invoke embed-knowledge Edge Function via pg_net or direct HTTP:
   POST /functions/v1/embed-knowledge
   Body: { workspaceId, sourceRef: filename, storagePath, source: 'manual_upload' }
    |
    v
5. Return 202 Accepted to client with processing_id for status polling
```

### 4.2 `embed-knowledge` Edge Function

```typescript
// supabase/functions/embed-knowledge/index.ts

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";

type KnowledgeProcessingRequest = {
  workspaceId: string;
  sourceRef: string;         // filename or URL
  storagePath: string;       // Supabase Storage path
  source: "manual_upload" | "settings_editor";
  content?: string;          // For settings_editor: raw content (no file download needed)
  chunkId?: string;          // For settings_editor edit: update a single chunk's embedding
};

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const body: KnowledgeProcessingRequest = await req.json();

  // Branch: single-chunk embedding (settings editor create/edit)
  if (body.source === "settings_editor" && body.content) {
    const embedding = await generateEmbedding(body.content);
    if (body.chunkId) {
      // Edit: update existing chunk's embedding
      await supabase
        .from("knowledge_chunks")
        .update({ embedding, updated_at: new Date().toISOString() })
        .eq("id", body.chunkId);
    } else {
      // Create: chunk was already inserted by API route; update embedding
      // (API route inserts chunk without embedding, then calls this function)
    }
    await logLLMUsage(supabase, body.workspaceId, "embed-knowledge", embeddingTokens);
    return new Response(JSON.stringify({ status: "completed", chunks: 1 }));
  }

  // Branch: document processing (manual_upload)
  // 1. Download file from Storage
  const { data: fileData } = await supabase.storage
    .from("documents")
    .download(body.storagePath);

  // 2. Extract text
  const rawText = await extractText(fileData, body.sourceRef);

  // 3. Chunk text
  const chunks = chunkText(rawText, {
    targetTokens: 500,
    overlapTokens: 50,
  });

  // 4. Generate embeddings (batch)
  const embeddings = await generateEmbeddings(chunks.map(c => c.content));

  // 5. Upsert chunks
  const chunkRecords = chunks.map((chunk, i) => ({
    workspace_id: body.workspaceId,
    content: chunk.content,
    source: "manual_upload",
    source_ref: body.sourceRef,
    embedding: embeddings[i],
  }));

  // Atomic: delete old + insert new in a transaction
  await supabase.rpc("upsert_knowledge_chunks", {
    p_workspace_id: body.workspaceId,
    p_source_ref: body.sourceRef,
    p_chunks: chunkRecords,
  });

  // 6. Log LLM usage
  await logLLMUsage(supabase, body.workspaceId, "embed-knowledge", totalEmbeddingTokens);

  return new Response(JSON.stringify({
    status: "completed",
    chunks: chunks.length,
    sourceRef: body.sourceRef,
  }));
});
```

### 4.3 Text Extraction (`text-extractor.ts`)

```typescript
async function extractText(fileBlob: Blob, filename: string): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "pdf":
      // Use pdf-parse (Deno-compatible) or pdf.js for text extraction
      // NOTE: text-based PDFs only. Image-based PDFs (scanned) return empty/garbage.
      // Image-based PDF OCR is out of scope for MVP.
      return extractPdfText(fileBlob);

    case "txt":
    case "md":
      return await fileBlob.text();

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}
```

### 4.4 Chunking Strategy (`chunker.ts`)

```typescript
type ChunkOptions = {
  targetTokens: number;     // 500
  overlapTokens: number;    // 50
};

type ChunkResult = {
  content: string;
  index: number;
  startChar: number;
  endChar: number;
};

function chunkText(text: string, options: ChunkOptions): ChunkResult[] {
  // Strategy:
  // 1. Split on paragraph boundaries (double newline)
  // 2. Accumulate paragraphs until target token count is reached
  // 3. When target exceeded, emit chunk and start new chunk with overlap
  //    (include last ~50 tokens of previous chunk as prefix)
  // 4. If a single paragraph exceeds target, split on sentence boundaries
  // 5. If a single sentence exceeds target, hard-split at token boundary

  // Token counting: approximate using char count / 4 (conservative for English text)
  // Exact token counting (tiktoken) is expensive; approximation is acceptable
  // because chunk size variance is tolerable for semantic search.

  const paragraphs = text.split(/\n\n+/);
  const chunks: ChunkResult[] = [];
  let currentChunk = "";
  let chunkStart = 0;
  let charOffset = 0;

  for (const para of paragraphs) {
    const estimatedTokens = (currentChunk.length + para.length) / 4;

    if (estimatedTokens > options.targetTokens && currentChunk.length > 0) {
      // Emit current chunk
      chunks.push({
        content: currentChunk.trim(),
        index: chunks.length,
        startChar: chunkStart,
        endChar: charOffset,
      });

      // Start new chunk with overlap from end of previous
      const overlapChars = options.overlapTokens * 4;
      const overlapText = currentChunk.slice(-overlapChars);
      currentChunk = overlapText + "\n\n" + para;
      chunkStart = charOffset - overlapChars;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    }

    charOffset += para.length + 2; // +2 for \n\n
  }

  // Emit final chunk
  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      index: chunks.length,
      startChar: chunkStart,
      endChar: charOffset,
    });
  }

  return chunks;
}
```

### 4.5 Embedding Generation (`embedder.ts`)

```typescript
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const MAX_BATCH_SIZE = 100; // OpenAI batch limit

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  // Batch into groups of MAX_BATCH_SIZE
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    results.push(...response.data.map(d => d.embedding));
  }
  return results;
}
```

### 4.6 Atomic Chunk Upsert (Database Function)

Duplicate upload of the same filename must replace previous chunks atomically. This database function ensures the old chunks are deleted and new chunks inserted in a single transaction.

```sql
-- Database function for atomic knowledge chunk replacement
CREATE OR REPLACE FUNCTION upsert_knowledge_chunks(
  p_workspace_id UUID,
  p_source_ref TEXT,
  p_chunks JSONB  -- array of { content, source, source_ref, embedding }
)
RETURNS INTEGER AS $$
DECLARE
  chunk_count INTEGER;
BEGIN
  -- Delete existing chunks for this workspace + source_ref
  DELETE FROM knowledge_chunks
  WHERE workspace_id = p_workspace_id
    AND source_ref = p_source_ref
    AND source = 'manual_upload';

  -- Insert new chunks
  INSERT INTO knowledge_chunks (workspace_id, content, source, source_ref, embedding)
  SELECT
    p_workspace_id,
    (elem->>'content')::TEXT,
    (elem->>'source')::TEXT,
    (elem->>'source_ref')::TEXT,
    (elem->>'embedding')::vector(1536)
  FROM jsonb_array_elements(p_chunks) AS elem;

  GET DIAGNOSTICS chunk_count = ROW_COUNT;
  RETURN chunk_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.7 Duplicate Upload Handling (US-F09-05 AC)

When staff uploads a file with the same filename:

1. The API route uploads the new file to Storage (overwrites existing).
2. The API route deletes existing chunks via `DELETE FROM knowledge_chunks WHERE workspace_id = $1 AND source_ref = $2`.
3. The `embed-knowledge` Edge Function processes the new file and inserts fresh chunks.
4. If the Edge Function fails, the old chunks are already deleted. The knowledge base has a gap until retry succeeds. This is acceptable because the staff is re-uploading intentionally.

To make this more robust, the atomic `upsert_knowledge_chunks` RPC in section 4.6 handles the delete + insert in a single transaction inside the Edge Function. The API route's pre-delete in step 2 is a safety net for cases where the Edge Function never fires.

### 4.8 Upload Failure Rollback (US-F09-05 AC)

If `embed-knowledge` fails mid-processing:

1. The `upsert_knowledge_chunks` transaction rolls back -- no partial chunks are committed.
2. Existing chunks (from a previous upload of a different filename) remain intact.
3. The file in Storage remains (can be reprocessed on retry).
4. Staff sees an error message with a retry option in the UI.

---

## 5. Follow-up Overdue Detection (US-F09-03)

### 5.1 Daily Cron Check

The `daily-cron` Edge Function (architecture section 11.2) runs a follow-up surfacing query as part of its daily operations:

```sql
-- Transition open follow-ups past their due date to overdue
UPDATE follow_ups
SET status = 'overdue'
WHERE status = 'open'
  AND due_date IS NOT NULL
  AND due_date < CURRENT_DATE
  AND workspace_id = $1
RETURNING id, client_id, content, due_date;
```

This runs per workspace during the daily cron job. The returned rows are used by COS (F-12, Phase 3) to queue follow-up drafts.

### 5.2 Query-Time Evaluation (Phase 2 Alternative)

For Phase 2, before the daily cron is fully operational, the API route can evaluate overdue status at query time:

```typescript
// In GET /api/follow-ups handler, post-query enrichment:
const enrichedFollowUps = followUps.map(fu => ({
  ...fu,
  status: fu.status === "open" && fu.due_date && new Date(fu.due_date) < new Date()
    ? "overdue"
    : fu.status,
}));
```

This ensures the UI always shows accurate status without depending on the cron job.

---

## 6. Client Merge -- Atomic Transaction (US-F09-06, US-F09-07)

### 6.1 Merge Flow

```
POST /api/clients/merge
Body: { sourceClientId, targetClientId }
    |
    v
1. Validate:
   - sourceClientId !== targetClientId
   - Both clients exist in the same workspace
   - Source client is not already soft-deleted (deleted_at IS NULL)
   - Target client is not already soft-deleted
    |
    v
2. Count records to transfer (for merge history note):
   SELECT count(*) FROM notes WHERE client_id = sourceClientId
   SELECT count(*) FROM follow_ups WHERE client_id = sourceClientId
   SELECT count(*) FROM bookings WHERE client_id = sourceClientId
   SELECT count(*) FROM messages WHERE conversation_id IN (
     SELECT id FROM conversations WHERE client_id = sourceClientId
   )
    |
    v
3. Load source client profile snapshot (for merge history note):
   SELECT full_name, phone, email, lifecycle_status, preferences
   FROM clients WHERE id = sourceClientId
    |
    v
4. Execute merge in a single database transaction (RPC):
   - UPDATE notes SET client_id = targetClientId WHERE client_id = sourceClientId
   - UPDATE follow_ups SET client_id = targetClientId WHERE client_id = sourceClientId
   - UPDATE bookings SET client_id = targetClientId WHERE client_id = sourceClientId
   - UPDATE conversations SET client_id = targetClientId WHERE client_id = sourceClientId
   - UPDATE messages SET workspace_id = (kept same) WHERE conversation_id IN (transferred conversations)
   - INSERT merge history note on target client (source = 'merge_history')
   - UPDATE clients SET deleted_at = now() WHERE id = sourceClientId
    |
    v
5. Log audit event with:
   actor, action = 'client_merged', source_client_id, target_client_id,
   metadata: { notes_transferred, followups_transferred, bookings_transferred, messages_transferred }
    |
    v
6. Return merge result with transferred record counts
```

### 6.2 Database Function for Atomic Merge

The entire merge must run as a single Postgres transaction. A database function ensures atomicity:

```sql
CREATE OR REPLACE FUNCTION merge_clients(
  p_workspace_id UUID,
  p_source_client_id UUID,
  p_target_client_id UUID,
  p_staff_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_source_client RECORD;
  v_notes_count INTEGER;
  v_followups_count INTEGER;
  v_bookings_count INTEGER;
  v_messages_count INTEGER;
  v_conversations_count INTEGER;
  v_merge_note_content TEXT;
  v_merge_note_id UUID;
BEGIN
  -- Lock both client rows to prevent concurrent modifications
  SELECT * INTO v_source_client
  FROM clients
  WHERE id = p_source_client_id
    AND workspace_id = p_workspace_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF v_source_client IS NULL THEN
    RAISE EXCEPTION 'Source client not found or already deleted';
  END IF;

  -- Lock target
  PERFORM 1 FROM clients
  WHERE id = p_target_client_id
    AND workspace_id = p_workspace_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target client not found or already deleted';
  END IF;

  -- Prevent self-merge
  IF p_source_client_id = p_target_client_id THEN
    RAISE EXCEPTION 'Cannot merge a client into itself';
  END IF;

  -- Transfer notes
  UPDATE notes SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id;
  GET DIAGNOSTICS v_notes_count = ROW_COUNT;

  -- Transfer follow-ups
  UPDATE follow_ups SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id;
  GET DIAGNOSTICS v_followups_count = ROW_COUNT;

  -- Transfer bookings
  UPDATE bookings SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id;
  GET DIAGNOSTICS v_bookings_count = ROW_COUNT;

  -- Transfer conversations and count messages
  SELECT count(*) INTO v_messages_count
  FROM messages m
  JOIN conversations c ON m.conversation_id = c.id
  WHERE c.client_id = p_source_client_id;

  UPDATE conversations SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id;
  GET DIAGNOSTICS v_conversations_count = ROW_COUNT;

  -- Build merge history note content
  v_merge_note_content := format(
    E'--- MERGE HISTORY ---\n'
    'Merged from: %s (%s)\n'
    'Phone: %s\n'
    'Email: %s\n'
    'Lifecycle status: %s\n'
    'Preferences: %s\n'
    'Records transferred: %s notes, %s follow-ups, %s bookings, %s messages\n'
    'Merged at: %s\n'
    '---',
    v_source_client.full_name,
    p_source_client_id,
    v_source_client.phone,
    COALESCE(v_source_client.email, 'N/A'),
    v_source_client.lifecycle_status,
    COALESCE(v_source_client.preferences::text, '{}'),
    v_notes_count, v_followups_count, v_bookings_count, v_messages_count,
    now()
  );

  -- Insert merge history note on target client
  INSERT INTO notes (workspace_id, client_id, content, source, created_by)
  VALUES (p_workspace_id, p_target_client_id, v_merge_note_content, 'merge_history', p_staff_id)
  RETURNING id INTO v_merge_note_id;

  -- Soft-delete source client
  UPDATE clients SET deleted_at = now()
  WHERE id = p_source_client_id;

  -- Return result
  RETURN jsonb_build_object(
    'merge_note_id', v_merge_note_id,
    'notes_transferred', v_notes_count,
    'followups_transferred', v_followups_count,
    'bookings_transferred', v_bookings_count,
    'messages_transferred', v_messages_count,
    'conversations_transferred', v_conversations_count,
    'source_client_name', v_source_client.full_name,
    'source_client_phone', v_source_client.phone
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 6.3 API Route Handler

```typescript
// src/app/api/clients/merge/route.ts

const mergeSchema = z.object({
  sourceClientId: z.string().uuid(),
  targetClientId: z.string().uuid(),
}).refine(
  data => data.sourceClientId !== data.targetClientId,
  { message: "Cannot merge a client into itself" }
);

async function POST(req: Request) {
  const supabase = createServerClient(cookies());
  const serviceClient = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  const body = mergeSchema.parse(await req.json());

  // Execute atomic merge via database function
  const { data: result, error } = await serviceClient.rpc("merge_clients", {
    p_workspace_id: user.workspace_id,
    p_source_client_id: body.sourceClientId,
    p_target_client_id: body.targetClientId,
    p_staff_id: user.id,
  });

  if (error) {
    // Map Postgres exceptions to HTTP errors
    if (error.message.includes("not found")) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error.message.includes("Cannot merge")) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Audit event
  await logAuditEvent(serviceClient, {
    workspaceId: user.workspace_id,
    actorType: "staff",
    actorId: user.id,
    actionType: "client_merged",
    targetType: "client",
    targetId: body.targetClientId,
    metadata: {
      source_client_id: body.sourceClientId,
      ...result,
    },
  });

  return Response.json(result, { status: 200 });
}
```

### 6.4 Merge History Note Immutability (US-F09-07)

Merge history notes are protected from modification at two levels:

1. **API level:** `DELETE /api/notes/{noteId}` checks `source === 'merge_history'` and returns 403.
2. **UI level:** Merge history notes do not render edit/delete buttons.

There is no UPDATE endpoint for notes (notes are append-only records), so edit protection is inherent.

---

## 7. Lead Nurturing Follow-ups (US-F09-04)

Lead nurturing uses the standard follow-up data model with no additional tables or columns. The value comes from how follow-ups integrate with context assembly and the COS engine.

### 7.1 Interest Capture Pattern

When staff detects a buying signal, they create a follow-up that captures the interest context:

```
Content: "Asked about wedding dress alterations -- interested in silk option"
Type: follow_up
Due date: 2026-03-22 (when to follow up)
```

The content field is free-text. Staff should include what the client was interested in, what stage they are at, and any competitive context. This content appears in `activeFollowUps` during context assembly (F-05), giving the AI access to accumulated interest signals.

### 7.2 Context Assembly Integration

Open follow-ups (status IN `open`, `pending`, `overdue`) appear in the `openFollowUps` section of `ReadOnlyContext` (architecture section 6.2):

```typescript
openFollowUps: Array<{
  content: string;      // "Asked about wedding dress alterations..."
  dueDate: string | null;
  status: string;       // "open", "pending", "overdue"
}>;
```

The Client Worker can reference this context when generating draft replies to the same client, enabling personalized follow-up. For example, if the client messages again and the AI sees an open follow-up about silk wedding dress alterations, the draft can acknowledge and build on that conversation.

### 7.3 Overdue-to-Follow-Up Pipeline

```
Day 0: Staff creates follow-up with due_date = 2026-03-22
    |
Day 4 (due_date passes without completion):
    |
    v
daily-cron sets status = 'overdue'
    |
    v
(Phase 3: COS queues a Client Worker invocation to generate a follow-up draft)
(Phase 2: overdue follow-up appears in Today's View for staff to act on manually)
```

This prevents warm leads from going cold. In Phase 2, the infrastructure is in place. In Phase 3, the COS engine (F-12) automates the outreach.

---

## 8. Edge Cases

### 8.1 Concurrent Note/Follow-up Writes

Multiple staff members can write notes or follow-ups for the same client simultaneously. No conflict resolution is needed -- notes and follow-ups are append-only (no two people edit the same record). Supabase Realtime pushes new records to all connected staff in the workspace.

### 8.2 Document Processing Timeout

The `embed-knowledge` Edge Function has a 150s timeout (Supabase Pro tier). If processing a large document (many chunks, many embedding API calls) risks timeout:

- **Mitigation:** Batch embedding calls (up to 100 texts per OpenAI API call). A 10MB PDF producing ~40 chunks requires 1 embedding batch call (~2-5 seconds).
- **Failure:** If the function times out, the API route's original response was already 202 Accepted. The UI shows processing as incomplete. Staff can retry upload.
- **No pgmq retry:** Unlike `process-message`, `embed-knowledge` is not queue-driven. Retry is manual (re-upload).

### 8.3 Empty PDF / Unparseable File

If text extraction yields empty or near-empty content:

```typescript
const rawText = await extractText(fileData, filename);

if (rawText.trim().length < 10) {
  return new Response(JSON.stringify({
    status: "failed",
    error: "No readable text found in document. Image-based PDFs are not supported.",
  }), { status: 422 });
}
```

### 8.4 Merging a Client with Active Conversations

If the source client has an active conversation (state != `idle`), the conversation transfers to the target client. If the target client also has an active conversation, both conversations exist under the target client. The `conversations` table UNIQUE constraint on `client_id` must be relaxed or handled:

```sql
-- The architecture defines: UNIQUE(client_id) on conversations
-- During merge, if both clients have conversations, we must handle this.

-- Approach: merge conversations by updating source conversation's client_id.
-- If target already has a conversation, transfer messages from source conversation
-- to target conversation and delete the source conversation record.
```

**Merge conversation handling in the database function:**

```sql
-- Inside merge_clients function, replace the simple conversation transfer:

-- Check if target already has a conversation
SELECT id INTO v_target_conversation_id
FROM conversations
WHERE client_id = p_target_client_id
LIMIT 1;

IF v_target_conversation_id IS NOT NULL THEN
  -- Transfer messages from source conversation(s) to target conversation
  UPDATE messages SET conversation_id = v_target_conversation_id
  WHERE conversation_id IN (
    SELECT id FROM conversations WHERE client_id = p_source_client_id
  );

  -- Transfer drafts from source conversation(s) to target conversation
  UPDATE drafts SET conversation_id = v_target_conversation_id
  WHERE conversation_id IN (
    SELECT id FROM conversations WHERE client_id = p_source_client_id
  );

  -- Delete source conversation records (messages already transferred)
  DELETE FROM conversations WHERE client_id = p_source_client_id;
ELSE
  -- Simple transfer: point source conversation to target client
  UPDATE conversations SET client_id = p_target_client_id
  WHERE client_id = p_source_client_id;
END IF;
```

### 8.5 Knowledge Base Embedding Regeneration Window

When a knowledge entry is edited (US-F09-08), the content is updated immediately but the embedding is regenerated asynchronously via `embed-knowledge`. During this window (typically < 5 seconds):

- The old embedding still exists in the row.
- Semantic search may return the entry for queries matching the old content's meaning.
- This is acceptable because the window is brief and the content text (which is used for display) is already updated.

### 8.6 Merge of Client with Many Records

For clients with thousands of records, the merge transaction could be long-running. Mitigation:

- The `FOR UPDATE` locks on both client rows prevent concurrent modifications.
- The advisory lock pattern from the message pipeline does not apply here (merge is staff-initiated, not queue-driven).
- At MVP scale (~500 clients, ~100 messages/day per workspace), a single client is unlikely to have more than a few thousand records. The transaction should complete in < 5 seconds.

### 8.7 Unsupported File Types

The upload endpoint rejects files that do not match the accepted MIME types:

```typescript
const ACCEPTED_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

const ACCEPTED_EXTENSIONS = new Set(["pdf", "txt", "md"]);

if (!ACCEPTED_TYPES.has(file.type) && !ACCEPTED_EXTENSIONS.has(extension)) {
  return Response.json(
    { error: "Unsupported file type. Accepted: PDF, TXT, MD" },
    { status: 400 }
  );
}
```

### 8.8 Follow-up Without Due Date (Indefinite)

Follow-ups with `due_date = NULL` never transition to `overdue`. They remain `open` indefinitely and appear in `activeFollowUps` in context assembly until staff manually completes them. This is by design for open-ended lead nurturing (US-F09-04 AC: "remains in the active follow-ups indefinitely").

---

## 9. AC-to-Task Mapping

### Task 1: Database Migration (Foundation)

**Files:** Migration SQL file

| # | Task | AC Reference |
|---|------|-------------|
| 1.1 | Add `notes_source_check` constraint with `merge_history` value | US-F09-07: merge history note has source = 'merge_history' |
| 1.2 | Add `followups_type_check` constraint (follow_up, promise, reminder) | US-F09-02: follow-up type can be set to promise or reminder |
| 1.3 | Add `followups_status_check` constraint (open, completed, pending, overdue) | US-F09-03: valid status values enforced at database constraint level |
| 1.4 | Add `updated_at` column to `knowledge_chunks` | US-F09-08: updated_at set to current timestamp on edit |
| 1.5 | Add `knowledge_source_check` constraint | US-F09-05: source enum distinguishes origin |
| 1.6 | Add `idx_knowledge_source_ref` index | US-F09-08: entries grouped by source_ref |
| 1.7 | Add `idx_followups_overdue_check` index | US-F09-03: daily follow-up check performance |
| 1.8 | Create `upsert_knowledge_chunks` database function | US-F09-05: duplicate upload replaces previous chunks |
| 1.9 | Create `merge_clients` database function | US-F09-06: merge is atomic -- all or nothing |
| 1.10 | Create Supabase Storage bucket `documents` (10MB limit, private) | US-F09-05: staff uploads a PDF document |

### Task 2: Notes API (US-F09-01)

**Files:** `src/app/api/notes/route.ts`, `src/app/api/notes/[noteId]/route.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 2.1 | Implement `POST /api/notes` with Zod validation (non-empty content) | US-F09-01: note created with < 1s latency; US-F09-01: empty note rejected |
| 2.2 | Set `source = 'staff_manual'` and `created_by = user.id` on insert | US-F09-01: source = 'staff_manual', created_by set |
| 2.3 | Return created note immediately (no LLM call on save path) | US-F09-01: no LLM call during save path |
| 2.4 | Log audit event with action = `note_created` | US-F09-01: audit event logged |
| 2.5 | Implement `GET /api/notes?clientId=` with pagination | US-F09-01: note appears in client thread |
| 2.6 | Implement `DELETE /api/notes/{noteId}` with merge_history protection | US-F09-07: merge history notes cannot be modified |
| 2.7 | Verify workspace scoping via RLS | US-F09-01: note not visible for other clients/workspaces |

### Task 3: Follow-ups API (US-F09-02, US-F09-03, US-F09-04)

**Files:** `src/app/api/follow-ups/route.ts`, `src/app/api/follow-ups/[followUpId]/route.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 3.1 | Implement `POST /api/follow-ups` with type, content, optional due_date | US-F09-02: follow-up created with status 'open' |
| 3.2 | Validate content is non-empty | US-F09-02: empty content rejected |
| 3.3 | Support type enum: follow_up, promise, reminder | US-F09-02: type can be set to promise or reminder |
| 3.4 | Log audit event with action = `followup_created` | US-F09-02: audit event logged |
| 3.5 | Implement `PATCH /api/follow-ups/{followUpId}` for status updates | US-F09-03: staff changes status |
| 3.6 | Log audit event with before/after status on status change | US-F09-03: audit event with before/after |
| 3.7 | Return 404 for non-existent follow-up | US-F09-03: not-found error on non-existent followup_id |
| 3.8 | Implement `GET /api/follow-ups?clientId=&status=` with 'active' virtual filter | US-F09-03: active follow-ups list; US-F09-04: both follow-ups visible |
| 3.9 | Add query-time overdue evaluation for follow-ups past due_date | US-F09-03: overdue detection before daily cron is operational |
| 3.10 | Implement `DELETE /api/follow-ups/{followUpId}` | General CRUD |

### Task 4: Follow-up Overdue Cron (US-F09-03)

**Files:** `supabase/functions/daily-cron/index.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 4.1 | Add follow-up surfacing step to `daily-cron`: UPDATE status to 'overdue' where due_date < today | US-F09-03: overdue status set automatically by system |
| 4.2 | Log count of newly overdue follow-ups per workspace | US-F09-03: follow-up surfaced in overdue items list |

### Task 5: Knowledge Base API (US-F09-08)

**Files:** `src/app/api/knowledge/route.ts`, `src/app/api/knowledge/[chunkId]/route.ts`, `src/app/api/knowledge/document/[sourceRef]/route.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 5.1 | Implement `GET /api/knowledge` with source and sourceRef filters | US-F09-08: entries displayed, grouped/filterable by source |
| 5.2 | Implement `POST /api/knowledge` for settings_editor entries (insert chunk, invoke embed-knowledge for embedding) | US-F09-08: staff adds new knowledge entry, embedding generated |
| 5.3 | Implement `PATCH /api/knowledge/{chunkId}` -- update content + updated_at, invoke embed-knowledge for re-embedding | US-F09-08: content updated, embedding regenerated |
| 5.4 | Implement `DELETE /api/knowledge/{chunkId}` -- hard delete | US-F09-08: entry deleted, no longer in search results |
| 5.5 | Implement `DELETE /api/knowledge/document/{sourceRef}` -- delete all chunks for a source_ref + Storage file | US-F09-08: all chunks with source_ref deleted |

### Task 6: Document Upload and Processing (US-F09-05)

**Files:** `src/app/api/knowledge/upload/route.ts`, `supabase/functions/embed-knowledge/index.ts`, `supabase/functions/_shared/chunker.ts`, `supabase/functions/_shared/embedder.ts`, `supabase/functions/_shared/text-extractor.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 6.1 | Implement `POST /api/knowledge/upload` -- validate file type (PDF, TXT, MD) and size (< 10MB) | US-F09-05: unsupported types rejected; large files rejected |
| 6.2 | Upload file to Supabase Storage at `documents/workspaces/{ws}/uploads/{filename}` | US-F09-05: staff uploads a document |
| 6.3 | Delete existing chunks for same workspace + source_ref before processing | US-F09-05: duplicate upload replaces previous chunks |
| 6.4 | Invoke `embed-knowledge` Edge Function via HTTP POST | US-F09-05: document processed |
| 6.5 | Implement `text-extractor.ts` -- PDF text extraction, TXT/MD passthrough | US-F09-05: document text extracted |
| 6.6 | Implement `chunker.ts` -- paragraph-boundary splitting, ~500 token target, ~50 token overlap | US-F09-05: text split into chunks with overlap |
| 6.7 | Implement `embedder.ts` -- OpenAI text-embedding-3-small batch embedding | US-F09-05: each chunk has embedding vector(1536) |
| 6.8 | Implement `embed-knowledge/index.ts` -- orchestrate: download file, extract text, chunk, embed, upsert | US-F09-05: all chunks stored as KnowledgeChunk records |
| 6.9 | Log LLM usage for embedding generation to `llm_usage` table | Architecture: LLM cost tracking |
| 6.10 | Handle empty/unparseable PDF: return 422 with error message | Edge case: image-based PDF returns no text |
| 6.11 | Handle `embed-knowledge` for single-chunk operations (settings_editor create/edit) | US-F09-08: embedding generated for new/edited entry |

### Task 7: Client Merge (US-F09-06, US-F09-07)

**Files:** `src/app/api/clients/merge/route.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 7.1 | Implement `POST /api/clients/merge` -- validate source != target, both exist, neither soft-deleted | US-F09-06: cannot merge into itself; cannot merge deleted client |
| 7.2 | Call `merge_clients` database function for atomic execution | US-F09-06: merge is atomic -- all or nothing |
| 7.3 | Verify all record types transferred: notes, follow-ups, bookings, messages, conversations | US-F09-06: all source records transfer to target |
| 7.4 | Verify source client soft-deleted (deleted_at set) | US-F09-06: source client has deleted_at timestamp |
| 7.5 | Verify merge history note created on target with source profile snapshot | US-F09-07: note content includes source name, phone, lifecycle, preferences, record counts |
| 7.6 | Verify merge history note has `source = 'merge_history'` | US-F09-07: note is visually distinguishable |
| 7.7 | Verify transferred notes retain original `created_at` and `source` values | US-F09-07: original timestamps preserved |
| 7.8 | Handle conversation UNIQUE constraint conflict during merge | Edge case: both clients have active conversations |
| 7.9 | Log comprehensive audit event with record counts | US-F09-06: audit event records count of each record type |
| 7.10 | Return merge result with record counts to UI | US-F09-06: confirmation screen shows record counts |

### Task 8: Staff App -- Notes UI (US-F09-01)

**Files:** `src/components/thread/note-input.tsx`, `src/components/thread/note-card.tsx`

| # | Task | AC Reference |
|---|------|-------------|
| 8.1 | Build note creation form with textarea + save button | US-F09-01: staff enters note text and taps save |
| 8.2 | Block save for empty/whitespace-only content (client-side validation) | US-F09-01: empty note blocked with validation message |
| 8.3 | Optimistic UI: show note in thread immediately after save, confirm on API response | US-F09-01: note appears without page refresh |
| 8.4 | Render notes with content, staff name, timestamp, source badge | US-F09-01: note displays content, staff name, timestamp |
| 8.5 | Merge history notes rendered with distinct styling (merge icon, no delete button) | US-F09-07: merge history note visually distinguishable |

### Task 9: Staff App -- Follow-ups UI (US-F09-02, US-F09-03, US-F09-04)

**Files:** `src/components/thread/followup-input.tsx`, `src/components/thread/followup-card.tsx`, `src/components/thread/followup-status-toggle.tsx`

| # | Task | AC Reference |
|---|------|-------------|
| 9.1 | Build follow-up creation form with content, type dropdown, optional date picker | US-F09-02: create follow-up with due date |
| 9.2 | Block save for empty content | US-F09-02: empty content rejected |
| 9.3 | Render follow-up cards with status badge, due date, content | US-F09-02: follow-up appears in client thread |
| 9.4 | Build status toggle dropdown (open/completed/pending) | US-F09-03: staff changes status |
| 9.5 | Overdue follow-ups shown with 'overdue' badge and visual warning | US-F09-03: overdue follow-up surfaced in UI |
| 9.6 | Completed follow-ups moved to history section | US-F09-03: completed follow-up no longer in active list |

### Task 10: Staff App -- Knowledge Base Settings (US-F09-05, US-F09-08)

**Files:** `src/components/settings/knowledge-base-panel.tsx`, `src/components/settings/knowledge-entry-editor.tsx`, `src/components/settings/document-upload.tsx`

| # | Task | AC Reference |
|---|------|-------------|
| 10.1 | Build knowledge base list view grouped by source with content preview | US-F09-08: entries displayed, grouped by source |
| 10.2 | Build document upload form with file picker, progress indicator, success/error display | US-F09-05: progress indicator while processing, success confirmation |
| 10.3 | Build inline editor for knowledge entry content | US-F09-08: staff edits content |
| 10.4 | Build delete confirmation dialog ("AI will no longer reference this information") | US-F09-08: confirmation dialog on delete |
| 10.5 | Build "Remove document" action that deletes all chunks for a source_ref | US-F09-08: all chunks with source_ref deleted |
| 10.6 | Accepted file type display and rejection message for unsupported types | US-F09-05: accepted file types message |
| 10.7 | File size limit rejection message | US-F09-05: file-size error message |

### Task 11: Staff App -- Client Merge (US-F09-06, US-F09-07)

**Files:** `src/components/client/merge-dialog.tsx`, `src/components/client/merge-client-search.tsx`

| # | Task | AC Reference |
|---|------|-------------|
| 11.1 | Build merge initiation action on client profile ("Merge into another client") | US-F09-06: staff selects "Merge into another client" |
| 11.2 | Build client search/select for target client | US-F09-06: staff searches for and selects target |
| 11.3 | Build merge confirmation dialog showing record counts and client details | US-F09-06: confirmation screen with target, source, record counts |
| 11.4 | Require explicit confirmation before executing merge | US-F09-06: staff must confirm before merge executes |
| 11.5 | Show error message on merge failure with both records unchanged | US-F09-06: error message indicating merge failed |
| 11.6 | Post-merge navigation to target client profile | US-F09-06: target client now has all records |

---

## 10. Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Note save latency | < 1s end-to-end | PRD requirement. Single Supabase INSERT. |
| Follow-up save latency | < 1s end-to-end | Same as notes -- pure DB write. |
| Document upload + processing | Upload < 2s, processing < 30s | Upload is Storage PUT. Processing is text extraction + chunking + embedding API calls. |
| Merge transaction duration | < 5s | Single DB transaction. At MVP scale (< 1000 records per client), well within Postgres transaction limits. |
| Knowledge search availability after upload | < 60s | Embedding generation is the bottleneck. Batched embedding call typically completes in 2-5s. |
| Document size limit | 10 MB | Balances processing time with practical document sizes. |
| Knowledge chunks per workspace | < 10,000 | ivfflat index with `lists = 100` is tuned for this range. Re-evaluate if exceeded. |
| Embedding cost per document | ~$0.0001 per chunk (500 tokens at $0.02/1M tokens) | text-embedding-3-small pricing. A 40-chunk document costs ~$0.004. |

---

## 11. Out of Scope

- **Async note categorization** (NF-02) -- Phase 3, F-13. Notes saved raw in F-09.
- **Promise extraction from conversation history** (NF-08) -- Phase 3, F-13.
- **COS-driven follow-up draft generation** (NF-07) -- Phase 3, F-12. F-09 provides the follow-up records.
- **AI-proposed follow-up creation** via the `create_followup` tool -- F-05/F-06 (approval flow).
- **OCR for image-based PDFs** -- future phase.
- **Full-text search on knowledge entries** -- semantic search (pgvector) handles this via F-05.
- **Bulk note/follow-up import** -- not in MVP.
- **Auto-merge detection** (suggesting duplicate clients) -- future phase.
- **Note editing** -- notes are append-only. Staff can delete and re-create.
