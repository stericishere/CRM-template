# Feature Spec -- F-08: Media Processing

**Feature:** F-08 Media Processing
**Phase:** 2 (AI Drafting & Booking)
**Size:** M (3-5 days)
**Status:** Implementable spec
**PRD Functions:** MP-04, MP-05
**User Stories:** F08-S01 through F08-S06
**Base Architecture:** `architecture-final.md` (Edge Functions, Supabase Storage, flat codebase)
**Dependencies:** F-02 (message pipeline operational), F-05 (Client Worker for image + acknowledged media)

---

## 0. Overview

Media processing is a pre-processing step inside the `process-message` Edge Function, not a separate worker or Edge Function. It runs after the message is dequeued from pgmq and before context assembly begins.

Three tiers of media are handled differently:

| Tier | Media types | Processing | LLM involvement |
|------|-------------|------------|-----------------|
| **AI-processed** | Voice notes, images | Voice: Whisper transcription before context assembly. Image: stored, passed as vision attachment to multimodal LLM. | Yes |
| **Staff-visible** | PDFs, videos, documents | Stored in Supabase Storage. Displayed in staff app. | No (AI may acknowledge receipt of a file, but never reads content) |
| **Acknowledged** | Location pins, contacts, stickers | Metadata stored on Message record. | AI generates brief acknowledgment from metadata |

All media files (except acknowledged-tier) are stored at workspace-scoped paths in Supabase Storage: `workspaces/{workspace_id}/media/{message_id}/{filename}`.

---

## 1. Component Breakdown

Files follow the flat codebase structure from `architecture-final.md` section 13.

### 1.1 Modified: `process-message` Edge Function

The media processing step is added to the existing pipeline between message dequeue (step 4) and message storage (step 6) in the architecture data flow.

```
supabase/functions/
  process-message/
    index.ts                          # Modified: add media pre-processing step after dequeue
  _shared/
    media-processor.ts                # NEW: media type detection, routing, storage upload
    media-transcriber.ts              # NEW: Whisper API call for voice notes
    media-storage.ts                  # NEW: Supabase Storage upload with workspace-scoped paths
    types.ts                          # Modified: add MediaProcessingResult type
```

### 1.2 Pipeline Position

```
pgmq.read('inbound_messages')
    |
    v
Parse payload: extract text, media refs, sender phone
    |
    v
Client find-or-create
    |
    v
>>> MEDIA PRE-PROCESSING (F-08) <<<           <-- NEW STEP
    |  - Detect media type from Baileys message
    |  - Route to appropriate handler (voice/image/document/acknowledged)
    |  - Voice: upload to Storage -> Whisper API -> store transcription
    |  - Image: upload to Storage -> set media_url (vision attachment deferred to LLM call)
    |  - Document/video: upload to Storage -> set media_url
    |  - Acknowledged: extract metadata -> store on Message record
    |  - On transcription failure: set transcription_failed flag, continue
    v
Store raw inbound message in messages table (triggers Realtime)
    |
    v
Context assembly (voice transcription available in recentMessages)
    |
    v
Client Worker invocation (images attached as vision inputs)
```

### 1.3 New: Next.js UI Components

```
src/
  components/
    thread/
      media-attachment.tsx              # NEW: renders media by type (audio player, image, doc link)
      voice-note-player.tsx             # NEW: audio playback + transcription display
      transcription-failed-badge.tsx    # NEW: "Transcription unavailable" indicator
```

### 1.4 Modified Files

| File | Modification |
|------|-------------|
| `supabase/functions/process-message/index.ts` | Add media pre-processing step between dequeue and message storage |
| `supabase/functions/_shared/types.ts` | Add `MediaProcessingResult`, `MediaTier` types |
| `src/components/thread/message-bubble.tsx` | Render media attachments using media-attachment component |

---

## 2. Data Model

All columns use the existing `messages` table from `architecture-final.md` section 9.1. No new tables are needed.

