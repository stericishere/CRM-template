import { describe, it, expect } from 'vitest'
import {
  startOnboardingSchema,
  identitySchema,
  knowledgeBaseSchema,
  scrapeInstagramSchema,
  generateSopsSchema,
  refineSopsSchema,
  confirmSopsSchema,
  extractToneSchema,
  refineToneSchema,
  confirmToneSchema,
} from '../schemas'

// ──────────────────────────────────────────────────────────
// startOnboardingSchema
// ──────────────────────────────────────────────────────────
describe('startOnboardingSchema', () => {
  it('should accept valid input', () => {
    const result = startOnboardingSchema.safeParse({
      owner_name: 'Alice',
      owner_phone: '+85291234567',
      owner_email: 'alice@example.com',
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing email (staff.email is NOT NULL)', () => {
    const result = startOnboardingSchema.safeParse({
      owner_name: 'Alice',
      owner_phone: '+85291234567',
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing owner_name', () => {
    const result = startOnboardingSchema.safeParse({
      owner_phone: '+85291234567',
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid phone (no + prefix)', () => {
    const result = startOnboardingSchema.safeParse({
      owner_name: 'Alice',
      owner_phone: '85291234567',
    })
    expect(result.success).toBe(false)
  })

  it('should reject phone starting with +0', () => {
    const result = startOnboardingSchema.safeParse({
      owner_name: 'Alice',
      owner_phone: '+0123456789',
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid email format', () => {
    const result = startOnboardingSchema.safeParse({
      owner_name: 'Alice',
      owner_phone: '+85291234567',
      owner_email: 'not-an-email',
    })
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// identitySchema
// ──────────────────────────────────────────────────────────
describe('identitySchema', () => {
  it('should accept valid identity', () => {
    const result = identitySchema.safeParse({
      business_name: 'Acme Wellness',
      vertical: 'wellness',
      timezone: 'Asia/Hong_Kong',
    })
    expect(result.success).toBe(true)
  })

  it('should accept optional fields', () => {
    const result = identitySchema.safeParse({
      business_name: 'Acme Wellness',
      vertical: 'wellness',
      timezone: 'Asia/Hong_Kong',
      instagram_handle: 'acme_wellness',
      description: 'A boutique wellness studio',
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty business_name', () => {
    const result = identitySchema.safeParse({
      business_name: '',
      vertical: 'wellness',
      timezone: 'Asia/Hong_Kong',
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing vertical', () => {
    const result = identitySchema.safeParse({
      business_name: 'Acme',
      timezone: 'Asia/Hong_Kong',
    })
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// knowledgeBaseSchema
// ──────────────────────────────────────────────────────────
describe('knowledgeBaseSchema', () => {
  it('should accept valid content with default source', () => {
    const result = knowledgeBaseSchema.safeParse({
      content: 'We offer Thai massage, Swedish massage, and hot stone therapy.',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.source).toBe('onboarding')
    }
  })

  it('should accept custom source', () => {
    const result = knowledgeBaseSchema.safeParse({
      content: 'Some knowledge content here.',
      source: 'manual_upload',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.source).toBe('manual_upload')
    }
  })

  it('should reject content shorter than 10 chars', () => {
    const result = knowledgeBaseSchema.safeParse({
      content: 'Too short',
    })
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// scrapeInstagramSchema
// ──────────────────────────────────────────────────────────
describe('scrapeInstagramSchema', () => {
  it('should accept valid handle', () => {
    const result = scrapeInstagramSchema.safeParse({ handle: 'acme_wellness' })
    expect(result.success).toBe(true)
  })

  it('should reject empty handle', () => {
    const result = scrapeInstagramSchema.safeParse({ handle: '' })
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// generateSopsSchema
// ──────────────────────────────────────────────────────────
describe('generateSopsSchema', () => {
  it('should accept minimal input', () => {
    const result = generateSopsSchema.safeParse({
      vertical: 'wellness',
      business_name: 'Acme Wellness',
    })
    expect(result.success).toBe(true)
  })

  it('should accept full input', () => {
    const result = generateSopsSchema.safeParse({
      vertical: 'dental',
      business_name: 'Bright Smile',
      description: 'A family dental clinic',
      knowledge_base: 'We offer cleanings, fillings, and whitening.',
    })
    expect(result.success).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────
// refineSopsSchema
// ──────────────────────────────────────────────────────────
describe('refineSopsSchema', () => {
  it('should accept valid refinement', () => {
    const result = refineSopsSchema.safeParse({
      instruction: 'Add a 90-minute deep tissue option',
      current_config: { sop_rules: ['rule1'], appointment_types: [] },
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty instruction', () => {
    const result = refineSopsSchema.safeParse({
      instruction: '',
      current_config: {},
    })
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// confirmSopsSchema
// ──────────────────────────────────────────────────────────
describe('confirmSopsSchema', () => {
  it('should accept valid VerticalConfig', () => {
    const result = confirmSopsSchema.safeParse({
      vertical_config: {
        sop_rules: ['Always greet by name', 'Confirm appointment 24h before'],
        custom_fields: [{ name: 'preferred_therapist', description: 'Client preferred therapist' }],
        appointment_types: [
          {
            name: 'Thai Massage',
            description: '60-minute traditional Thai massage',
            duration_minutes: 60,
          },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('should accept appointment_types with prerequisites', () => {
    const result = confirmSopsSchema.safeParse({
      vertical_config: {
        sop_rules: [],
        custom_fields: [],
        appointment_types: [
          {
            name: 'Deep Cleaning',
            description: 'Deep dental cleaning',
            duration_minutes: 90,
            prerequisites: ['initial_consultation'],
          },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing sop_rules', () => {
    const result = confirmSopsSchema.safeParse({
      vertical_config: {
        custom_fields: [],
        appointment_types: [],
      },
    })
    expect(result.success).toBe(false)
  })

  it('should reject negative duration_minutes', () => {
    const result = confirmSopsSchema.safeParse({
      vertical_config: {
        sop_rules: [],
        custom_fields: [],
        appointment_types: [
          {
            name: 'Test',
            description: 'Test',
            duration_minutes: -30,
          },
        ],
      },
    })
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// extractToneSchema
// ──────────────────────────────────────────────────────────
describe('extractToneSchema', () => {
  it('should accept instagram source', () => {
    const result = extractToneSchema.safeParse({ source: 'instagram' })
    expect(result.success).toBe(true)
  })

  it('should accept description source with content', () => {
    const result = extractToneSchema.safeParse({
      source: 'description',
      content: 'We are a friendly boutique spa that loves emojis',
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid source', () => {
    const result = extractToneSchema.safeParse({ source: 'twitter' })
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// refineToneSchema
// ──────────────────────────────────────────────────────────
describe('refineToneSchema', () => {
  it('should accept valid refinement', () => {
    const result = refineToneSchema.safeParse({
      feedback: 'Make it more casual and add more emojis',
      current_tone: { voice: 'professional', formality: 'formal' },
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty feedback', () => {
    const result = refineToneSchema.safeParse({
      feedback: '',
      current_tone: {},
    })
    expect(result.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// confirmToneSchema
// ──────────────────────────────────────────────────────────
describe('confirmToneSchema', () => {
  it('should accept valid ToneProfile', () => {
    const result = confirmToneSchema.safeParse({
      tone_profile: {
        voice: 'warm and professional',
        formality: 'balanced',
        emoji_usage: 'minimal',
        greeting_style: 'Hi {name}! 👋',
        sign_off_style: 'Looking forward to seeing you!',
      },
    })
    expect(result.success).toBe(true)
  })

  it('should accept with sample_responses', () => {
    const result = confirmToneSchema.safeParse({
      tone_profile: {
        voice: 'friendly',
        formality: 'casual',
        emoji_usage: 'frequent',
        greeting_style: 'Hey! 😊',
        sign_off_style: 'See you soon! ✨',
        sample_responses: [
          'Sure thing! Let me check our availability for you 📅',
          'Great choice! Our Thai massage is super popular 💆',
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid formality value', () => {
    const result = confirmToneSchema.safeParse({
      tone_profile: {
        voice: 'professional',
        formality: 'ultra_formal',
        emoji_usage: 'none',
        greeting_style: 'Dear Sir/Madam',
        sign_off_style: 'Regards',
      },
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid emoji_usage value', () => {
    const result = confirmToneSchema.safeParse({
      tone_profile: {
        voice: 'friendly',
        formality: 'casual',
        emoji_usage: 'tons',
        greeting_style: 'Hey!',
        sign_off_style: 'Bye!',
      },
    })
    expect(result.success).toBe(false)
  })
})
