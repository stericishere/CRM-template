// supabase/functions/_shared/whisper-client.ts
// OpenAI Whisper API client for voice transcription
//
// Flow:
//   audioUrl → download bytes → POST to Whisper API → { text, duration, language }
//
// Uses OPENAI_API_KEY preferentially; falls back to OPENROUTER_API_KEY.
// On any failure, returns empty text so the pipeline degrades gracefully
// (the original audio URL is always preserved on the message row).

export interface TranscriptionResult {
  text: string
  duration_seconds: number
  language: string
}

const WHISPER_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const WHISPER_MODEL = 'whisper-1'

// Max file size the Whisper API accepts (25 MB)
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/**
 * Transcribe audio from a URL using OpenAI Whisper API.
 *
 * 1. Downloads the audio file from `audioUrl`
 * 2. Sends the binary to Whisper via multipart/form-data
 * 3. Returns { text, duration_seconds, language }
 * 4. On failure returns empty text — caller should mark transcription_status = 'failed'
 */
export async function transcribeAudio(audioUrl: string): Promise<TranscriptionResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY') ?? Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    console.error('[whisper] No OPENAI_API_KEY or OPENROUTER_API_KEY found')
    return { text: '', duration_seconds: 0, language: '' }
  }

  try {
    // -----------------------------------------------------------------------
    // 1. Download audio from URL
    // -----------------------------------------------------------------------
    const downloadRes = await fetch(audioUrl)
    if (!downloadRes.ok) {
      console.error('[whisper] Failed to download audio:', downloadRes.status, downloadRes.statusText)
      return { text: '', duration_seconds: 0, language: '' }
    }

    const audioBytes = await downloadRes.arrayBuffer()

    if (audioBytes.byteLength > MAX_AUDIO_BYTES) {
      console.warn('[whisper] Audio too large for Whisper API:', audioBytes.byteLength, 'bytes')
      return { text: '', duration_seconds: 0, language: '' }
    }

    if (audioBytes.byteLength === 0) {
      console.warn('[whisper] Downloaded audio is empty')
      return { text: '', duration_seconds: 0, language: '' }
    }

    // -----------------------------------------------------------------------
    // 2. Build multipart form
    // -----------------------------------------------------------------------
    const contentType = downloadRes.headers.get('content-type') ?? 'audio/ogg'
    const extension = extensionFromMime(contentType)

    const formData = new FormData()
    formData.append('file', new Blob([audioBytes], { type: contentType }), `audio.${extension}`)
    formData.append('model', WHISPER_MODEL)
    formData.append('response_format', 'verbose_json')

    // -----------------------------------------------------------------------
    // 3. Call Whisper API
    // -----------------------------------------------------------------------
    const whisperRes = await fetch(WHISPER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    })

    if (!whisperRes.ok) {
      const errorBody = await whisperRes.text()
      console.error('[whisper] API error:', whisperRes.status, errorBody)
      return { text: '', duration_seconds: 0, language: '' }
    }

    const result = await whisperRes.json() as {
      text?: string
      duration?: number
      language?: string
    }

    return {
      text: result.text ?? '',
      duration_seconds: result.duration ?? 0,
      language: result.language ?? '',
    }
  } catch (err) {
    console.error('[whisper] Transcription failed:', err)
    return { text: '', duration_seconds: 0, language: '' }
  }
}

/** Map common audio MIME types to file extensions for the Whisper API */
function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/amr': 'amr',
    'audio/aac': 'aac',
    'audio/opus': 'opus',
    // WhatsApp sends voice notes as audio/ogg; codecs=opus
    'audio/ogg; codecs=opus': 'ogg',
  }

  // Try exact match first, then prefix match
  if (map[mime]) return map[mime]

  for (const [prefix, ext] of Object.entries(map)) {
    if (mime.startsWith(prefix.split(';')[0])) return ext
  }

  return 'ogg' // safe default for WhatsApp voice notes
}
