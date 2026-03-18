/**
 * E.164 phone number utilities.
 *
 * Canonical source: supabase/functions/_shared/phone-utils.ts
 * This file mirrors it for the Node.js runtime (baileys-server).
 * Keep in sync when modifying validation rules.
 */

const E164_REGEX = /^\+[1-9]\d{7,14}$/

export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone)
}

/** Convert Baileys JID (e.g. "85291234567@s.whatsapp.net") to E.164 ("+85291234567") */
export function jidToE164(jid: string): string {
  const number = jid.split('@')[0]
  if (!number) {
    throw new Error(`Invalid JID: ${jid}`)
  }
  const e164 = `+${number}`
  if (!isValidE164(e164)) {
    throw new Error(`JID produced invalid E.164: ${jid} -> ${e164}`)
  }
  return e164
}

/** Convert E.164 ("+85291234567") to Baileys JID ("85291234567@s.whatsapp.net") */
export function e164ToJid(phone: string): string {
  if (!isValidE164(phone)) {
    throw new Error(`Invalid E.164 for JID conversion: ${phone}`)
  }
  return `${phone.slice(1)}@s.whatsapp.net`
}
