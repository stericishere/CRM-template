// supabase/functions/_shared/media-processor.ts
// Sprint 3 — F-08: Media processing pipeline
//
// Strategy by media_type:
//
//  ┌────────────────┐
//  │ media_type?    │
//  └──────┬─────────┘
//         │
//    ┌────┴────┬──────────┬──────────┬──────────┐
//    v         v          v          v          v
//  audio    image     document   video    sticker/
//  voice                                 reaction
//    │         │          │          │          │
//    v         v          v          v          v
//  Whisper   store      store     store    extract
//  transcr.  URL        URL       URL     metadata
//    │         │          │          │          │
//    └─────────┴──────────┴──────────┴──────────┘
//                         │
//                         v
//                 MediaProcessingResult

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { transcribeAudio } from './whisper-client.ts'

export interface MediaProcessingResult {
  transcription: string | null
  media_metadata: Record<string, unknown> | null
  transcription_status: 'completed' | 'failed' | 'skipped'
}

// Media types that trigger Whisper transcription
const TRANSCRIBABLE_TYPES = new Set(['audio', 'voice'])

/**
 * Process media attached to a message.
 *
 * @param supabase   - Supabase client (for future storage operations)
 * @param messageId  - The message row ID (for logging)
 * @param mediaType  - One of: audio, voice, image, document, video, sticker, reaction
 * @param mediaUrl   - Download URL for the media (null if metadata-only, e.g. reactions)
 * @returns MediaProcessingResult with transcription (if audio/voice) and metadata
 */
export async function processMedia(
  supabase: SupabaseClient,
  messageId: string,
  mediaType: string,
  mediaUrl: string | null
): Promise<MediaProcessingResult> {
  // No URL → nothing to process (reactions, stickers without download URL)
  if (!mediaUrl) {
    console.log('[media] No media_url, skipping processing:', { messageId, mediaType })
    return {
      transcription: null,
      media_metadata: mediaType ? { type: mediaType } : null,
      transcription_status: 'skipped',
    }
  }

  // -------------------------------------------------------------------------
  // Audio / Voice → Whisper transcription
  // -------------------------------------------------------------------------
  if (TRANSCRIBABLE_TYPES.has(mediaType)) {
    console.log('[media] Transcribing audio:', { messageId, mediaType, mediaUrl })

    try {
      const result = await transcribeAudio(mediaUrl)

      if (!result.text) {
        console.warn('[media] Whisper returned empty text:', { messageId })
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

      console.log('[media] Transcription completed:', {
        messageId,
        textLength: result.text.length,
        duration: result.duration_seconds,
        language: result.language,
      })

      const MAX_TRANSCRIPTION_CHARS = 8000
      const safeText = result.text.slice(0, MAX_TRANSCRIPTION_CHARS)
      if (result.text.length > MAX_TRANSCRIPTION_CHARS) {
        console.warn('[media] Transcription truncated:', {
          messageId,
          originalLength: result.text.length,
          truncatedTo: MAX_TRANSCRIPTION_CHARS,
        })
      }

      return {
        transcription: safeText,
        media_metadata: {
          type: mediaType,
          duration_seconds: result.duration_seconds,
          language: result.language,
        },
        transcription_status: 'completed',
      }
    } catch (err) {
      console.error('[media] Transcription error:', { messageId, error: String(err) })
      return {
        transcription: null,
        media_metadata: { type: mediaType, error: String(err) },
        transcription_status: 'failed',
      }
    }
  }

  // -------------------------------------------------------------------------
  // Image → store URL, vision handled at LLM call time
  // -------------------------------------------------------------------------
  if (mediaType === 'image') {
    console.log('[media] Image media stored (vision at LLM time):', { messageId })
    return {
      transcription: null,
      media_metadata: { type: 'image', url: mediaUrl },
      transcription_status: 'skipped',
    }
  }

  // -------------------------------------------------------------------------
  // Document → store URL
  // -------------------------------------------------------------------------
  if (mediaType === 'document') {
    console.log('[media] Document media stored:', { messageId })
    return {
      transcription: null,
      media_metadata: { type: 'document', url: mediaUrl },
      transcription_status: 'skipped',
    }
  }

  // -------------------------------------------------------------------------
  // Video → store URL
  // -------------------------------------------------------------------------
  if (mediaType === 'video') {
    console.log('[media] Video media stored:', { messageId })
    return {
      transcription: null,
      media_metadata: { type: 'video', url: mediaUrl },
      transcription_status: 'skipped',
    }
  }

  // -------------------------------------------------------------------------
  // Sticker / Reaction / Unknown → metadata only
  // -------------------------------------------------------------------------
  console.log('[media] Metadata-only media type:', { messageId, mediaType })
  return {
    transcription: null,
    media_metadata: { type: mediaType, url: mediaUrl },
    transcription_status: 'skipped',
  }
}