### 2.1 Existing: `messages` Table (Already Defined)

The architecture already defines these media columns:

```sql
-- Already exists in architecture-final.md schema:
CREATE TABLE messages (
  -- ... other columns ...
  media_type TEXT,                -- 'image', 'voice_note', 'document', 'video', 'location', 'contact', 'sticker'
  media_url TEXT,                 -- Supabase Storage path (e.g., 'workspaces/ws-abc/media/msg-001/voice.ogg')
  media_transcription TEXT,       -- voice note transcription text (NULL if not voice, or transcription failed)
  -- ... other columns ...
);
```

### 2.2 New Column: `transcription_status`

Add a column to track transcription state for voice notes:

```sql
-- Migration: add transcription status tracking
ALTER TABLE messages ADD COLUMN transcription_status TEXT
  CHECK (transcription_status IN ('pending', 'completed', 'failed'));

-- NULL for non-voice messages. Set during media pre-processing.
```

### 2.3 New Column: `media_metadata`

Store structured metadata for acknowledged-tier media (location coordinates, contact info, sticker identifiers):

```sql
-- Migration: add media metadata for acknowledged-tier media
ALTER TABLE messages ADD COLUMN media_metadata JSONB;

-- Examples:
-- Location: { "latitude": -33.8688, "longitude": 151.2093, "label": "Sydney Opera House" }
-- Contact: { "name": "Jane Doe", "phones": ["+61400000000"] }
-- Sticker: { "packId": "abc123", "emoji": "thumbsup" }
```

### 2.4 Full Migration

```sql
-- Migration: 00X_media_processing.sql
-- Purpose: Media processing support for F-08

-- 1. Add transcription status column
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription_status TEXT
  CHECK (transcription_status IN ('pending', 'completed', 'failed'));

-- 2. Add media metadata column for acknowledged-tier media
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_metadata JSONB;

-- 3. Index for finding failed transcriptions (retry queries)
CREATE INDEX idx_messages_transcription_failed
  ON messages(workspace_id, created_at DESC)
  WHERE transcription_status = 'failed';

-- 4. Create Supabase Storage bucket (done via Supabase dashboard or API)
-- Bucket: 'media'
-- Public: false (signed URLs required)
-- File size limit: 50MB
-- Allowed MIME types: audio/*, image/*, video/*, application/pdf, text/*
```

### 2.5 Supabase Storage Structure

```
media/                              # Bucket name
  workspaces/
    {workspace_id}/
      media/
        {message_id}/
          voice-001.ogg             # Voice note audio
          image-001.jpg             # Image file
          document-001.pdf          # Staff-visible document
```

Storage bucket RLS policy (applied via Supabase dashboard):

```sql
-- Staff can read files in their workspace
CREATE POLICY "workspace_media_read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'media'
    AND (storage.foldername(name))[2] = auth.workspace_id()::text
  );

-- Service role writes (Edge Functions upload media)
-- No INSERT policy for authenticated users -- only service role uploads.
```

---

## 3. Media Type Detection and Routing

### 3.1 Type Detection (`media-processor.ts`)

Baileys provides media type information in the message object. The processor maps Baileys message types to our three tiers:

```typescript
type MediaTier = 'ai_processed' | 'staff_visible' | 'acknowledged';

type MediaType = 'voice_note' | 'image' | 'document' | 'video' | 'location' | 'contact' | 'sticker';

type MediaProcessingResult = {
  mediaType: MediaType;
  mediaTier: MediaTier;
  mediaUrl: string | null;          // Supabase Storage path (null for acknowledged tier)
  mediaTranscription: string | null; // Voice note transcription text
  transcriptionStatus: 'completed' | 'failed' | null;
  mediaMetadata: Record<string, unknown> | null; // Acknowledged-tier metadata
};

const MEDIA_TIER_MAP: Record<string, { type: MediaType; tier: MediaTier }> = {
  audioMessage:          { type: 'voice_note', tier: 'ai_processed' },
  imageMessage:          { type: 'image',      tier: 'ai_processed' },
  documentMessage:       { type: 'document',   tier: 'staff_visible' },
  videoMessage:          { type: 'video',      tier: 'staff_visible' },
  locationMessage:       { type: 'location',   tier: 'acknowledged' },
  contactMessage:        { type: 'contact',    tier: 'acknowledged' },
  contactsArrayMessage:  { type: 'contact',    tier: 'acknowledged' },
  stickerMessage:        { type: 'sticker',    tier: 'acknowledged' },
};
```

