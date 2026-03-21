import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { assertAuthenticated } from './assert-workspace-member'
import type { User } from '@supabase/supabase-js'

/**
 * Verify the authenticated user belongs to the given workspace
 * AND holds one of the required roles.
 *
 * Returns `{ user, staffId, role }` on success, or a `NextResponse`
 * (401/403) on failure.  Callers check the result with `instanceof NextResponse`:
 *
 *   const auth = await assertWorkspaceRole(workspaceId, ['owner', 'admin'])
 *   if (auth instanceof NextResponse) return auth
 *   // auth.user, auth.staffId, auth.role are now available
 */
export async function assertWorkspaceRole(
  workspaceId: string,
  requiredRoles: string[]
): Promise<{ user: User; staffId: string; role: string } | NextResponse> {
  // 1. Authenticate
  const authed = await assertAuthenticated()
  if (authed instanceof NextResponse) return authed

  // 2. Look up staff row with role, filtered to active members
  const supabase = await createClient()
  const { data: staffRow } = await supabase
    .from('staff')
    .select('id, role')
    .eq('id', authed.user.id)
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .maybeSingle()

  // 3. No active membership -> 403
  if (!staffRow) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 4. Role not in allowed list -> 403 with specific message
  if (!requiredRoles.includes(staffRow.role as string)) {
    return NextResponse.json(
      { error: 'Insufficient permissions' },
      { status: 403 }
    )
  }

  // 5. Success
  return {
    user: authed.user,
    staffId: staffRow.id as string,
    role: staffRow.role as string,
  }
}
