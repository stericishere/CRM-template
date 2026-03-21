import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// ── Chainable mock for Supabase service client query builder ────────
const mockMaybeSingle = vi.fn()
const mockSingle = vi.fn()
const mockEq = vi.fn((): Record<string, unknown> => ({
  eq: mockEq,
  maybeSingle: mockMaybeSingle,
  select: mockSelect,
}))
const mockSelect = vi.fn(() => ({ eq: mockEq, single: mockSingle, maybeSingle: mockMaybeSingle }))
const mockUpdate = vi.fn(() => ({ eq: mockEq }))
const mockFrom = vi.fn(() => ({
  select: mockSelect,
  update: mockUpdate,
}))

const mockServiceClient = { from: mockFrom }

// ── Mock external dependencies ──────────────────────────────────────
const mockAssertWorkspaceMember = vi.fn()
vi.mock('@/lib/supabase/assert-workspace-member', () => ({
  assertWorkspaceMember: (...args: unknown[]) => mockAssertWorkspaceMember(...args),
}))

const mockAssertWorkspaceRole = vi.fn()
vi.mock('@/lib/supabase/assert-workspace-role', () => ({
  assertWorkspaceRole: (...args: unknown[]) => mockAssertWorkspaceRole(...args),
}))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => mockServiceClient,
}))

// ── Import route handlers under test (after all mocks) ──────────────
import { PATCH, DELETE } from '../route'

// ── Helpers ─────────────────────────────────────────────────────────
const fakeUser = { id: 'user-uuid-1', email: 'owner@example.com' }
const fakeRoleAuth = { user: fakeUser, staffId: 'staff-owner-1', role: 'owner' }

function makeParams(workspaceId: string, staffId: string) {
  return Promise.resolve({ workspaceId, staffId })
}

// ────────────────────────────────────────────────────────────────────
// PATCH /api/workspaces/:workspaceId/staff/:staffId
// ────────────────────────────────────────────────────────────────────
describe('PATCH /api/workspaces/:workspaceId/staff/:staffId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates role successfully when caller is owner', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    const updatedStaff = {
      id: 'staff-2',
      role: 'admin',
      status: 'active',
      workspace_id: 'ws-1',
    }
    mockSingle.mockResolvedValue({ data: updatedStaff, error: null })

    const request = new NextRequest(
      'http://localhost/api/workspaces/ws-1/staff/staff-2',
      {
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
        headers: { 'Content-Type': 'application/json' },
      }
    )

    const response = await PATCH(request, {
      params: makeParams('ws-1', 'staff-2'),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.staff).toEqual(updatedStaff)

    // Verify it called update on the service client
    expect(mockFrom).toHaveBeenCalledWith('staff')
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' })
    )
  })

  it('returns 400 when trying to change own role (self-modification guard)', async () => {
    // staffId matches the caller's staffId
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    const request = new NextRequest(
      'http://localhost/api/workspaces/ws-1/staff/staff-owner-1',
      {
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
        headers: { 'Content-Type': 'application/json' },
      }
    )

    const response = await PATCH(request, {
      params: makeParams('ws-1', 'staff-owner-1'),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('Cannot change owner role')
  })

  it('returns 400 when trying to set role to owner', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    const request = new NextRequest(
      'http://localhost/api/workspaces/ws-1/staff/staff-2',
      {
        method: 'PATCH',
        body: JSON.stringify({ role: 'owner' }),
        headers: { 'Content-Type': 'application/json' },
      }
    )

    const response = await PATCH(request, {
      params: makeParams('ws-1', 'staff-2'),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('Cannot create additional owners')
  })

  it('clears removed_at when reactivating (status: active)', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    const reactivatedStaff = {
      id: 'staff-2',
      role: 'member',
      status: 'active',
      removed_at: null,
    }
    mockSingle.mockResolvedValue({ data: reactivatedStaff, error: null })

    const request = new NextRequest(
      'http://localhost/api/workspaces/ws-1/staff/staff-2',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
        headers: { 'Content-Type': 'application/json' },
      }
    )

    const response = await PATCH(request, {
      params: makeParams('ws-1', 'staff-2'),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.staff.removed_at).toBeNull()

    // Verify the update payload includes removed_at: null
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        removed_at: null,
      })
    )
  })

  it('sets removed_at when removing (status: removed)', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    const removedStaff = {
      id: 'staff-2',
      role: 'member',
      status: 'removed',
      removed_at: '2026-03-21T00:00:00.000Z',
    }
    mockSingle.mockResolvedValue({ data: removedStaff, error: null })

    const request = new NextRequest(
      'http://localhost/api/workspaces/ws-1/staff/staff-2',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'removed' }),
        headers: { 'Content-Type': 'application/json' },
      }
    )

    const response = await PATCH(request, {
      params: makeParams('ws-1', 'staff-2'),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.staff.status).toBe('removed')

    // Verify the update payload includes a removed_at timestamp
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'removed',
        removed_at: expect.any(String),
      })
    )
  })
})

// ────────────────────────────────────────────────────────────────────
// DELETE /api/workspaces/:workspaceId/staff/:staffId
// ────────────────────────────────────────────────────────────────────
describe('DELETE /api/workspaces/:workspaceId/staff/:staffId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('soft-deletes successfully', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    // .update().eq().eq().eq().select().maybeSingle() -> found & updated
    mockMaybeSingle.mockResolvedValue({ data: { id: 'staff-2' }, error: null })

    const request = new NextRequest(
      'http://localhost/api/workspaces/ws-1/staff/staff-2',
      { method: 'DELETE' }
    )

    const response = await DELETE(request, {
      params: makeParams('ws-1', 'staff-2'),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)

    // Verify soft-delete payload
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'removed',
        removed_at: expect.any(String),
        updated_at: expect.any(String),
      })
    )
  })

  it('returns 400 when trying to remove self', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    const request = new NextRequest(
      'http://localhost/api/workspaces/ws-1/staff/staff-owner-1',
      { method: 'DELETE' }
    )

    const response = await DELETE(request, {
      params: makeParams('ws-1', 'staff-owner-1'),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('Cannot remove yourself')
  })

  it('returns 404 when staff not found', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    // .update().eq().eq().eq().select().maybeSingle() -> null (not found)
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })

    const request = new NextRequest(
      'http://localhost/api/workspaces/ws-1/staff/nonexistent',
      { method: 'DELETE' }
    )

    const response = await DELETE(request, {
      params: makeParams('ws-1', 'nonexistent'),
    })

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error).toBe('Staff member not found')
  })
})