### 3.2 Processing Router

```typescript
async function processMedia(
  workspaceId: string,
  messageId: string,
  baileysMessage: BaileysMessage,
  supabase: SupabaseClient
): Promise<MediaProcessingResult | null> {
  const messageType = detectBaileysMediaType(baileysMessage);
  if (!messageType) return null; // Plain text message, no media

  const { type, tier } = MEDIA_TIER_MAP[messageType];

  switch (tier) {
    case 'ai_processed':
      return processAIMedia(workspaceId, messageId, type, baileysMessage, supabase);
    case 'staff_visible':
      return processStaffVisibleMedia(workspaceId, messageId, type, baileysMessage, supabase);
    case 'acknowledged':
      return processAcknowledgedMedia(type, baileysMessage);
  }
}
```

---

## 4. Voice Note Transcription

### 4.1 Flow

```
Voice note received from Baileys
    |
    v
Download audio buffer via Baileys downloadMediaMessage()
    |
    v
Upload to Supabase Storage: workspaces/{ws}/media/{msg}/voice.ogg
    |
    v
Call Whisper API with audio buffer
    |  (timeout: 30s, max file size: 25MB per Whisper limit)
    |
    +-- SUCCESS: store transcription text in media_transcription
    |             set transcription_status = 'completed'
    |
    +-- FAILURE: set media_transcription = null
                 set transcription_status = 'failed'
                 log error, continue pipeline
```

### 4.2 Whisper Integration (`media-transcriber.ts`)

```typescript
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

const TRANSCRIPTION_TIMEOUT_MS = 30_000;
const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024; // 25MB Whisper limit

async function transcribeVoiceNote(
  audioBuffer: Uint8Array,
  filename: string
): Promise<{ text: string } | { error: string }> {
  if (audioBuffer.byteLength > MAX_AUDIO_SIZE_BYTES) {
    return { error: `Audio file too large: ${audioBuffer.byteLength} bytes (max ${MAX_AUDIO_SIZE_BYTES})` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);

  try {
    const file = new File([audioBuffer], filename, { type: "audio/ogg" });
    const response = await openai.audio.transcriptions.create(
      {
        model: "whisper-1",
        file,
        response_format: "text",
      },
      { signal: controller.signal }
    );

    return { text: response };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unknown transcription error" };
  } finally {
    clearTimeout(timeout);
  }
}
```

### 4.3 LLM Usage Logging for Transcription

Every Whisper call is logged to `llm_usage`:

```typescript
await supabase.from("llm_usage").insert({
  workspace_id: workspaceId,
  client_id: clientId,
  edge_function_name: "process-message",
  model: "whisper-1",
  tokens_in: 0,             // Whisper uses duration, not tokens
  tokens_out: 0,
  latency_ms: transcriptionLatencyMs,
  cost_usd: calculateWhisperCost(audioDurationSeconds), // $0.006/min
});
```

### 4.4 Transcription in Context Assembly

Voice note transcriptions appear in `recentMessages` as regular text content. The `assembleContext` function already reads `messages.media_transcription` and falls back to `messages.content`:

