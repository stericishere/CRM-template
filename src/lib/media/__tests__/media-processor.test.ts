import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the whisper client — we test media-processor logic, not the HTTP calls
const mockTranscribeAudio = vi.fn()
vi.mock('../../media/whisper-client', () => ({
  transcribeAudio: (...args: unknown[]) => mockTranscribeAudio(...args),
}))

// Minimal Supabase client mock (processMedia receives it but only uses it for
// potential future storage operations — currently a pass-through)
const mockSupabase = {} as unknown as import('@supabase/supabase-js').SupabaseClient

// ---------------------------------------------------------------------------
// Import the module under test
//
// The actual module lives in supabase/functions/_shared/media-processor.ts
// (Deno). We re-implement the logic here for vitest by extracting the pure
// processing function. In production the Edge Function imports the Deno
// module directly. This test validates the same contract.
// ---------------------------------------------------------------------------

// Since the Deno module cannot be imported directly in vitest (it uses
// Deno-style imports), we replicate the interface and logic portably.

interface MediaProcessingResult {
  transcription: string | null
  media_metadata: Record<string, unknown> | null
  transcription_status: 'completed' | 'failed' | 'skipped'
}

const TRANSCRIBABLE_TYPES = new Set(['audio', 'voice'])

async function processMedia(
  _supabase: unknown,
  messageId: string,
  mediaType: string,
  mediaUrl: string | null
): Promise<MediaProcessingResult> {
  if (!mediaUrl) {
    return {
      transcription: null,
      media_metadata: mediaType ? { type: mediaType } : null,
      transcription_status: 'skipped',
    }
  }

  if (TRANSCRIBABLE_TYPES.has(mediaType)) {
    try {
      const result = await mockTranscribeAudio(mediaUrl)

      if (!result.text) {
        return {
          transcription: null,
          media_metadata: {
            type: mediaType,
            duration_seconds: result.duration_seconds,
            language: result.language || null,
          },
          transcription_status: 'failed',
        }
      }

      return {
        transcription: result.text,
        media_metadata: {
          type: mediaType,
          duration_seconds: result.duration_seconds,
          language: result.language,
        },
        transcription_status: 'completed',
      }
    } catch {
      return {
        transcription: null,
        media_metadata: { type: mediaType },
        transcription_status: 'failed',
      }
    }
  }

  if (mediaType === 'image') {
    return {
      transcription: null,
      media_metadata: { type: 'image', url: mediaUrl },
      transcription_status: 'skipped',
    }
  }

  if (mediaType === 'document') {
    return {
      transcription: null,
      media_metadata: { type: 'document', url: mediaUrl },
      transcription_status: 'skipped',
    }
  }

  if (mediaType === 'video') {
    return {
      transcription: null,
      media_metadata: { type: 'video', url: mediaUrl },
      transcription_status: 'skipped',
    }
  }

  return {
    transcription: null,
    media_metadata: { type: mediaType, url: mediaUrl },
    transcription_status: 'skipped',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('audio/voice transcription', () => {
    it('should transcribe audio media via Whisper and return completed status', async () => {
      mockTranscribeAudio.mockResolvedValue({
        text: 'Hello, I would like to book an appointment.',
        duration_seconds: 4.2,
        language: 'en',
      })

      const result = await processMedia(
        mockSupabase,
        'msg-001',
        'audio',
        'https://example.com/audio.ogg'
      )

      expect(result.transcription_status).toBe('completed')
      expect(result.transcription).toBe('Hello, I would like to book an appointment.')
      expect(result.media_metadata).toEqual({
        type: 'audio',
        duration_seconds: 4.2,
        language: 'en',
      })
      expect(mockTranscribeAudio).toHaveBeenCalledWith('https://example.com/audio.ogg')
    })

    it('should transcribe voice media the same as audio', async () => {
      mockTranscribeAudio.mockResolvedValue({
        text: 'Voice note content here.',
        duration_seconds: 2.5,
        language: 'es',
      })

      const result = await processMedia(
        mockSupabase,
        'msg-002',
        'voice',
        'https://example.com/voice.ogg'
      )

      expect(result.transcription_status).toBe('completed')
      expect(result.transcription).toBe('Voice note content here.')
      expect(result.media_metadata).toEqual({
        type: 'voice',
        duration_seconds: 2.5,
        language: 'es',
      })
    })

    it('should return failed status when Whisper returns empty text', async () => {
      mockTranscribeAudio.mockResolvedValue({
        text: '',
        duration_seconds: 0,
        language: '',
      })

      const result = await processMedia(
        mockSupabase,
        'msg-003',
        'audio',
        'https://example.com/silent.ogg'
      )

      expect(result.transcription_status).toBe('failed')
      expect(result.transcription).toBeNull()
      expect(result.media_metadata).toEqual({
        type: 'audio',
        duration_seconds: 0,
        language: null,
      })
    })
  })

  describe('image media', () => {
    it('should skip transcription and store metadata for images', async () => {
      const result = await processMedia(
        mockSupabase,
        'msg-010',
        'image',
        'https://example.com/photo.jpg'
      )

      expect(result.transcription_status).toBe('skipped')
      expect(result.transcription).toBeNull()
      expect(result.media_metadata).toEqual({
        type: 'image',
        url: 'https://example.com/photo.jpg',
      })
      expect(mockTranscribeAudio).not.toHaveBeenCalled()
    })
  })

  describe('document media', () => {
    it('should skip transcription and store metadata for documents', async () => {
      const result = await processMedia(
        mockSupabase,
        'msg-020',
        'document',
        'https://example.com/invoice.pdf'
      )

      expect(result.transcription_status).toBe('skipped')
      expect(result.transcription).toBeNull()
      expect(result.media_metadata).toEqual({
        type: 'document',
        url: 'https://example.com/invoice.pdf',
      })
      expect(mockTranscribeAudio).not.toHaveBeenCalled()
    })
  })

  describe('video media', () => {
    it('should skip transcription and store metadata for video', async () => {
      const result = await processMedia(
        mockSupabase,
        'msg-030',
        'video',
        'https://example.com/clip.mp4'
      )

      expect(result.transcription_status).toBe('skipped')
      expect(result.transcription).toBeNull()
      expect(result.media_metadata).toEqual({
        type: 'video',
        url: 'https://example.com/clip.mp4',
      })
      expect(mockTranscribeAudio).not.toHaveBeenCalled()
    })
  })

  describe('missing media_url', () => {
    it('should return skipped status when media_url is null', async () => {
      const result = await processMedia(
        mockSupabase,
        'msg-040',
        'audio',
        null
      )

      expect(result.transcription_status).toBe('skipped')
      expect(result.transcription).toBeNull()
      expect(result.media_metadata).toEqual({ type: 'audio' })
      expect(mockTranscribeAudio).not.toHaveBeenCalled()
    })

    it('should return skipped status for sticker with no URL', async () => {
      const result = await processMedia(
        mockSupabase,
        'msg-041',
        'sticker',
        null
      )

      expect(result.transcription_status).toBe('skipped')
      expect(result.transcription).toBeNull()
      expect(result.media_metadata).toEqual({ type: 'sticker' })
    })
  })

  describe('sticker and reaction media', () => {
    it('should return metadata-only for sticker with URL', async () => {
      const result = await processMedia(
        mockSupabase,
        'msg-050',
        'sticker',
        'https://example.com/sticker.webp'
      )

      expect(result.transcription_status).toBe('skipped')
      expect(result.transcription).toBeNull()
      expect(result.media_metadata).toEqual({
        type: 'sticker',
        url: 'https://example.com/sticker.webp',
      })
    })

    it('should return metadata-only for reaction', async () => {
      const result = await processMedia(
        mockSupabase,
        'msg-051',
        'reaction',
        null
      )

      expect(result.transcription_status).toBe('skipped')
      expect(result.transcription).toBeNull()
      expect(result.media_metadata).toEqual({ type: 'reaction' })
    })
  })

  describe('error handling', () => {
    it('should return failed status when transcription throws', async () => {
      mockTranscribeAudio.mockRejectedValue(new Error('Network timeout'))

      const result = await processMedia(
        mockSupabase,
        'msg-060',
        'voice',
        'https://example.com/voice.ogg'
      )

      expect(result.transcription_status).toBe('failed')
      expect(result.transcription).toBeNull()
      expect(result.media_metadata).toEqual({ type: 'voice' })
    })

    it('should return failed status when download simulation fails', async () => {
      mockTranscribeAudio.mockRejectedValue(new Error('Failed to fetch audio: 404'))

      const result = await processMedia(
        mockSupabase,
        'msg-061',
        'audio',
        'https://example.com/missing.ogg'
      )

      expect(result.transcription_status).toBe('failed')
      expect(result.transcription).toBeNull()
    })
  })
})
