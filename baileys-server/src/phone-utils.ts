// E.164 phone number and Baileys JID utilities
// Mirrors supabase/functions/_shared/phone-utils.ts for the Node.js runtime

const E164_REGEX = /^\+[1-9]\d{7,14}$/

export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone)
}

/** Convert a Baileys JID (e.g. "85291234567@s.whatsapp.net") to E.164 ("+85291234567"). */
export function jidToE164(jid: string): string {
  const number = jid.split('@')[0]
  if (!number) throw new Error(`Invalid JID: ${jid}`)
  const phone = `+${number}`
  if (!isValidE164(phone)) throw new Error(`Invalid E.164 from JID: ${jid}`)
  return phone
}