```typescript
// In context assembly (recentMessages construction):
const messageContent = message.media_transcription ?? message.content;

// For voice notes with failed transcription:
// media_transcription is NULL, content may contain caption text
// The inboundMessage section flags it:
const inboundMessage = {
  content: message.content ?? "",
  mediaType: message.media_type,                    // "voice_note"
  mediaTranscription: message.media_transcription,  // null if failed
  timestamp: message.created_at,
};
// The Client Worker system prompt instructs the LLM:
// "If mediaType is 'voice_note' and mediaTranscription is null,
//  acknowledge the voice note and ask the client to resend as text."
```

---

## 5. Image Handling

### 5.1 Flow

```
Image received from Baileys
    |
    v
Download image buffer via Baileys downloadMediaMessage()
    |
    v
Upload to Supabase Storage: workspaces/{ws}/media/{msg}/image.jpg
    |
    v
Set media_url on Message record
    |
    v
(Context assembly: message appears in recentMessages with media_url reference)
    |
    v
Client Worker invocation: image attached as vision input
```

### 5.2 Vision Attachment at LLM Call Time

Images are NOT injected into `recentMessages` as text. They are attached to the LLM API call as vision inputs at invocation time. This happens in the Client Worker runtime (F-05), not in context assembly.

```typescript
// In Client Worker LLM invocation:
const visionImages: ImageAttachment[] = [];

for (const msg of recentMessages) {
  if (msg.mediaType === "image" && msg.mediaUrl) {
    // Generate a signed URL for the image
    const { data } = await supabase.storage
      .from("media")
      .createSignedUrl(msg.mediaUrl, 300); // 5-minute expiry

    if (data?.signedUrl) {
      visionImages.push({
        type: "image_url",
        image_url: { url: data.signedUrl },
      });
    }
  }
}

// Attach to LLM call (most recent images first, cap at token budget)
const MAX_VISION_IMAGES = 3;
const attachedImages = visionImages.slice(-MAX_VISION_IMAGES);
```

### 5.3 Token Budget for Images

Per architecture section 6.2, the total token budget is ~12,000 tokens. Vision inputs consume tokens based on image resolution. Budget allocation:

| Image count | Approximate token cost | Strategy |
|-------------|----------------------|----------|
| 1 image | ~800-1,500 tokens (auto detail) | Always attach |
| 2-3 images | ~2,400-4,500 tokens | Attach if budget allows |
| 4+ images | Exceeds budget | Attach only the 3 most recent |

The `MAX_VISION_IMAGES = 3` cap ensures the vision budget stays within ~4,500 tokens, leaving room for the rest of the context window.

---

## 6. Staff-Visible Media (Documents, Videos)

### 6.1 Processing

Documents and videos are stored but never sent to the LLM. The processing is straightforward:

```typescript
async function processStaffVisibleMedia(
  workspaceId: string,
  messageId: string,
  type: MediaType,
  baileysMessage: BaileysMessage,
  supabase: SupabaseClient
): Promise<MediaProcessingResult> {
  const buffer = await downloadMediaMessage(baileysMessage, "buffer", {});
  const filename = extractFilename(baileysMessage) ?? `${type}-${messageId}`;
  const storagePath = `workspaces/${workspaceId}/media/${messageId}/${filename}`;

  await supabase.storage.from("media").upload(storagePath, buffer, {
    contentType: detectMimeType(baileysMessage),
    upsert: false,
  });

  return {
    mediaType: type,
    mediaTier: "staff_visible",
    mediaUrl: storagePath,
    mediaTranscription: null,
    transcriptionStatus: null,
    mediaMetadata: null,
  };
}
```

### 6.2 Staff App Display

The `message-bubble.tsx` component renders staff-visible media with a download link:

- **Documents:** File icon + filename + download button.
- **Videos:** Video player (native `<video>` element) or download link for large files.

The AI draft may acknowledge that a file was received (it can see `media_type: "document"` in `recentMessages`) but never claims to have read the contents.

---

## 7. Acknowledged Media (Location, Contacts, Stickers)

### 7.1 Processing

Acknowledged media does not require file upload. Metadata is extracted from the Baileys message and stored on the Message record:

