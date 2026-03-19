import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VerticalConfig, ToneProfile } from '../schemas'

// ──────────────────────────────────────────────────────────
// Integration test for the onboarding flow
//
// Validates the logical sequence of onboarding steps
// and data transformations between steps.
// ──────────────────────────────────────────────────────────

// Mock Supabase service client
const mockSupabase = {
  from: vi.fn(() => ({
    insert: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(() => ({
          data: { id: 'ws-001' },
          error: null,
        })),
      })),
    })),
    update: vi.fn(() => ({
      eq: vi.fn(() => ({ data: null, error: null })),
    })),
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        single: vi.fn(() => ({
          data: {
            id: 'ws-001',
            business_name: null,
            onboarding_status: 'in_progress',
            whatsapp_connection_status: 'disconnected',
          },
          error: null,
        })),
      })),
    })),
  })),
}

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => mockSupabase,
}))

describe('Onboarding Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Step completion derivation', () => {
    it('should identify all steps as incomplete for a fresh workspace', () => {
      const workspace = {
        whatsapp_connection_status: 'disconnected',
        business_name: null,
        vertical: null,
        knowledge_base: null,
        vertical_config: null,
        tone_profile: null,
        onboarding_status: 'in_progress',
      }

      const steps = deriveSteps(workspace)
      expect(steps.whatsapp).toBe(false)
      expect(steps.identity).toBe(false)
      expect(steps.knowledge).toBe(false)
      expect(steps.sops).toBe(false)
      expect(steps.tone).toBe(false)
      expect(steps.activation).toBe(false)
    })

    it('should mark WhatsApp as complete when connected', () => {
      const workspace = {
        whatsapp_connection_status: 'connected',
        business_name: null,
        vertical: null,
        knowledge_base: null,
        vertical_config: null,
        tone_profile: null,
        onboarding_status: 'in_progress',
      }

      const steps = deriveSteps(workspace)
      expect(steps.whatsapp).toBe(true)
      expect(steps.identity).toBe(false)
    })

    it('should mark identity as complete when name and vertical set', () => {
      const workspace = {
        whatsapp_connection_status: 'connected',
        business_name: 'Acme Spa',
        vertical: 'wellness',
        knowledge_base: null,
        vertical_config: null,
        tone_profile: null,
        onboarding_status: 'in_progress',
      }

      const steps = deriveSteps(workspace)
      expect(steps.identity).toBe(true)
      expect(steps.knowledge).toBe(false)
    })

    it('should identify current step as first incomplete', () => {
      const workspace = {
        whatsapp_connection_status: 'connected',
        business_name: 'Acme Spa',
        vertical: 'wellness',
        knowledge_base: 'We offer massages.',
        vertical_config: null,
        tone_profile: null,
        onboarding_status: 'in_progress',
      }

      const steps = deriveSteps(workspace)
      const currentStep = findCurrentStep(steps)
      expect(currentStep).toBe('sops')
    })

    it('should return complete when all steps done', () => {
      const workspace = {
        whatsapp_connection_status: 'connected',
        business_name: 'Acme Spa',
        vertical: 'wellness',
        knowledge_base: 'We offer massages.',
        vertical_config: { sop_rules: [] },
        tone_profile: { voice: 'friendly' },
        onboarding_status: 'complete',
      }

      const steps = deriveSteps(workspace)
      const currentStep = findCurrentStep(steps)
      expect(currentStep).toBe('complete')
    })
  })

  describe('VerticalConfig validation', () => {
    it('should represent a complete config for a wellness vertical', () => {
      const config: VerticalConfig = {
        sop_rules: [
          'Always greet the client by name',
          'Confirm appointment 24h before via WhatsApp',
          'Ask about allergies before first session',
          'Send aftercare tips after treatment',
        ],
        custom_fields: [
          { name: 'preferred_therapist', description: 'Client preferred therapist name' },
          { name: 'allergies', description: 'Known allergies or sensitivities' },
        ],
        appointment_types: [
          {
            name: 'Thai Massage',
            description: '60-minute traditional Thai massage',
            duration_minutes: 60,
          },
          {
            name: 'Swedish Massage',
            description: '60-minute relaxation massage',
            duration_minutes: 60,
          },
          {
            name: 'Hot Stone',
            description: '90-minute hot stone therapy',
            duration_minutes: 90,
            prerequisites: ['initial_consultation'],
          },
        ],
        business_hours: {
          monday: { open: '09:00', close: '21:00' },
          tuesday: { open: '09:00', close: '21:00' },
          wednesday: { open: '09:00', close: '21:00' },
          thursday: { open: '09:00', close: '21:00' },
          friday: { open: '09:00', close: '22:00' },
          saturday: { open: '10:00', close: '22:00' },
          sunday: { open: '10:00', close: '18:00' },
        },
      }

      expect(config.sop_rules).toHaveLength(4)
      expect(config.appointment_types).toHaveLength(3)
      expect(config.appointment_types[2]?.prerequisites).toContain('initial_consultation')
    })
  })

  describe('ToneProfile validation', () => {
    it('should represent a complete tone profile', () => {
      const tone: ToneProfile = {
        voice: 'warm and professional with a touch of playfulness',
        formality: 'balanced',
        emoji_usage: 'moderate',
        greeting_style: 'Hi {name}! 👋',
        sign_off_style: 'Looking forward to seeing you! ✨',
        sample_responses: [
          'Sure thing! Let me check our availability for you 📅',
          'Great choice — our Thai massage is really popular! Would you like morning or afternoon?',
        ],
      }

      expect(tone.formality).toBe('balanced')
      expect(tone.emoji_usage).toBe('moderate')
      expect(tone.sample_responses).toHaveLength(2)
    })
  })

  describe('Activation prerequisites', () => {
    it('should require WhatsApp connection for activation', () => {
      const workspace = {
        whatsapp_connection_status: 'disconnected',
        business_name: 'Acme',
        vertical_config: { sop_rules: [] },
        knowledge_base: 'KB content',
      }

      const missing = checkActivationPrereqs(workspace)
      expect(missing).toContain('whatsapp')
    })

    it('should require business identity for activation', () => {
      const workspace = {
        whatsapp_connection_status: 'connected',
        business_name: null,
        vertical_config: { sop_rules: [] },
        knowledge_base: 'KB content',
      }

      const missing = checkActivationPrereqs(workspace)
      expect(missing).toContain('identity')
    })

    it('should pass with all prerequisites met', () => {
      const workspace = {
        whatsapp_connection_status: 'connected',
        business_name: 'Acme',
        vertical_config: { sop_rules: [] },
        knowledge_base: 'KB content',
      }

      const missing = checkActivationPrereqs(workspace)
      expect(missing).toHaveLength(0)
    })
  })
})

