import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

/**
 * Verify the authenticated user belongs to the given workspace.
 *
 * Returns `{ user, staffId }` on success, or a `NextResponse` (401/403)
 * on failure.  Callers check the result with `instanceof NextResponse`:
 *
 *   const auth = await assertWorkspaceMember(workspaceId)
 *   if (auth instanceof NextResponse) return auth
 *   // auth.user and auth.staffId are now available
 */
export async function assertWorkspaceMember(
  workspaceId: string
): Promise<{ user: User; staffId: string } | NextResponse> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: staffRow } = await authClient
    .from('staff')
    .select('id')
    .eq('id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!staffRow) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return { user, staffId: staffRow.id as string }
}