```typescript
async function processAcknowledgedMedia(
  type: MediaType,
  baileysMessage: BaileysMessage
): Promise<MediaProcessingResult> {
  let metadata: Record<string, unknown> = {};

  switch (type) {
    case "location": {
      const loc = baileysMessage.message?.locationMessage;
      metadata = {
        latitude: loc?.degreesLatitude,
        longitude: loc?.degreesLongitude,
        label: loc?.name ?? loc?.address ?? null,
      };
      break;
    }
    case "contact": {
      const contacts =
        baileysMessage.message?.contactMessage
          ? [baileysMessage.message.contactMessage]
          : baileysMessage.message?.contactsArrayMessage?.contacts ?? [];
      metadata = {
        contacts: contacts.map((c) => ({
          name: c.displayName,
          phones: c.vcard ? extractPhonesFromVCard(c.vcard) : [],
        })),
      };
      break;
    }
    case "sticker": {
      const sticker = baileysMessage.message?.stickerMessage;
      metadata = {
        isAnimated: sticker?.isAnimated ?? false,
      };
      break;
    }
  }

  return {
    mediaType: type,
    mediaTier: "acknowledged",
    mediaUrl: null,
    mediaTranscription: null,
    transcriptionStatus: null,
    mediaMetadata: metadata,
  };
}
```

### 7.2 AI Acknowledgment

Acknowledged media appears in `recentMessages` with its `media_type` set. The Client Worker system prompt includes:

```
If the client sends a location, contact, or sticker:
- Acknowledge receipt naturally (e.g., "Thanks for sharing your location")
- Do not fabricate details not present in the metadata
- Do not attempt to act on location data (no booking, no CRM update) without staff review
```

---

## 8. Edge Cases

### 8.1 Large File Handling

| Constraint | Limit | Behavior |
|------------|-------|----------|
| Whisper API max audio | 25 MB | Reject transcription, set `transcription_status = 'failed'`, store audio file, continue pipeline |
| Supabase Storage upload | 50 MB (bucket limit) | Reject upload, log error, store message without media_url, continue pipeline |
| Edge Function timeout | 150s (Pro tier) | File upload + Whisper call must complete within the function timeout. If timeout approaches, the pgmq visibility timeout (60s) ensures retry. |

For large files that risk timeout:

```typescript
// Check file size before processing
const MAX_PROCESSABLE_SIZE = 20 * 1024 * 1024; // 20MB soft limit for Edge Function

if (buffer.byteLength > MAX_PROCESSABLE_SIZE) {
  // Store the file but skip transcription to avoid timeout
  // Upload happens, transcription is skipped with status 'failed'
  // Reason logged: 'file_too_large_for_edge_function'
}
```

### 8.2 Transcription Failure Handling

Transcription failures must never halt the pipeline. The fallback chain:

1. **Whisper API error** -> Set `transcription_status = 'failed'`, continue pipeline.
2. **Whisper API timeout (30s)** -> Treat as error, same fallback.
3. **Audio file too large** -> Skip transcription, set `transcription_status = 'failed'`.
4. **Audio file download failure from Baileys** -> Store message without media_url, log error.

In all cases:
- The message is always stored in the `messages` table.
- Context assembly proceeds.
- The Client Worker generates a draft that acknowledges the voice note but asks the client to resend as text.
- Staff can manually listen to the audio via `media_url` in the staff app.

### 8.3 Retry for Failed Transcriptions

A lightweight retry mechanism re-processes failed transcriptions. This can run as part of the `daily-cron` Edge Function or as a separate scheduled task:

```typescript
// Find messages with failed transcriptions from the last 24 hours
const { data: failedMessages } = await supabase
  .from("messages")
  .select("id, workspace_id, media_url")
  .eq("transcription_status", "failed")
  .eq("media_type", "voice_note")
  .gte("created_at", twentyFourHoursAgo)
  .limit(10);

for (const msg of failedMessages ?? []) {
  // Re-download audio from Storage
  // Re-submit to Whisper
  // On success: UPDATE media_transcription, set transcription_status = 'completed'
  // On failure: leave as 'failed', try again next cycle
}
```

