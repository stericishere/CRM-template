# User Stories — F-08: Media Processing

**Feature:** F-08 Media Processing
**Phase:** 2 (AI Drafting & Booking)
**Size:** M
**PRD Functions:** MP-04, MP-05
**Architecture Module:** conversation (ProcessInboundMessage — media pre-processing step), integrations/llm
**ADR Dependency:** ADR-1 (image processing happens within the single Client Worker LLM call)

---

## Context

Media processing is a pre-processing step that runs inside the worker pipeline **before** context assembly. It is not a separate agent or worker. Three distinct tiers of media are handled differently by the system:

- **AI-processed:** Voice notes (transcribed via Whisper or equivalent before context assembly) and images (passed directly to the multimodal LLM within the Client Worker call). Transcriptions are stored in `Message.media_transcription`.
- **Staff-visible:** PDFs, videos, and documents. Stored in Supabase Storage and displayed in the client thread. Never sent to the LLM.
- **Acknowledged:** Location pins, contacts, and stickers. Stored as metadata in the Message record. The LLM generates a brief acknowledgment in its draft reply.

**Key architectural constraints:**
- Voice note transcription runs synchronously in the worker pipeline before `ContextAssembler` executes, so the transcribed text is available inside `recentMessages` when the Client Worker is invoked.
- Image data is not injected into `recentMessages` as text. Instead, the image is passed directly to the multimodal LLM call at invocation time as a vision attachment.
- Both voice notes and images produce an audit trail — the original `media_url` is always retained alongside the transcription or LLM processing record.
- Transcription failures must not silently drop client messages; the pipeline must fall back gracefully and still trigger staff review.
- All media storage uses the workspace-scoped path convention: `workspaces/{workspace_id}/media/{message_id}/{filename}`.

---

## Stories

### F08-S01: Voice Note Transcription Before Context Assembly

**Function:** MP-04

> **As a** staff member,
> **I want** voice notes sent by clients to be automatically transcribed before the AI drafts a response,
> **so that** the AI can read and respond to the content of a voice message just as accurately as a text message.

**Acceptance Criteria:**

```gherkin
Feature: Voice note transcription before context assembly

  Scenario: Voice note received and transcribed successfully
    Given a client sends a WhatsApp voice note to workspace "ws-abc"
    When the worker dequeues the message
    Then the media_type on the Message record is set to "voice_note"
    And the audio file is uploaded to Supabase Storage at the workspace-scoped path
    And the media_url on the Message record is populated with the storage path
    And the audio is submitted to the transcription service (Whisper or equivalent)
    And the returned transcript text is stored in Message.media_transcription
    And transcription completes before context assembly begins for this message

  Scenario: Transcribed text appears in context assembly as part of recentMessages
    Given a voice note with message_id "msg-001" has been transcribed as "I need to reschedule my fitting to next Friday"
    When the ContextAssembler builds the recentMessages slice for client "C-001"
    Then the voice note message appears in recentMessages
    And its content is represented by the transcription "I need to reschedule my fitting to next Friday"
    And the original media_url is retained on the Message record

  Scenario: Voice note content is available to Client Worker for drafting
    Given a transcribed voice note is included in recentMessages
    When the Client Worker is invoked
    Then the LLM reads the transcription as conversational text
    And the generated draft reflects the intent expressed in the voice note
    And the draft does not indicate uncertainty about the client's message content

  Scenario: Voice note with a text caption alongside audio
    Given a client sends a voice note with an accompanying text caption "quick question"
    When the worker stores the message
    Then the caption text is stored in Message.content
    And the transcription is stored in Message.media_transcription
    And both are available in context assembly
```

**Notes:**
- Transcription is synchronous within the worker pipeline and must complete before `ContextAssembler` runs (architecture §11.2).
- The Message record always retains `media_url` (original audio) alongside `media_transcription`. The audio is never discarded.
- Transcription service: Whisper (OpenAI) or a compatible self-hosted model. Provider is abstracted behind an integration interface.

---

### F08-S02: Image Processing Within Client Worker Multimodal LLM Call

**Function:** MP-05

> **As a** staff member,
> **I want** images sent by clients to be understood by the AI when it drafts a reply,
> **so that** the AI can respond meaningfully to photos (e.g., a reference image for a suit fabric, a photo of a measurement, a screenshot of a previous order).

**Acceptance Criteria:**

