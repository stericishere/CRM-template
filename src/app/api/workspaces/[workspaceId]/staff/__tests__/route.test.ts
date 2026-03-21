import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// ── Chainable mock for Supabase service client query builder ────────
// Each method returns an object with the next chaining methods available.
// We track separate terminal mocks for different query shapes:
//   - mockMaybeSingle: for .from().select().eq().eq().eq().maybeSingle()
//   - mockSingle: for .from().insert().select().single()
//   - mockOrder: for .from().select().eq().in().order() or .eq().order()
//   - mockUpdate: for .from().update().eq().eq().eq().lt()
const mockMaybeSingle = vi.fn()
const mockSingle = vi.fn()
const mockOrder = vi.fn(() => ({ order: mockOrder }))
const mockIn = vi.fn(() => ({ order: mockOrder }))
const mockLt = vi.fn()
const mockGt = vi.fn(() => ({ maybeSingle: mockMaybeSingle }))
const mockEq = vi.fn((): Record<string, unknown> => ({
  eq: mockEq,
  in: mockIn,
  maybeSingle: mockMaybeSingle,
  order: mockOrder,
  lt: mockLt,
  gt: mockGt,
}))
const mockSelect = vi.fn(() => ({ eq: mockEq, single: mockSingle }))
const mockInsert = vi.fn(() => ({ select: mockSelect }))
const mockUpdate = vi.fn(() => ({ eq: mockEq }))
const mockFrom = vi.fn(() => ({
  select: mockSelect,
  insert: mockInsert,
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

const mockGenerateInvitationToken = vi.fn()
const mockBuildInvitationUrl = vi.fn()
vi.mock('@/lib/staff/invitation', () => ({
  generateInvitationToken: (...args: unknown[]) => mockGenerateInvitationToken(...args),
  buildInvitationUrl: (...args: unknown[]) => mockBuildInvitationUrl(...args),
  INVITATION_EXPIRY_DAYS: 7,
}))

// ── Import route handlers under test (after all mocks) ──────────────
import { GET, POST } from '../route'

// ── Helpers ─────────────────────────────────────────────────────────
const fakeUser = { id: 'user-uuid-1', email: 'owner@example.com' }
const fakeAuth = { user: fakeUser, staffId: 'staff-owner-1' }
const fakeRoleAuth = { user: fakeUser, staffId: 'staff-owner-1', role: 'owner' }

function makeParams(workspaceId: string) {
  return Promise.resolve({ workspaceId })
}

// ────────────────────────────────────────────────────────────────────
// GET /api/workspaces/:workspaceId/staff
// ────────────────────────────────────────────────────────────────────
describe('GET /api/workspaces/:workspaceId/staff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns staff list and pending invitations on success', async () => {
    mockAssertWorkspaceMember.mockResolvedValue(fakeAuth)

    const staffRows = [
      { id: 's1', role: 'owner', status: 'active' },
      { id: 's2', role: 'member', status: 'active' },
    ]
    const invitationRows = [
      { id: 'inv1', email: 'new@example.com', role: 'member', status: 'pending' },
    ]

    // First Promise.all call: staff query, then invitations query
    // Staff query chain: .from('staff').select('*').eq().in().order().order()
    // Invitations query chain: .from('staff_invitations').select().eq().eq().order()
    //
    // Both queries go through mockFrom -> mockSelect -> mockEq -> ...
    // The terminal mock (mockOrder) is called in sequence. We use
    // mockOrder to return the result for the last .order() in each chain.

    // The route does Promise.all on two queries. Each query chain ends
    // with the last .order() call. We need mockOrder to return the staff
    // result first, then the invitations result.
    mockOrder
      .mockReturnValueOnce({ order: vi.fn().mockResolvedValue({ data: staffRows, error: null }) })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock terminal value
      .mockReturnValueOnce({ data: invitationRows, error: null } as any)

    const request = new NextRequest('http://localhost/api/workspaces/ws-1/staff')
    const response = await GET(request, { params: makeParams('ws-1') })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.staff).toEqual(staffRows)
    expect(body.invitations).toEqual(invitationRows)
  })

  it('returns 401 when not authenticated', async () => {
    const unauthorizedResponse = NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
    mockAssertWorkspaceMember.mockResolvedValue(unauthorizedResponse)

    const request = new NextRequest('http://localhost/api/workspaces/ws-1/staff')
    const response = await GET(request, { params: makeParams('ws-1') })

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized')
  })
})