### 8.4 Message with Both Media and Text Caption

Baileys messages can include both media and a text caption. Both are stored:

- `content`: the text caption (e.g., "this is the colour I want")
- `media_url`: the media file storage path
- `media_transcription`: voice note transcription (voice notes only)

Context assembly includes both: the caption appears as message text in `recentMessages`, and the transcription (if voice note) or vision attachment (if image) supplements it.

### 8.5 Concurrent Media Messages

Multiple media messages from the same client are serialized by the pgmq advisory lock (per-client ordering from architecture section 8.1). Each message is processed sequentially, so Storage uploads do not conflict.

---

## 9. AC-to-Task Mapping

### Task 1: Media Storage Foundation (F08-S05)

**Files:** `supabase/functions/_shared/media-storage.ts`, migration SQL

| # | Task | AC Reference |
|---|------|-------------|
| 1.1 | Create Supabase Storage bucket `media` with 50MB limit, private access | F08-S05: uploaded file path follows workspace-scoped convention |
| 1.2 | Implement `uploadMediaToStorage(workspaceId, messageId, filename, buffer)` returning storage path | F08-S05: file stored at `workspaces/{ws}/media/{msg}/{filename}` |
| 1.3 | Implement Storage RLS policy: workspace-scoped read for authenticated staff | F08-S05: files from different workspaces are path-isolated |
| 1.4 | Implement signed URL generation for staff app media retrieval | F08-S05: staff retrieves a media file via URL |
| 1.5 | Write migration adding `transcription_status` and `media_metadata` columns | F08-S05: all scenarios |
| 1.6 | Add index on `transcription_status = 'failed'` for retry queries | F08-S06: retry mechanism |

### Task 2: Media Type Detection and Routing (Cross-cutting)

**Files:** `supabase/functions/_shared/media-processor.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 2.1 | Implement `detectBaileysMediaType()` mapping Baileys message types to `MediaType` | All stories: correct media_type on Message record |
| 2.2 | Implement `processMedia()` router dispatching to tier-specific handlers | All stories: routing by media tier |
| 2.3 | Integrate `processMedia()` into `process-message` pipeline between dequeue and message storage | F08-S01: transcription completes before context assembly |

### Task 3: Voice Note Transcription (F08-S01, F08-S06)

**Files:** `supabase/functions/_shared/media-transcriber.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 3.1 | Implement Whisper API call with 30s timeout | F08-S01: audio submitted to transcription service |
| 3.2 | Download audio from Baileys, upload to Storage, then transcribe | F08-S01: audio file uploaded to Storage, media_url populated |
| 3.3 | Store transcription text in `media_transcription`, set `transcription_status = 'completed'` | F08-S01: transcript stored in Message.media_transcription |
| 3.4 | Handle transcription failure: set `transcription_status = 'failed'`, continue pipeline | F08-S06: pipeline continues, audio retained |
| 3.5 | Handle transcription timeout: abort after 30s, treat as failure | F08-S06: transcription service timeout |
| 3.6 | Handle large audio (>25MB): skip transcription, set failed status | Edge case: large files |
| 3.7 | Log Whisper call to `llm_usage` table | Architecture: LLM usage logging |
| 3.8 | Handle voice note with text caption: store caption in `content`, transcription in `media_transcription` | F08-S01: voice note with text caption |

### Task 4: Image Processing (F08-S02)

**Files:** `supabase/functions/_shared/media-processor.ts`, Client Worker modification (F-05)

| # | Task | AC Reference |
|---|------|-------------|
| 4.1 | Download image from Baileys, upload to Storage, set `media_url` | F08-S02: image stored and media_url populated |
| 4.2 | Handle image with text caption: store caption in `content` | F08-S02: message with both image and text caption |
| 4.3 | In Client Worker: collect image URLs from `recentMessages`, generate signed URLs, attach as vision inputs (max 3) | F08-S02: image attached to LLM call as vision input |
| 4.4 | Verify LLM draft references image content when vision input provided | F08-S02: draft reflects image content |