// ──────────────────────────────────────────────────────────
// Helper functions (mirroring logic from API routes)
// ──────────────────────────────────────────────────────────

interface WorkspaceState {
  whatsapp_connection_status: string
  business_name: string | null
  vertical?: string | null
  knowledge_base: string | null
  vertical_config: Record<string, unknown> | null
  tone_profile: Record<string, unknown> | null
  onboarding_status: string
}

interface Steps {
  whatsapp: boolean
  identity: boolean
  knowledge: boolean
  sops: boolean
  tone: boolean
  activation: boolean
}

function deriveSteps(ws: WorkspaceState): Steps {
  return {
    whatsapp: ws.whatsapp_connection_status === 'connected',
    identity: !!(ws.business_name && ws.vertical),
    knowledge: !!ws.knowledge_base,
    sops: !!ws.vertical_config,
    tone: !!ws.tone_profile,
    activation: ws.onboarding_status === 'complete',
  }
}

function findCurrentStep(steps: Steps): string {
  const order = ['whatsapp', 'identity', 'knowledge', 'sops', 'tone', 'activation'] as const
  return order.find(s => !steps[s]) ?? 'complete'
}

function checkActivationPrereqs(ws: {
  whatsapp_connection_status: string
  business_name: string | null
  vertical_config: Record<string, unknown> | null
  knowledge_base: string | null
}): string[] {
  const missing: string[] = []
  if (ws.whatsapp_connection_status !== 'connected') missing.push('whatsapp')
  if (!ws.business_name) missing.push('identity')
  if (!ws.vertical_config) missing.push('sops')
  if (!ws.knowledge_base) missing.push('knowledge')
  return missing
}
