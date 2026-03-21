import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// Chainable mock for Supabase query builder
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

import { assertAuthenticated, assertWorkspaceMember } from '../assert-workspace-member'

const fakeUser = { id: 'user-uuid-1', email: 'test@example.com' }

describe('assertWorkspaceMember', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { user, staffId } when user is authenticated and belongs to workspace', async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser } })
    mockMaybeSingle.mockResolvedValue({ data: { id: 'user-uuid-1' } })

    const result = await assertWorkspaceMember('ws-1')

    expect(result).not.toBeInstanceOf(NextResponse)
    const auth = result as { user: typeof fakeUser; staffId: string }
    expect(auth.user).toEqual(fakeUser)
    expect(auth.staffId).toBe('user-uuid-1')
  })

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const result = await assertWorkspaceMember('ws-1')

    expect(result).toBeInstanceOf(NextResponse)
    const response = result as NextResponse
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 403 when user is not a workspace member', async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser } })
    mockMaybeSingle.mockResolvedValue({ data: null })

    const result = await assertWorkspaceMember('ws-1')

    expect(result).toBeInstanceOf(NextResponse)
    const response = result as NextResponse
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error).toBe('Forbidden')
  })

  it('queries staff with the correct workspace_id', async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser } })
    mockMaybeSingle.mockResolvedValue({ data: { id: 'user-uuid-1' } })

    await assertWorkspaceMember('workspace-abc')

    // Second .eq() call is for workspace_id
    expect(mockEq).toHaveBeenCalledWith('workspace_id', 'workspace-abc')
  })

  it('queries staff with the authenticated user ID', async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser } })
    mockMaybeSingle.mockResolvedValue({ data: { id: 'user-uuid-1' } })

    await assertWorkspaceMember('ws-1')

    // First .eq() call is for id
    expect(mockEq).toHaveBeenCalledWith('id', 'user-uuid-1')
  })
})

describe('assertAuthenticated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { user } when user is authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: fakeUser } })

    const result = await assertAuthenticated()

    expect(result).not.toBeInstanceOf(NextResponse)
    const auth = result as { user: typeof fakeUser }
    expect(auth.user).toEqual(fakeUser)
  })

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const result = await assertAuthenticated()

    expect(result).toBeInstanceOf(NextResponse)
    const response = result as NextResponse
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized')
  })
})