### Task 5: Staff-Visible Media (F08-S03)

**Files:** `supabase/functions/_shared/media-processor.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 5.1 | Download document/video from Baileys, upload to Storage, set `media_url` and `media_type` | F08-S03: file uploaded, media_url populated |
| 5.2 | Store document filename in `content` if no caption text | F08-S03: Message.content stores document filename |
| 5.3 | Verify no LLM processing is triggered for documents/videos | F08-S03: no LLM processing triggered |

### Task 6: Acknowledged Media (F08-S04)

**Files:** `supabase/functions/_shared/media-processor.ts`

| # | Task | AC Reference |
|---|------|-------------|
| 6.1 | Extract location metadata (lat, lng, label) and store in `media_metadata` | F08-S04: location metadata stored |
| 6.2 | Extract contact metadata (name, phones from vCard) and store in `media_metadata` | F08-S04: contact metadata stored |
| 6.3 | Extract sticker metadata and store in `media_metadata` | F08-S04: sticker metadata stored |
| 6.4 | Verify no file upload triggered for acknowledged media | F08-S04: no file upload triggered |
| 6.5 | Verify Client Worker generates natural acknowledgment for each acknowledged type | F08-S04: AI draft acknowledges received media |

### Task 7: Staff App Media Display (F08-S03, F08-S05, F08-S06)

**Files:** `src/components/thread/media-attachment.tsx`, `voice-note-player.tsx`, `transcription-failed-badge.tsx`

| # | Task | AC Reference |
|---|------|-------------|
| 7.1 | Render audio player for voice notes with transcription text below | F08-S06: audio playback control + transcription display |
| 7.2 | Show "Transcription unavailable" badge when `transcription_status = 'failed'` | F08-S06: staff app shows unprocessed voice note |
| 7.3 | Render document/PDF attachment with filename and download link | F08-S03: document attachment indicator with filename |
| 7.4 | Render video with player or download link | F08-S03: video player or download link |
| 7.5 | Render images inline in conversation thread | F08-S02: image visible in conversation |

### Task 8: Transcription Retry (F08-S06)

**Files:** `supabase/functions/daily-cron/index.ts` (or new retry logic)

| # | Task | AC Reference |
|---|------|-------------|
| 8.1 | Query messages with `transcription_status = 'failed'` from last 24 hours | F08-S06: retry mechanism for failed transcriptions |
| 8.2 | Re-download audio from Storage, re-submit to Whisper | F08-S06: re-submits audio to transcription service |
| 8.3 | On success: update `media_transcription`, set `transcription_status = 'completed'` | F08-S06: successful retries populate media_transcription |
| 8.4 | Verify no duplicate Message records created on retry | F08-S06: no duplicate records |

---

## 10. Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Voice note transcription latency | < 15s for notes under 2 minutes | Whisper processes ~1 min audio in ~3-5s; total includes download + upload + API call |
| Media upload throughput | No queue starvation during large uploads | Advisory lock ensures per-client serialization; other clients' messages process independently |
| Storage cost | < $1/month at MVP scale | Supabase Storage free tier: 1GB. At ~100 media messages/day, ~5MB avg = ~500MB/month |
| Transcription cost | ~$0.006/min of audio | Whisper pricing. Average voice note ~30s = ~$0.003 per transcription |

---

## 11. Out of Scope

- **OCR for image-based PDFs** -- future phase. PDFs are staff-visible only.
- **Video transcription** -- videos are stored, not processed.
- **Image OCR as text fallback** -- images go directly to multimodal LLM vision, no OCR pre-processing.
- **Media forwarding** -- staff cannot forward media to other clients.
- **Media compression/resizing** -- files stored as-is from Baileys.