// ────────────────────────────────────────────────────────────────────
// POST /api/workspaces/:workspaceId/staff
// ────────────────────────────────────────────────────────────────────
describe('POST /api/workspaces/:workspaceId/staff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates invitation when caller is owner — returns 201 with invitation data', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    // existingStaff check -> null (no conflict)
    mockMaybeSingle.mockResolvedValueOnce({ data: null })

    // expire stale invitations -> update chain (return value unused by route)
    mockLt.mockResolvedValueOnce({ data: null, error: null })

    // existingInvitation check -> null (no conflict)
    mockMaybeSingle.mockResolvedValueOnce({ data: null })

    const fakeToken = 'abc123token'
    const fakeUrl = 'http://localhost:3000/api/auth/accept-invitation?token=abc123token'
    mockGenerateInvitationToken.mockReturnValue(fakeToken)
    mockBuildInvitationUrl.mockReturnValue(fakeUrl)

    const insertedInvitation = {
      id: 'inv-1',
      email: 'newbie@example.com',
      role: 'member',
      token: fakeToken,
      expires_at: '2026-03-28T00:00:00.000Z',
    }
    mockSingle.mockResolvedValue({ data: insertedInvitation, error: null })

    const request = new NextRequest('http://localhost/api/workspaces/ws-1/staff', {
      method: 'POST',
      body: JSON.stringify({
        email: 'newbie@example.com',
        full_name: 'New Person',
        role: 'member',
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await POST(request, { params: makeParams('ws-1') })

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.invitation).toEqual({
      ...insertedInvitation,
      url: fakeUrl,
    })
    expect(mockBuildInvitationUrl).toHaveBeenCalledWith(fakeToken)
    expect(mockGenerateInvitationToken).toHaveBeenCalled()
  })

  it('returns 403 when caller is member (assertWorkspaceRole returns NextResponse)', async () => {
    const forbiddenResponse = NextResponse.json(
      { error: 'Insufficient permissions' },
      { status: 403 }
    )
    mockAssertWorkspaceRole.mockResolvedValue(forbiddenResponse)

    const request = new NextRequest('http://localhost/api/workspaces/ws-1/staff', {
      method: 'POST',
      body: JSON.stringify({
        email: 'newbie@example.com',
        full_name: 'New Person',
        role: 'member',
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await POST(request, { params: makeParams('ws-1') })

    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error).toBe('Insufficient permissions')
  })

  it('returns 409 when email already has active staff', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    // existingStaff check -> found conflict
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: 'existing-staff-1' } })

    const request = new NextRequest('http://localhost/api/workspaces/ws-1/staff', {
      method: 'POST',
      body: JSON.stringify({
        email: 'existing@example.com',
        full_name: 'Existing',
        role: 'member',
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await POST(request, { params: makeParams('ws-1') })

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toBe('A staff member with this email already exists in the workspace')
  })

  it('returns 409 when pending non-expired invitation exists', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    // existingStaff check -> null
    mockMaybeSingle.mockResolvedValueOnce({ data: null })

    // expire stale invitations
    mockLt.mockResolvedValueOnce({ data: null, error: null })

    // existingInvitation check -> found pending invitation
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: 'pending-inv-1' } })

    const request = new NextRequest('http://localhost/api/workspaces/ws-1/staff', {
      method: 'POST',
      body: JSON.stringify({
        email: 'pending@example.com',
        full_name: 'Pending',
        role: 'member',
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await POST(request, { params: makeParams('ws-1') })

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toBe('A pending invitation already exists for this email')
  })

  it('returns 400 on invalid body (missing email)', async () => {
    mockAssertWorkspaceRole.mockResolvedValue(fakeRoleAuth)

    const request = new NextRequest('http://localhost/api/workspaces/ws-1/staff', {
      method: 'POST',
      body: JSON.stringify({ full_name: 'No Email', role: 'member' }),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await POST(request, { params: makeParams('ws-1') })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('Validation failed')
    expect(body.details).toBeDefined()
  })
})