```gherkin
Feature: Image processing within Client Worker multimodal LLM call

  Scenario: Image message received, stored, and passed to LLM
    Given a client sends a WhatsApp image to workspace "ws-abc"
    When the worker dequeues the message
    Then the media_type on the Message record is set to "image"
    And the image file is uploaded to Supabase Storage at the workspace-scoped path
    And the media_url on the Message record is populated
    And when the Client Worker is invoked, the image is attached to the LLM call as a vision input

  Scenario: LLM draft reflects image content
    Given a client sends a photo of a fabric swatch with message text "what do you think of this for my suit?"
    And the image is passed to the multimodal LLM within the Client Worker call
    When the Client Worker generates a draft
    Then the draft references the visual content of the image
    And the draft does not treat the image as missing or unavailable

  Scenario: Image is not injected into recentMessages as text
    Given a message with media_type "image" is in the conversation history
    When the ContextAssembler builds recentMessages
    Then the message record is included in recentMessages with its media_url reference
    And no OCR text or image description is injected as a text substitute in recentMessages
    And the raw image data is attached to the LLM invocation at Client Worker call time

  Scenario: Message with both image and text caption
    Given a client sends a message with an image and caption text "this is the colour I want"
    When the worker stores and processes the message
    Then Message.content contains the caption text "this is the colour I want"
    And the image is stored at media_url
    And both the caption text (from recentMessages) and the image (as vision attachment) are available to the LLM

  Scenario: Multiple images in a single session
    Given a client sends three images in three separate messages
    When the Client Worker is invoked for the third message
    Then all three image messages are reflected in context
    And the images most relevant to the current invocation are attached as vision inputs within the token budget
```

**Notes:**
- Per ADR-1, image processing happens within the single Client Worker LLM call, not as a separate pre-processing step or separate agent invocation.
- Image storage path follows the workspace-scoped convention. The LLM receives the image at invocation time, not from context assembly.
- Token budget for image vision inputs is governed by the fixed token budget defined in the context assembly architecture (§3.2). If the token budget is exceeded, older images are deprioritized.

---

### F08-S03: Staff-Visible Media Storage and Display

**Function:** Covers the Staff-visible tier from PRD §10.2 and architecture §11.2

> **As a** staff member,
> **I want** documents, PDFs, and videos sent by clients to be stored and visible in the conversation thread,
> **so that** I can review client-submitted files in context without leaving the conversation view, even though the AI does not process them.

**Acceptance Criteria:**

```gherkin
Feature: Staff-visible media storage and display

  Scenario: Client sends a PDF document
    Given a client sends a PDF document (e.g., a reference brochure) to workspace "ws-abc"
    When the worker processes the message
    Then the media_type on the Message record is set to "document"
    And the file is uploaded to Supabase Storage at the workspace-scoped path
    And the media_url is populated on the Message record
    And the Message.content stores the document filename if available
    And no LLM processing is triggered for this document

  Scenario: Client sends a video
    Given a client sends a video message
    When the worker processes the message
    Then the media_type is set to "video"
    And the video file is uploaded to Supabase Storage
    And the media_url is populated on the Message record
    And the video is not sent to any LLM

  Scenario: Staff sees document in conversation thread
    Given a message with media_type "document" and a populated media_url exists in conversation "conv-001"
    When a staff member opens the conversation in the staff app
    Then the message appears in the conversation timeline at the correct timestamp
    And a document attachment indicator is displayed with the filename
    And staff can tap or click the attachment to open or download the file

  Scenario: Staff sees video in conversation thread
    Given a message with media_type "video" and a populated media_url exists in conversation "conv-001"
    When a staff member views the conversation
    Then the message appears in the timeline
    And a video player or download link is shown
    And the video is accessible via the media_url

  Scenario: AI draft does not reference unseen document content
    Given a client has sent a PDF document in conversation "conv-001"
    When the Client Worker generates a draft reply
    Then the draft does not claim to have read or understood the PDF contents
    And the draft may acknowledge that a document was received (if appropriate to the conversation context)
```

**Notes:**
- Staff-visible media (documents, videos) is stored but never sent to the LLM. The AI draft is generated from text context only.
- The worker pipeline stores and uploads the file, then continues context assembly without the document content.
- The AI may acknowledge that a file was received because it can see the Message record with `media_type: "document"` in `recentMessages`, but it has no visibility into file contents.

---

### F08-S04: Acknowledged Media Handling

**Function:** Covers the Acknowledged tier from PRD §10.2 and architecture §11.2

> **As a** staff member,
> **I want** location pins, contacts, and stickers sent by clients to be stored and acknowledged in the AI draft,
> **so that** clients receive a meaningful response confirming receipt rather than silence, and the metadata is available for context.

**Acceptance Criteria:**

