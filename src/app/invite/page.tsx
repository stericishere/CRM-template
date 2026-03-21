'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

// ──────────────────────────────────────────────────────────
// /invite?token=...&workspace=...&email=...
//
// Landing page for invitation acceptance. The GET handler on
// /api/auth/accept-invitation validates the token and redirects
// here with query params. This page calls the POST endpoint
// with the token to complete acceptance.
//
//   Browser clicks invite URL
//     → GET /api/auth/accept-invitation?token=...
//     → 302 /invite?token=...&workspace=...&email=...
//     → This page renders, user clicks "Accept"
//     → POST /api/auth/accept-invitation { token }
// ──────────────────────────────────────────────────────────

function InviteContent() {
  const params = useSearchParams()
  const token = params.get('token')
  const email = params.get('email')
  const error = params.get('error')
  const workspace = params.get('workspace')

  if (error) {
    const messages: Record<string, string> = {
      missing_token: 'No invitation token provided.',
      invalid_or_expired: 'This invitation has expired or is no longer valid.',
    }
    return (
      <div style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center' }}>
        <h1>Invitation Error</h1>
        <p>{messages[error] ?? 'Something went wrong with this invitation.'}</p>
      </div>
    )
  }

  if (!token) {
    return (
      <div style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center' }}>
        <h1>Invalid Link</h1>
        <p>This invitation link is missing required information.</p>
      </div>
    )
  }

  async function handleAccept() {
    const res = await fetch('/api/auth/accept-invitation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    if (res.ok) {
      const data = await res.json()
      window.location.href = `/workspaces/${data.workspace_id}`
    } else {
      const data = await res.json().catch(() => ({ error: 'Unknown error' }))
      alert(data.error ?? 'Failed to accept invitation')
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center' }}>
      <h1>Workspace Invitation</h1>
      {email && <p>You have been invited as <strong>{email}</strong></p>}
      {workspace && <p>Workspace: {workspace}</p>}
      <p>Click below to accept this invitation and join the workspace.</p>
      <button
        onClick={handleAccept}
        style={{
          padding: '12px 24px',
          fontSize: 16,
          cursor: 'pointer',
          marginTop: 16,
        }}
      >
        Accept Invitation
      </button>
    </div>
  )
}

export default function InvitePage() {
  return (
    <Suspense fallback={<div style={{ textAlign: 'center', marginTop: 80 }}>Loading...</div>}>
      <InviteContent />
    </Suspense>
  )
}
