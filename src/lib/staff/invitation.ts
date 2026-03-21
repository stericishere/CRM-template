import { randomBytes } from 'crypto'

/** Invitation validity period in days */
export const INVITATION_EXPIRY_DAYS = 7

/**
 * Generate a cryptographically-secure invitation token (64 hex chars / 32 bytes).
 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Build the full invitation URL that the invitee clicks to accept.
 */
export function buildInvitationUrl(token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  return `${appUrl}/api/auth/accept-invitation?token=${token}`
}