```gherkin
Feature: Acknowledged media handling

  Scenario: Client sends a location pin
    Given a client sends a location pin message
    When the worker processes the message
    Then the media_type is set to "location"
    And the location metadata (latitude, longitude, and label if provided) is stored as structured content in the Message record
    And no file upload to Supabase Storage is triggered

  Scenario: Client sends a contact card
    Given a client sends a contact card (vCard)
    When the worker processes the message
    Then the media_type is set to "contact"
    And the contact metadata (name, phone numbers) is stored in the Message record
    And no file upload to Supabase Storage is triggered

  Scenario: Client sends a sticker
    Given a client sends a WhatsApp sticker
    When the worker processes the message
    Then the media_type is set to "sticker"
    And the sticker metadata (sticker pack ID or emoji identifier if available) is stored in the Message record

  Scenario: AI draft acknowledges received location
    Given a message with media_type "location" is in recentMessages
    When the Client Worker generates a draft
    Then the draft acknowledges that a location was received
    And the acknowledgment is natural and contextually appropriate (e.g., "Thanks for sharing your location — I'll make a note of that.")
    And the draft does not fabricate details about the location that were not in the metadata

  Scenario: AI draft acknowledges received contact or sticker
    Given a message with media_type "contact" or "sticker" is in the most recent messages
    When the Client Worker generates a draft
    Then the draft contains a brief, natural acknowledgment
    And the acknowledgment does not over-explain or describe the sticker/contact in detail

  Scenario: Acknowledged media does not block pipeline
    Given a client sends a sticker as the only message in a session
    When the worker processes the message
    Then the message is stored
    And context assembly proceeds normally
    And the Client Worker is invoked and produces an acknowledgment draft
    And staff can review and send the draft reply
```

**Notes:**
- Acknowledged media types (location, contact, sticker) are stored as metadata in the Message record rather than uploaded as files.
- These message types appear in `recentMessages` with their `media_type` set, making them visible to the Client Worker for acknowledgment generation.
- The LLM should not be expected to act on location or contact data beyond acknowledging receipt; no booking or CRM update should be auto-triggered solely from a location pin without staff review.

---

### F08-S05: Media Storage and URL Management

**Function:** Cross-cutting (supports MP-04, MP-05, and staff-visible tier)

> **As a** system operator,
> **I want** all media files uploaded to workspace-scoped paths in Supabase Storage with durable, retrievable URLs,
> **so that** media files are isolated per workspace, accessible to staff, and correctly referenced from Message records.

**Acceptance Criteria:**

```gherkin
Feature: Media storage and URL management

  Scenario: Uploaded file path follows workspace-scoped convention
    Given a message with message_id "msg-001" belonging to workspace "ws-abc"
    When a media file "voice-001.ogg" is uploaded
    Then the file is stored at path "workspaces/ws-abc/media/msg-001/voice-001.ogg"
    And the Message.media_url is set to the full storage path or a signed URL for this file

  Scenario: Files from different workspaces are path-isolated
    Given workspace "ws-abc" and workspace "ws-xyz" each receive a file named "photo.jpg"
    When both files are uploaded
    Then workspace "ws-abc"'s file is at "workspaces/ws-abc/media/{msg_id}/photo.jpg"
    And workspace "ws-xyz"'s file is at "workspaces/ws-xyz/media/{msg_id}/photo.jpg"
    And neither workspace can access the other's file path

  Scenario: Staff retrieves a media file via URL
    Given a Message record with a populated media_url exists in conversation "conv-001"
    When a staff member requests the media in the staff app
    Then the app resolves the media_url to a downloadable or streamable file
    And the file is served without authentication errors for the staff member's session

  Scenario: Media URL is stable after upload
    Given a file has been uploaded and media_url has been set on a Message record
    When the staff member views the conversation 24 hours later
    Then the media_url still resolves to the correct file
    And the file has not been purged or moved

  Scenario: Large file upload does not block queue processing
    Given a client sends a 50MB video file
    When the worker processes the message
    Then the file upload is handled asynchronously or within acceptable time bounds
    And the BullMQ job does not time out during the upload
    And subsequent messages from other clients are not blocked during this upload
```

**Notes:**
- Supabase Storage is the media backend (consistent with the overall stack decision in architecture §13.1).
- File path convention `workspaces/{workspace_id}/media/{message_id}/{filename}` provides workspace isolation and per-message grouping.
- Signed URLs or direct storage references are acceptable as long as they are resolvable by staff app sessions.
- Large file handling (videos) should not starve the BullMQ queue; consider upload size limits or async upload strategies.

---

### F08-S06: Transcription Failure Handling

**Function:** MP-04 (failure path)

> **As a** staff member,
> **I want** the system to handle voice note transcription failures gracefully without silently dropping the client message,
> **so that** I always know when a client sent a voice note even if the transcription service is unavailable, and I can listen to the audio manually.

**Acceptance Criteria:**

