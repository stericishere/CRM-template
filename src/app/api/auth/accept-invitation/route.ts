import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { z } from 'zod'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

const acceptSchema = z.object({
  token: z.string().min(1),
})

// ──────────────────────────────────────────────────────────
// GET /api/auth/accept-invitation?token=...
//
// Browser-clickable entry point. Validates the token exists,
// then redirects to the app with the token so the frontend
// can complete the acceptance (POST with auth context).
// ──────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) {
    return NextResponse.redirect(`${APP_URL}/invite?error=missing_token`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
  const supabase = getServiceClient() as any

  // Validate token exists and is pending + not expired
  const { data: invitation } = await supabase
    .from('staff_invitations')
    .select('id, workspace_id, email, full_name, role')
    .eq('token', token)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (!invitation) {
    return NextResponse.redirect(`${APP_URL}/invite?error=invalid_or_expired`)
  }

  // Redirect to the app's invite acceptance page with token
  return NextResponse.redirect(
    `${APP_URL}/invite?token=${encodeURIComponent(token)}&workspace=${invitation.workspace_id}&email=${encodeURIComponent(invitation.email)}`
  )
}

// ──────────────────────────────────────────────────────────
// POST /api/auth/accept-invitation
//
// Accept a staff invitation using the token.
// Public endpoint — the token itself acts as authentication.
// Body: { token: string }
//
// Flow:
//   1. Validate token against pending + non-expired invitations
//   2. Check Supabase Auth user exists for the email
//   3. Check no duplicate staff record in the workspace
//   4. Create staff record and mark invitation as accepted
// Returns { staff: {...}, workspace_id } with status 201
// ──────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = acceptSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { token } = parsed.data

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    // 1. Look up the pending, non-expired invitation
    const { data: invitation, error: invError } = await supabase
      .from('staff_invitations')
      .select('*')
      .eq('token', token)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (invError) {
      console.error('[POST /accept-invitation] Invitation query failed:', invError.message)
      return NextResponse.json(
        { error: 'Failed to look up invitation' },
        { status: 500 }
      )
    }

    if (!invitation) {
      return NextResponse.json(
        { error: 'Invalid or expired invitation' },
        { status: 400 }
      )
    }

    // 2. Check if a Supabase Auth user exists with this email
    const { data: userList, error: userError } = await supabase.auth.admin.listUsers()

    if (userError) {
      console.error('[POST /accept-invitation] User lookup failed:', userError.message)
      return NextResponse.json(
        { error: 'Failed to verify user account' },
        { status: 500 }
      )
    }

    const authUser = (userList?.users ?? []).find(
      (u: { email?: string }) => u.email?.toLowerCase() === invitation.email.toLowerCase()
    )

    if (!authUser) {
      return NextResponse.json(
        { error: 'Please create an account first, then accept the invitation' },
        { status: 400 }
      )
    }

    // 3. Check for existing staff record (any status)
    const { data: existingStaff } = await supabase
      .from('staff')
      .select('id, status')
      .eq('id', authUser.id)
      .eq('workspace_id', invitation.workspace_id)
      .maybeSingle()

    if (existingStaff?.status === 'active') {
      return NextResponse.json(
        { error: 'You are already a member of this workspace' },
        { status: 409 }
      )
    }

    let staff
    if (existingStaff) {
      // 4a. Reactivate a previously removed staff member
      const { data, error: reactivateError } = await supabase
        .from('staff')
        .update({
          status: 'active',
          role: invitation.role,
          full_name: invitation.full_name,
          email: invitation.email,
          invited_by: invitation.invited_by,
          removed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', authUser.id)
        .eq('workspace_id', invitation.workspace_id)
        .select('id, workspace_id, full_name, email, role')
        .single()

      if (reactivateError) {
        console.error('[POST /accept-invitation] Staff reactivation failed:', reactivateError.message)
        return NextResponse.json(
          { error: 'Failed to reactivate staff record' },
          { status: 500 }
        )
      }
      staff = data
    } else {
      // 4b. Create new staff record
      const { data, error: staffError } = await supabase
        .from('staff')
        .insert({
          id: authUser.id,
          workspace_id: invitation.workspace_id,
          full_name: invitation.full_name,
          email: invitation.email,
          role: invitation.role,
          status: 'active',
          invited_by: invitation.invited_by,
        })
        .select('id, workspace_id, full_name, email, role')
        .single()

      if (staffError) {
        console.error('[POST /accept-invitation] Staff insert failed:', staffError.message)
        return NextResponse.json(
          { error: 'Failed to create staff record' },
          { status: 500 }
        )
      }
      staff = data
    }

    // 5. Mark invitation as accepted
    const { error: updateError } = await supabase
      .from('staff_invitations')
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString(),
      })
      .eq('id', invitation.id)

    if (updateError) {
      console.error('[POST /accept-invitation] Invitation update failed:', updateError.message)
      // Staff record was created successfully, so log but don't fail
    }

    return NextResponse.json(
      {
        staff,
        workspace_id: invitation.workspace_id,
      },
      { status: 201 }
    )
  } catch (err) {
    console.error('[POST /accept-invitation]', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
