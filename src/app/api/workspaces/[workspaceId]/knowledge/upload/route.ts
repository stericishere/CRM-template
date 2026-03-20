import { NextRequest, NextResponse } from 'next/server'

// ──────────────────────────────────────────────────────────
// POST /api/workspaces/:workspaceId/knowledge/upload
//
// Accepts a file via FormData, extracts text, chunks it,
// and embeds via the embed-knowledge Edge Function.
//
// FormData fields:
//   file   — the uploaded file (text/plain, text/csv, application/pdf, etc.)
//   source — source label for the knowledge chunks (optional, defaults to filename)
//
//  Client ──POST──> extract text ──call──> embed-knowledge EF
// ──────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

/** Maximum file size: 5 MB */
const MAX_FILE_SIZE = 5 * 1024 * 1024

/** Supported MIME types for text extraction */
const SUPPORTED_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return NextResponse.json(
        { error: 'Invalid form data' },
        { status: 400 }
      )
    }

    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'file field is required and must be a File' },
        { status: 400 }
      )
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)} MB` },
        { status: 400 }
      )
    }

    if (!SUPPORTED_TYPES.has(file.type) && !file.name.endsWith('.txt') && !file.name.endsWith('.md')) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Supported: ${[...SUPPORTED_TYPES].join(', ')}` },
        { status: 400 }
      )
    }

    // Extract text content from the file
    const content = await file.text()

    if (!content.trim()) {
      return NextResponse.json(
        { error: 'File is empty' },
        { status: 400 }
      )
    }

    const source = (formData.get('source') as string) || file.name

    // Call embed-knowledge Edge Function
    const efResponse = await fetch(`${SUPABASE_URL}/functions/v1/embed-knowledge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        content,
        source,
      }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!efResponse.ok) {
      const errText = await efResponse.text().catch(() => 'Unknown error')
      console.error('[POST /knowledge/upload] Embed failed:', efResponse.status, errText)
      return NextResponse.json(
        { error: 'Failed to process and embed file', details: errText },
        { status: 500 }
      )
    }

    const embedResult = await efResponse.json()

    return NextResponse.json(
      {
        status: 'uploaded',
        filename: file.name,
        size: file.size,
        source,
        chunks: embedResult.chunks,
      },
      { status: 201 }
    )
  } catch (err) {
    console.error('[POST /knowledge/upload]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
