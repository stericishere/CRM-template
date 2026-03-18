// E.164 phone number validation and normalization
// Used by process-message Edge Function and Baileys server

const E164_REGEX = /^\+[1-9]\d{7,14}$/

export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone)
}

export function normalizePhone(phone: string): string {
  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, '')

  // Ensure + prefix
  if (!cleaned.startsWith('+')) {
    cleaned = `+${cleaned}`
  }

  if (!isValidE164(cleaned)) {
    throw new Error(`Invalid E.164 phone number: ${phone} (cleaned: ${cleaned})`)
  }

  return cleaned
}

// Convert Baileys JID to E.164
export function jidToE164(jid: string): string {
  const number = jid.split('@')[0]
  if (!number) {
    throw new Error(`Invalid JID: ${jid}`)
  }
  return normalizePhone(`+${number}`)
}

// Convert E.164 to Baileys JID
export function e164ToJid(phone: string): string {
  if (!isValidE164(phone)) {
    throw new Error(`Invalid E.164 for JID conversion: ${phone}`)
  }
  return `${phone.slice(1)}@s.whatsapp.net`
}
