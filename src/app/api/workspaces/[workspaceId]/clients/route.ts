import { NextRequest, NextResponse } from 'next/server'
import { createClientSchema, lifecycleStatusSchema } from '@/lib/clients/types'
import type { LifecycleStatus } from '@/lib/clients/types'
import * as clientRepo from '@/lib/clients/repository'

// ──────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/clients
//
// Query params: lifecycle_status, search, page, limit
// ──────────────────────────────────────────────────────────
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params
    const url = request.nextUrl

    // Parse optional lifecycle_status filter
    let lifecycle_status: LifecycleStatus | undefined
    const rawStatus = url.searchParams.get('lifecycle_status')
    if (rawStatus) {
      const parsed = lifecycleStatusSchema.safeParse(rawStatus)
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'Invalid lifecycle_status', details: parsed.error.flatten() },
          { status: 400 }
        )
      }
      lifecycle_status = parsed.data
    }

    const search = url.searchParams.get('search') ?? undefined
    const page = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined

    const result = await clientRepo.list(workspaceId, {
      lifecycle_status,
      search,
      page,
      limit,
    })

    return NextResponse.json(result)
  } catch (err) {
    console.error('[GET /clients]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ──────────────────────────────────────────────────────────
// POST /api/workspaces/:workspaceId/clients
//
// Body: { phone, full_name?, email? }
// ──────────────────────────────────────────────────────────
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createClientSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { phone, full_name, email } = parsed.data

    const client = await clientRepo.findOrCreate(workspaceId, phone, {
      full_name,
      email,
    })

    return NextResponse.json(client, { status: 201 })
  } catch (err) {
    console.error('[POST /clients]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
