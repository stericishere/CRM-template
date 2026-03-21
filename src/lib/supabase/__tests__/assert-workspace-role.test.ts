import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// Chainable mock for Supabase query builder (same pattern as assert-workspace-member tests)
const mockMaybeSingle = vi.fn()
const mockEq = vi.fn(() => ({ eq: mockEq, maybeSingle: mockMaybeSingle }))
const mockSelect = vi.fn(() => ({ eq: mockEq }))
const mockFrom = vi.fn(() => ({ select: mockSelect }))
const mockGetUser = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}))

import { assertWorkspaceRole } from '../assert-workspace-role'

const fakeUser = { id: 'user-uuid-1', email: 'test@example.com' }

describe('assertWorkspaceRole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { user, staffId, role } when role matches', async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser } })
    mockMaybeSingle.mockResolvedValue({ data: { id: 'user-uuid-1', role: 'admin' } })

    const result = await assertWorkspaceRole('ws-1', ['admin'])

    expect(result).not.toBeInstanceOf(NextResponse)
    const auth = result as { user: typeof fakeUser; staffId: string; role: string }
    expect(auth.user).toEqual(fakeUser)
    expect(auth.staffId).toBe('user-uuid-1')
    expect(auth.role).toBe('admin')
  })

  it('returns 403 when role does not match requiredRoles', async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser } })
    mockMaybeSingle.mockResolvedValue({ data: { id: 'user-uuid-1', role: 'member' } })

    const result = await assertWorkspaceRole('ws-1', ['owner', 'admin'])

    expect(result).toBeInstanceOf(NextResponse)
    const response = result as NextResponse
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error).toBe('Insufficient permissions')
  })

  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const result = await assertWorkspaceRole('ws-1', ['admin'])

    expect(result).toBeInstanceOf(NextResponse)
    const response = result as NextResponse
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 403 when not a workspace member', async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser } })
    mockMaybeSingle.mockResolvedValue({ data: null })

    const result = await assertWorkspaceRole('ws-1', ['admin'])

    expect(result).toBeInstanceOf(NextResponse)
    const response = result as NextResponse
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error).toBe('Forbidden')
  })

  it('accepts array of roles (["owner", "admin"])', async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser } })
    mockMaybeSingle.mockResolvedValue({ data: { id: 'user-uuid-1', role: 'owner' } })

    const result = await assertWorkspaceRole('ws-1', ['owner', 'admin'])

    expect(result).not.toBeInstanceOf(NextResponse)
    const auth = result as { user: typeof fakeUser; staffId: string; role: string }
    expect(auth.role).toBe('owner')
  })
})