```gherkin
Feature: Transcription failure handling

  Scenario: Transcription service returns an error
    Given a client sends a voice note
    And the transcription service (Whisper or equivalent) returns an error response
    When the worker handles the transcription failure
    Then Message.media_transcription is set to null
    And Message.media_url is populated with the stored audio file path
    And a transcription_failed flag or status is recorded on the Message record
    And the pipeline continues: context assembly and Client Worker are still invoked

  Scenario: Client Worker is informed of transcription failure
    Given a voice note message has media_transcription null and a transcription failure flag set
    When the ContextAssembler includes this message in recentMessages
    Then the message entry indicates that a voice note was received but transcription is unavailable
    And the Client Worker generates a draft that acknowledges the voice note and asks the client to resend as text or call

  Scenario: Transcription service timeout
    Given the transcription service does not respond within the timeout threshold
    When the worker's transcription call times out
    Then the worker treats this as a transcription failure (same as an error response)
    And the audio file remains in storage at media_url
    And the pipeline proceeds without blocking

  Scenario: Staff app shows unprocessed voice note to staff
    Given a voice note message has media_transcription null and transcription_failed set
    When a staff member views the conversation
    Then the message is displayed with an audio playback control pointing to media_url
    And a "Transcription unavailable" label is shown in place of the transcript text
    And staff can manually listen to the audio

  Scenario: Retry mechanism for failed transcriptions
    Given a voice note message has transcription_failed set
    When a background retry job runs (e.g., on next worker cycle or scheduled retry)
    Then the worker re-submits the audio to the transcription service
    And if successful, Message.media_transcription is updated and the failure flag is cleared
    And no duplicate Message records are created

  Scenario: Transcription failure does not suppress AI draft generation
    Given a voice note message has transcription_failed set
    When the Client Worker is invoked
    Then the Client Worker still generates a draft reply
    And the draft does not claim to know what was in the voice note
    And the draft invites the client to share the information another way if needed
```

**Notes:**
- Transcription failure must never result in a silent pipeline halt. The message is always stored; only the transcription text is missing.
- The `transcription_failed` status (or equivalent field) signals both the Client Worker (via context) and the staff app UI.
- A retry strategy (background job or next-message re-attempt) prevents permanent data loss from transient service outages.
- Staff can always fall back to manual audio review via `media_url` — this is the safety net for all transcription failures.

---

## Story Map

| Story | PRD Function / Tier | Priority | Dependencies |
|-------|---------------------|----------|--------------|
| F08-S01: Voice Note Transcription | MP-04 | Must-have | F-02 (pipeline), transcription service integration |
| F08-S02: Image Processing in Client Worker | MP-05 | Must-have | F-05 (Client Worker operational), multimodal LLM configured |
| F08-S03: Staff-Visible Media Storage | Staff-visible tier (§10.2) | Must-have | F-02 (message storage), Supabase Storage |
| F08-S04: Acknowledged Media Handling | Acknowledged tier (§10.2) | Must-have | F-02 (pipeline), F-05 (Client Worker) |
| F08-S05: Media Storage and URL Management | Cross-cutting | Must-have | Supabase Storage configuration |
| F08-S06: Transcription Failure Handling | MP-04 failure path | Must-have | F08-S01 |

## Suggested Build Order

```
F08-S05 (Media Storage + URL Management)   ── foundational storage layer, no feature deps
    |
    v
F08-S01 (Voice Note Transcription)         ── needs storage; transcription before context assembly
    |
    v
F08-S06 (Transcription Failure Handling)   ── failure path for S01; must ship with S01
    |
    v
F08-S03 (Staff-Visible Media)              ── storage layer reused; no LLM dependency
    |
    v
F08-S04 (Acknowledged Media)               ── needs Client Worker (F-05) for acknowledgment drafts
    |
    v
F08-S02 (Image in Client Worker)           ── needs Client Worker (F-05) and multimodal LLM configured
```

## Definition of Done (Feature Level)

- [ ] All 6 stories pass acceptance criteria in integration tests.
- [ ] Voice notes are transcribed before context assembly; transcription text appears in `recentMessages`.
- [ ] Images are passed as vision inputs to the multimodal LLM within the Client Worker call; not injected as text into context.
- [ ] PDFs, videos, and documents are stored and displayed in the staff app conversation thread; none are sent to the LLM.
- [ ] Location, contact, and sticker messages are stored as metadata; Client Worker generates a natural acknowledgment.
- [ ] All media files are stored at workspace-scoped paths (`workspaces/{workspace_id}/media/{message_id}/{filename}`).
- [ ] Transcription failures do not halt the pipeline; the audio file is always retained; staff app shows the audio player with "Transcription unavailable".
- [ ] No media file from one workspace is accessible via another workspace's path.
- [ ] Client Worker drafts acknowledge received acknowledged-tier media naturally and without fabricated details.
- [ ] Retry mechanism exists for failed transcriptions; successful retries populate `media_transcription` without creating duplicate records.
