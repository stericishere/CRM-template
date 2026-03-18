# Feature Spec -- F-01: Workspace Onboarding & Business Setup

**Feature:** F-01 Workspace Onboarding & Business Setup
**User Stories:** US-F01-01 through US-F01-07
**PRD Functions:** ON-01, ON-02, ON-03, ON-04, ON-05, ON-06
**Architecture Reference:** `architecture-final.md` (sections 3, 9, 13, 16)
**Size:** XL (estimated 13-18 engineering days)
**Status:** Spec draft

---

## Architecture Alignment Note

Both `architecture-final.md` and the PRD agree on the WhatsApp integration approach: **Baileys v6+ (QR code pairing)** on Railway. The `phase-3-architecture/CLAUDE.md` journal confirms this decision is **RESOLVED** -- PRD owner confirmed Baileys. No WABA/Cloud API is used.

**This spec is written to the confirmed architecture (Baileys QR pairing on Railway).** The Baileys bridge runs as a plain Node.js server on Railway, connecting to Supabase via pgmq for message queuing.

All other infrastructure decisions follow `architecture-final.md`: Next.js App Router on Vercel, Supabase Edge Functions (Deno), pgmq, Supabase Auth, flat codebase structure, direct LLM SDK, `auth.workspace_id()` RLS pattern.

---

## 1. Component Breakdown

All file paths reference the codebase structure defined in `architecture-final.md` section 13.

### 1.1 Supabase Edge Functions (new)

```
supabase/functions/
  onboarding-whatsapp/
    index.ts            # Baileys session manager: QR generation, pairing, credential persistence
  onboarding-scrape/
    index.ts            # Instagram scrape + LLM knowledge base structuring
  onboarding-sops/
    index.ts            # Deep research SOP generation + conversational refinement
  onboarding-tone/
    index.ts            # Tone profile extraction + adjustment
  onboarding-activate/
    index.ts            # Workspace activation, pipeline wiring
  embed-knowledge/
    index.ts            # (defined in arch) -- chunk text, generate embeddings, upsert
```

**Note on Baileys in Deno Edge Functions:** Baileys (`@whiskeysockets/baileys`) is a Node.js library. It will not run natively in Supabase Edge Functions (Deno runtime). Two approaches:

1. **Recommended for MVP:** Run the Baileys session manager as a lightweight Node.js process on Railway. The Edge Function `onboarding-whatsapp` becomes a thin proxy that communicates with this process via HTTP/WebSocket. The Node.js process handles QR generation, session persistence, and message listening. This is the only component that requires a non-Supabase host.
2. **Alternative:** Use a Deno-compatible WhatsApp Web library if one exists with sufficient maturity (as of March 2026, none are production-ready).

This is the primary architectural cost of choosing Baileys over Cloud API.

### 1.2 Shared Edge Function Code (new files in `_shared/`)

```
supabase/functions/_shared/
  llm-client.ts         # MODIFY: add structured output helper for JSON schema-constrained responses
  prompts/
    instagram-to-knowledge.ts   # NEW: prompt template for IG -> knowledge base
    deep-research-sop.ts        # NEW: prompt template for vertical SOP generation
    sop-refinement.ts           # NEW: prompt template for conversational SOP editing
    tone-extraction.ts          # NEW: prompt template for tone profile extraction
    tone-adjustment.ts          # NEW: prompt template for tone refinement from feedback
  types.ts              # MODIFY: add VerticalConfig, OnboardingStatus, WhatsAppConfig types
  instagram-scraper.ts  # NEW: HTTP-based public Instagram profile scraper
  whatsapp-session.ts   # NEW: Baileys session management utilities (or HTTP client for external process)
```

### 1.3 Next.js App (new pages and components)

```
src/
  app/
    (auth)/
      register/page.tsx             # NEW: owner registration (Supabase Auth signup)
    onboarding/
      layout.tsx                    # NEW: onboarding shell with step indicator
      page.tsx                      # NEW: redirect to current step
      whatsapp/page.tsx             # NEW: step 1 -- QR code display and pairing
      identity/page.tsx             # NEW: step 2 -- business identity form
      knowledge/page.tsx            # NEW: step 3 -- Instagram scrape + KB editor
      sops/page.tsx                 # NEW: step 4 -- SOP generation + review
      refine/page.tsx               # NEW: step 5 -- conversational SOP refinement
      tone/page.tsx                 # NEW: step 6 -- tone profile extraction + adjustment
      summary/page.tsx              # NEW: step 7 -- summary + activation

  components/
    onboarding/
      QrCodeDisplay.tsx             # NEW: QR image + expiry countdown + refresh
      StepIndicator.tsx             # NEW: progress bar for onboarding steps
      SopReviewCard.tsx             # NEW: displays one SOP component
      ToneProfileCard.tsx           # NEW: displays tone attributes with examples
      KnowledgeEditor.tsx           # NEW: markdown editor for KB content
      ConversationalEditor.tsx      # NEW: chat-style input + config diff display

  hooks/
    use-onboarding.ts              # NEW: state machine for step progression
    use-whatsapp-pairing.ts        # NEW: WebSocket/SSE for QR code events

  lib/
    supabase/
      client.ts                    # EXISTS: browser Supabase client
      server.ts                    # EXISTS: server-side Supabase client
    types.ts                       # MODIFY: add generated types for new tables/columns
```

### 1.4 Database Migrations (new)

These extend `001_initial_schema.sql` or are added as separate migrations if the initial schema has already been applied.

```
supabase/migrations/
  001_initial_schema.sql    # MODIFY: ensure workspaces table has all onboarding columns
                            # (knowledge_base TEXT, onboarding_status, instagram_handle, etc.)
  002_rls_policies.sql      # MODIFY: ensure RLS covers knowledge_chunks table
```

The `workspaces` and `knowledge_chunks` tables are already defined in `architecture-final.md` section 9.1. F-01 requires two columns that may need to be added if not present:

- `workspaces.knowledge_base` (TEXT) -- stores the full markdown knowledge base
- `workspaces.whatsapp_session_creds` (TEXT, encrypted) -- Baileys auth state

---

## 2. Data Model Requirements

### 2.1 Tables

F-01 operates primarily on the `workspaces` and `knowledge_chunks` tables. Both are defined in `architecture-final.md` section 9.1. Below are the exact schemas from the final architecture, with F-01-specific additions noted.

#### `workspaces` (per arch section 9.1, with F-01 additions)

```sql
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  vertical_type TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  business_hours JSONB,
  tone_profile TEXT,                           -- F-01 writes this (step 6)
  knowledge_base TEXT,                         -- F-01 writes this (step 3) -- ADD if not in arch
  vertical_config JSONB,                       -- F-01 writes this (steps 4-5)
  communication_profile JSONB,                 -- Phase 4 (learning loop)
  whatsapp_session_creds TEXT,                -- Baileys encrypted auth state
  whatsapp_connection_status TEXT DEFAULT 'disconnected',  -- F-01 ADD: session status
  whatsapp_phone_number TEXT,                 -- F-01 ADD: paired phone number (E.164)
  calendar_config JSONB,
  instagram_handle TEXT,
  instagram_scrape_data JSONB,                -- F-01 ADD: raw scrape results for tone extraction
  onboarding_status TEXT NOT NULL DEFAULT 'pending',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'trialing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**F-01-specific columns to add (if not present in base migration):**

| Column | Type | Purpose |
|--------|------|---------|
| `knowledge_base` | TEXT | Full markdown KB content (written in step 3) |
| `whatsapp_session_creds` | TEXT | Encrypted Baileys auth state (if using Baileys) |
| `whatsapp_connection_status` | TEXT | `disconnected`, `connecting`, `connected`, `requires_rescan` |
| `whatsapp_phone_number` | TEXT | Paired phone number from Baileys session |
| `instagram_scrape_data` | JSONB | Raw scrape results, kept for tone extraction in step 6 |

**`onboarding_status` values** (per user stories):

`pending` -> `instagram_scraped` -> `sop_configured` -> `tone_set` -> `complete`

**`vertical_config` JSON shape** (per PRD section 11.1):

```typescript
type VerticalConfig = {
  customFields: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'date' | 'boolean' | 'enum';
    enumValues?: string[];
    required: boolean;
    group?: string;
  }>;
  appointmentTypes: Array<{
    key: string;
    label: string;
    durationMinutes: number;
    bufferMinutes: number;
    prerequisite?: string;
  }>;
  lifecycleStages?: Array<{
    key: string;
    label: string;
    description: string;
  }>;
  sopRules?: string[];
  knowledgeBaseTemplate?: string;
};
```

#### `staff` (per arch section 9.1 -- no changes)

```sql
CREATE TABLE staff (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

F-01 creates one `staff` record (role = `owner`) during `StartOnboarding`.

#### `knowledge_chunks` (per arch section 9.1 -- no changes)

```sql
CREATE TABLE knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'instagram_scrape', 'manual_upload', 'settings_editor'
  source_ref TEXT,
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

F-01 populates this table when the knowledge base is confirmed (step 3), via the `embed-knowledge` Edge Function.

### 2.2 Indexes

Already defined in `architecture-final.md` section 9.1:

```sql
CREATE INDEX idx_knowledge_workspace ON knowledge_chunks(workspace_id);
CREATE INDEX idx_knowledge_embedding ON knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### 2.3 Row-Level Security Policies

All RLS follows the `auth.workspace_id()` pattern from `architecture-final.md` section 9.2:

```sql
-- Already defined in arch:
CREATE OR REPLACE FUNCTION auth.workspace_id()
RETURNS UUID AS $$
  SELECT workspace_id FROM staff WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Workspaces
CREATE POLICY "workspace_isolation" ON workspaces
  FOR ALL USING (id = auth.workspace_id())
  WITH CHECK (id = auth.workspace_id());

-- Knowledge chunks
CREATE POLICY "workspace_isolation" ON knowledge_chunks
  FOR ALL USING (workspace_id = auth.workspace_id())
  WITH CHECK (workspace_id = auth.workspace_id());
```

**Service role access:** The Baileys session manager (running as a background process) and the `embed-knowledge` Edge Function use the Supabase service_role key to bypass RLS when writing credentials and embeddings.

---

## 3. API Endpoints

Onboarding endpoints are implemented as **Next.js API routes** (not Edge Functions) because they are called from the staff app and need to coordinate with multiple backend services. The LLM-heavy operations are delegated to Edge Functions.

All endpoints require Supabase Auth JWT. Base path: `/api/onboarding`.

### 3.1 POST `/api/onboarding/start`

Creates workspace + staff record, initiates Baileys QR code generation.

**Request:** `{}`

**Response (201):**
```json
{
  "workspaceId": "uuid",
  "onboardingStatus": "pending",
  "pairingChannel": "/api/onboarding/{workspaceId}/whatsapp/events"
}
```

**Logic:**
1. Create `workspaces` row: `business_name = ''`, `vertical_type = ''`, `onboarding_status = 'pending'`.
2. Create `staff` row: `id = auth.uid()`, `workspace_id`, `role = 'owner'`.
3. Signal the Baileys process to initialize a session for this workspace.
4. Return SSE/WebSocket endpoint URL for QR code delivery.

---

### 3.2 GET `/api/onboarding/{workspaceId}/whatsapp/events` (SSE)

Server-Sent Events stream for QR code delivery and pairing status.

**Auth:** Supabase JWT

**Server events:**
```typescript
{ event: 'qr_code', data: { qr: string, expiresAt: string } }
{ event: 'paired', data: { phoneNumber: string } }
{ event: 'qr_expired', data: { message: string } }
{ event: 'disconnected', data: { reason: string } }
{ event: 'history_import_progress', data: { imported: number, total: number | null } }
{ event: 'history_import_complete', data: { totalImported: number } }
```

**Implementation:** The Next.js API route opens a long-lived SSE connection. It subscribes to events from the Baileys process (via Redis pub/sub, HTTP polling, or a lightweight message channel). When the Baileys process emits a QR code or pairing event, the API route forwards it to the client.

---

### 3.3 POST `/api/onboarding/{workspaceId}/whatsapp/refresh-qr`

Requests a fresh QR code from the Baileys process.

**Response (200):** `{ status: "refreshing" }` -- new QR delivered via SSE.

---

### 3.4 PUT `/api/onboarding/{workspaceId}/identity`

Saves business identity (step 2).

**Request:**
```json
{
  "businessName": "string (required)",
  "verticalType": "string (required)",
  "instagramHandle": "string | null",
  "timezone": "string (required, IANA)"
}
```

**Response (200):**
```json
{
  "workspaceId": "uuid",
  "businessName": "Acme Tailors",
  "verticalType": "bespoke_tailor",
  "instagramHandle": "acme_tailors",
  "timezone": "Asia/Hong_Kong",
  "onboardingStatus": "pending"
}
```

**Validation (Zod):**
- `businessName`: `.min(1).max(200)`
- `verticalType`: `.min(1).max(100)` (free-text, supports niche verticals)
- `instagramHandle`: `.optional().nullable()`, strip `@` prefix and URL prefix if present, `.max(100)`
- `timezone`: validated against `Intl.supportedValuesOf('timeZone')`

---

### 3.5 POST `/api/onboarding/{workspaceId}/scrape-instagram`

Triggers Instagram scrape and LLM knowledge base generation (step 3). Calls the `onboarding-scrape` Edge Function.

**Request:** `{}`

**Response (202):**
```json
{ "status": "scraping" }
```

**Progress delivered via Supabase Realtime** on the `workspaces` table (the Edge Function updates `instagram_scrape_data` and `knowledge_base` columns, which the client subscribes to). Alternatively, the client polls `GET /api/onboarding/{workspaceId}/status`.

---

### 3.6 PUT `/api/onboarding/{workspaceId}/knowledge-base`

Saves the reviewed/edited knowledge base and triggers embedding.

**Request:**
```json
{
  "knowledgeBase": "string (markdown)"
}
```

**Response (200):**
```json
{
  "workspaceId": "uuid",
  "onboardingStatus": "instagram_scraped",
  "chunksIndexed": 12
}
```

**Logic:**
1. Write `knowledge_base` to `workspaces` row.
2. Invoke `embed-knowledge` Edge Function: chunk markdown, generate embeddings, upsert `knowledge_chunks`.
3. Update `onboarding_status = 'instagram_scraped'`.

---

### 3.7 POST `/api/onboarding/{workspaceId}/generate-sops`

Triggers deep research SOP generation (step 4). Calls `onboarding-sops` Edge Function.

**Request:** `{}`

**Response (200):**
```json
{
  "verticalConfig": { /* VerticalConfig */ },
  "generationNotes": ["string array of flags for generic/uncertain sections"]
}
```

This is a synchronous call (LLM response expected in 10-30s). The Edge Function has a 150s timeout on Pro tier, which is sufficient.

---

### 3.8 POST `/api/onboarding/{workspaceId}/refine-sops`

Conversational SOP refinement (step 5). One round per call.

**Request:**
```json
{
  "instruction": "string (natural language)",
  "conversationHistory": [
    { "role": "user", "content": "string" },
    { "role": "assistant", "content": "string" }
  ],
  "currentVerticalConfig": { /* VerticalConfig */ }
}
```

**Response (200):**
```json
{
  "updatedVerticalConfig": { /* VerticalConfig */ },
  "changesSummary": "Updated first_fitting duration from 60 to 45 minutes.",
  "assistantMessage": "Done! I've changed the First Fitting duration to 45 minutes."
}
```

---

### 3.9 PUT `/api/onboarding/{workspaceId}/confirm-sops`

Finalizes SOPs after conversational refinement.

**Request:**
```json
{
  "verticalConfig": { /* VerticalConfig */ }
}
```

**Response (200):**
```json
{
  "workspaceId": "uuid",
  "onboardingStatus": "sop_configured"
}
```

---

### 3.10 POST `/api/onboarding/{workspaceId}/extract-tone`

Triggers tone profile extraction (step 6). Calls `onboarding-tone` Edge Function.

**Request:**
```json
{
  "ownerDescription": "string | null"
}
```

If `ownerDescription` is provided (when no Instagram data), tone is generated from that + vertical type.

**Response (200):**
```json
{
  "toneProfile": "string (structured text)"
}
```

---

### 3.11 POST `/api/onboarding/{workspaceId}/refine-tone`

Adjusts tone profile based on owner feedback.

**Request:**
```json
{
  "feedback": "string",
  "currentToneProfile": "string"
}
```

**Response (200):**
```json
{
  "toneProfile": "string (updated)"
}
```

---

### 3.12 PUT `/api/onboarding/{workspaceId}/confirm-tone`

Saves finalized tone profile.

**Request:**
```json
{
  "toneProfile": "string"
}
```

**Response (200):**
```json
{
  "workspaceId": "uuid",
  "onboardingStatus": "tone_set"
}
```

---

### 3.13 POST `/api/onboarding/{workspaceId}/activate`

Activates workspace and completes onboarding (step 7).

**Request:** `{}`

**Response (200):**
```json
{
  "workspaceId": "uuid",
  "onboardingStatus": "complete",
  "capabilities": {
    "messaging": true,
    "knowledgeGroundedDrafts": true,
    "verticalAwareDrafting": true,
    "brandVoiceDrafts": true,
    "booking": false
  }
}
```

**Logic:**
1. Verify WhatsApp is connected (`whatsapp_connection_status = 'connected'`).
2. Update `onboarding_status = 'complete'`.
3. Ensure message listener is active (Baileys process forwarding to pgmq).
4. Return progressive capability map.

---

### 3.14 GET `/api/onboarding/{workspaceId}/status`

Returns current onboarding state for step resumption.

**Response (200):**
```json
{
  "workspaceId": "uuid",
  "onboardingStatus": "sop_configured",
  "whatsappConnected": true,
  "businessName": "Acme Tailors",
  "verticalType": "bespoke_tailor",
  "instagramHandle": "acme_tailors",
  "knowledgeBaseExists": true,
  "verticalConfigExists": true,
  "toneProfileExists": false,
  "historyImportStatus": "in_progress"
}
```

---

## 4. Key Implementation Details

### 4.1 WhatsApp QR Code Pairing Flow (Baileys)

**Library:** `@whiskeysockets/baileys` (maintained fork, WhatsApp Web multi-device protocol).

**Deployment constraint:** Baileys requires Node.js and persistent WebSocket connections. It cannot run in Supabase Edge Functions (Deno, stateless). Deploy as a separate lightweight process.

**Recommended deployment:**

```
[Railway - Node.js process]
  - Manages Baileys socket connections (one per workspace)
  - Exposes HTTP API for: initSession, getQrCode, getStatus, sendMessage
  - Pushes events to Supabase (insert/update workspace row, enqueue to pgmq)
  - Listens for incoming WhatsApp messages and enqueues to pgmq

[Supabase Edge Functions]
  - onboarding-whatsapp: thin proxy, calls Baileys process HTTP API

[Next.js API routes]
  - SSE endpoint: polls/subscribes to Baileys process events, streams to client
```

**Pairing flow:**

```
1. Owner hits POST /api/onboarding/start
2. Next.js route creates workspace + staff records in Supabase
3. Next.js calls Baileys process: POST /sessions/{workspaceId}/init
4. Baileys process:
   a. const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
   b. const sock = makeWASocket({ auth: state, printQRInTerminal: false })
   c. sock.ev.on('connection.update', handler)
5. Owner opens SSE endpoint: GET /api/onboarding/{workspaceId}/whatsapp/events
6. Baileys emits QR code -> pushed to SSE stream
7. Owner scans QR with WhatsApp mobile app
8. Baileys emits connection: 'open':
   a. Extract phone number from sock.user.id (format: "1234567890:0@s.whatsapp.net")
   b. Serialize auth state -> encrypt -> write to workspaces.whatsapp_session_creds
   c. Update whatsapp_connection_status = 'connected', whatsapp_phone_number
   d. Push 'paired' event to SSE stream
9. Begin background history import
```

**Session persistence:**

- Baileys auth state serialized and encrypted with AES-256-GCM.
- Encryption key: `WHATSAPP_ENCRYPTION_KEY` env var + workspace ID as salt.
- On Baileys process restart: load encrypted creds from DB, deserialize, reconnect without QR.
- If reconnection fails (credentials expired), set `whatsapp_connection_status = 'requires_rescan'`.

**QR code lifecycle:**

- Baileys generates a new QR code approximately every 20 seconds (WhatsApp protocol behavior).
- Each new QR is streamed to the client via SSE.
- If no scan within ~60 seconds, the connection attempt times out.
- Client shows "Refresh QR" button that calls `POST /refresh-qr`.

**History import (background):**

After successful pairing, the Baileys process:
1. Iterates recent chats via `sock.groupFetchAllParticipating()` and `sock.fetchMessageHistory()`.
2. For each message: normalize phone numbers, write to `messages` table (uses F-02's schema), create client records as needed (delegates to F-03 logic or creates stubs).
3. Import runs fully in the background. Progress events pushed via SSE.
4. If import fails mid-way, mark as partial. System remains functional with whatever was imported.

### 4.2 Instagram Scraping Pipeline

**Approach:** HTTP-based public profile scraping. No Instagram API keys needed.

**Pipeline:**

```
1. Validate handle format (alphanumeric + underscores + periods, 1-30 chars)
2. Fetch profile data:
   - Primary: GET https://www.instagram.com/api/v1/users/web_profile_info/?username={handle}
   - Fallback: parse window._sharedData or __additionalDataLoaded from HTML
   - Fallback: try ?__a=1&__d=dis endpoint
3. Extract:
   - Bio text
   - Last 12-20 post captions with timestamps
   - Highlight reel names (metadata only)
   - Link-in-bio URL -> fetch page, extract text content
4. Store raw scrape result in workspaces.instagram_scrape_data (JSONB)
   (Kept for tone extraction in step 6)
5. Pass to LLM for knowledge base structuring
```

**LLM structuring** (single call):

Prompt template `instagram-to-knowledge.ts`:

```
You are helping a {verticalType} business set up their AI assistant's knowledge base.

Below is content scraped from their Instagram profile (@{instagramHandle}).

## Raw Instagram Content
Bio: {bio}

Recent post captions:
{postsFormatted}

Highlights: {highlightsFormatted}

Link-in-bio content:
{linkInBioContent}

## Task
Generate a structured markdown knowledge base. Organize into:
- **About the business** -- what they do, their story, positioning
- **Services offered** -- each service with description; include pricing if mentioned
- **Policies** -- booking, cancellation, deposits, turnaround times (if inferable)
- **FAQs** -- common questions a client might ask, inferred from the content
- **Contact and location** -- locations, hours, contact methods

Rules:
- Only include information clearly stated or strongly implied in the content.
- Mark sections where you had to infer significantly with "[Needs review]".
- Use plain language. Do not embellish.
- If a section has no relevant content, include the heading with "No information found -- please add details."
```

**Model:** Claude Sonnet 4 (per arch section 6.6). Temperature: 0.3. Direct Anthropic SDK call with `logLLMUsage()`.

**Anti-bot mitigation:**
- 2-3 second delays between HTTP requests.
- Rotate User-Agent strings from a pool of common browser UAs.
- If scraping fails after 2 retries, fall back to manual entry immediately.
- Raw scrape data is not stored beyond the workspace record.

### 4.3 Deep Research SOP Generation

Single LLM call per ADR-1. The LLM uses its training knowledge to generate industry-specific operational configuration.

**Prompt template `deep-research-sop.ts`:**

```
You are an expert business operations consultant specializing in {verticalType} businesses.

## Business Context
Business name: {businessName}
Vertical type: {verticalType}
Timezone: {timezone}

{knowledgeBaseSection}

## Task
Generate a complete operational configuration for this business.
Return a JSON object matching this exact TypeScript type:

{verticalConfigTypeDefinition}

### Guidelines:

**appointmentTypes:**
- Include all standard appointment/service types for a {verticalType} business.
- Set realistic durations based on industry norms.
- Include buffer times (travel, prep, cleanup) where relevant.
- Set prerequisites where there is a natural sequence (e.g., consultation before fitting).
- If the knowledge base mentions specific services, use those exact names.

**customFields:**
- Include fields a {verticalType} business would track per client.
- Use appropriate types (enum for fixed options, string for free text, number for measurements).
- Mark fields required only if essential for service delivery.
- Group related fields.

**lifecycleStages:**
- Define client journey stages typical for a {verticalType} business.
- Include description explaining when a client enters each stage.

**sopRules:**
- Write as plain-language instructions the AI should follow when drafting messages.
- Include communication norms, booking/scheduling rules, and escalation triggers.

### Quality rules:
- If you are confident about an industry standard, state it directly.
- If a section is generic or uncertain, prefix the item's label with "[Customize] ".
- Prefer specificity over vagueness. "45 minutes" is better than "varies".
- Generate at least 3 appointment types, 5 custom fields, 4 lifecycle stages, and 8 SOP rules.
```

**Output:** JSON validated against `VerticalConfig` Zod schema.

**Model:** Claude Sonnet 4. Temperature: 0.4. Max tokens: 4000.

**Structured output enforcement:** Request JSON mode from the LLM. Parse response with Zod. If validation fails, retry once with explicit JSON formatting instructions. If second attempt fails, return minimal valid config with all sections marked "[Customize]".

### 4.4 Conversational SOP Editing

Each refinement round is a single LLM call. The client maintains conversation history and sends it with each request. Server is stateless per request.

**Prompt template `sop-refinement.ts`:**

```
You are helping a business owner configure their operational SOPs.

## Current Configuration
{currentVerticalConfigJson}

## Conversation History
{conversationHistoryFormatted}

## Owner's Instruction
"{instruction}"

## Task
1. Parse the instruction and determine what changes to make.
2. Apply the changes.
3. Return JSON with:
   - "updatedConfig": the full updated VerticalConfig JSON
   - "changesSummary": brief human-readable description of what changed
   - "assistantMessage": conversational response confirming the change

Rules:
- Only modify parts the instruction refers to.
- If ambiguous, make best interpretation and note it in assistantMessage.
- If the instruction doesn't make sense, explain why in assistantMessage and return config unchanged.
- Preserve all existing items unless explicitly removed.
```

**Model:** Claude Sonnet 4. Temperature: 0.2 (lower for precision edits).

**Validation:** Every LLM response is validated against the `VerticalConfig` Zod schema. If invalid, return error in `assistantMessage` and keep previous config.

### 4.5 Tone Profile Extraction

**Input sources (priority order):**
1. Instagram scrape data (`instagram_scrape_data` JSONB column) -- primary
2. Knowledge base content -- secondary
3. Owner's self-description text -- fallback
4. Vertical type defaults -- last resort

**Prompt template `tone-extraction.ts`:**

```
You are analyzing a business's communication style to create a tone profile for their AI assistant.

## Source Content
{sourceContent}

## Business Context
Business: {businessName}
Vertical: {verticalType}

## Task
Generate a tone profile as actionable instructions for the AI assistant. Include:

1. **Formality level** -- where on casual-to-formal spectrum. Specific guidance (e.g., "Use first names, avoid 'Dear Sir/Madam'").
2. **Warmth** -- friendliness level. Give examples.
3. **Emoji and punctuation style** -- whether to use emojis, exclamation marks. Specific rules.
4. **Industry-specific norms** -- communication conventions for {verticalType} businesses.
5. **Vocabulary guidance** -- words/phrases to prefer or avoid. 3-5 example phrases.
6. **Response length preference** -- concise vs. detailed.

Output: Plain text, structured with attribute headers. Each section 2-4 sentences of actionable instruction.
```

**Tone adjustment** uses `tone-adjustment.ts` prompt: current profile + owner feedback -> revised profile.

**Model:** Claude Sonnet 4. Temperature: 0.3.

---

## 5. Edge Cases and Error States

### 5.1 QR Code Expiry/Timeout

| Scenario | Detection | Handling |
|----------|-----------|----------|
| QR not scanned within 60s | Baileys emits connection close or timeout | Push `qr_expired` SSE event. Show "Refresh" button. |
| Owner closes app mid-scan | SSE disconnect | Onboarding state preserved in DB. On reconnect, call `GET /status` to determine resume point. |
| Multiple QR refresh attempts (>5) | Client-side counter | Show "Having trouble?" with manual troubleshooting steps. |
| Baileys process fails to start | HTTP error from Baileys service | Return 503. Show "WhatsApp service temporarily unavailable." |
| Baileys process is down | Health check fails | Next.js API route returns 503. Frontend shows retry prompt. |

### 5.2 Instagram Private/Unavailable

| Scenario | Detection | Handling |
|----------|-----------|----------|
| Profile is private | Response indicates `is_private: true` or no post data | Return `scrapeFailed` with `reason: 'profile_private'`. Present manual KB editor. |
| Profile does not exist | HTTP 404 | Return `scrapeFailed` with `reason: 'not_found'`. Prompt to check handle + manual editor. |
| Instagram rate-limits | HTTP 429 or connection refused | Retry once after 5s. If still blocked, fall back to manual entry. |
| Scraping returns empty content | No usable text parsed | Generate vertical-type template KB with placeholder sections. |
| Handle provided but scrape >30s | Timeout | Abort. Fall back to manual entry. |

### 5.3 LLM Failures During SOP Generation

| Scenario | Detection | Handling |
|----------|-----------|----------|
| LLM API timeout (>45s) | HTTP timeout from SDK | Retry once. If fails, return minimal `VerticalConfig` with all sections marked "[Customize]". |
| LLM returns invalid JSON | Zod validation failure | Retry once with stricter prompt. If fails again, return minimal config. |
| LLM returns nonsensical content | Zod passes but 0 appointment types | Return whatever passed validation. Add `generationNotes: ["SOP generation produced limited results. Please add details manually."]` |
| LLM API key exhausted | HTTP 401/402 | Log critical error. Show "AI generation temporarily unavailable. Configure SOPs manually." Present empty SOP editor. |
| Conversational refinement breaks config | Updated config fails Zod | Keep previous config. Return `assistantMessage: "I couldn't apply that change. Could you rephrase?"` |

### 5.4 Session Disconnection

| Scenario | Detection | Handling |
|----------|-----------|----------|
| WhatsApp disconnects during onboarding | Baileys `connection: 'close'` | Update `whatsapp_connection_status = 'requires_rescan'`. Push `disconnected` SSE event. Onboarding progress preserved. Show reconnect prompt. |
| Baileys process crashes | Process monitor / health check | On restart, load all workspace credentials from DB, attempt silent reconnect for each. Workspaces that fail go to `requires_rescan`. |
| History import fails mid-way | Exception in import loop | Log error. Mark import as partial. System functional with whatever was imported. Show warning in summary. |
| Browser closed during onboarding | No server detection needed | All state in DB. Next visit calls `GET /status` and resumes at correct step. |

### 5.5 Data Validation Edge Cases

| Scenario | Handling |
|----------|----------|
| Business name contains only whitespace | Zod `.min(1)` after `.trim()` rejects. Return 400. |
| Timezone not valid IANA | Zod custom validator rejects. Return 400 with suggestions. |
| Instagram handle is a full URL | Strip URL prefix, extract handle. If extraction fails, return 400 with guidance. |
| Knowledge base content exceeds 500KB | Reject with 413. "Please reduce to under 500KB." |
| Empty knowledge base submitted | Accept. Store empty string. Skip chunk indexing. Update status to `instagram_scraped`. |
| Owner submits SOP refinement with empty instruction | Return 400. "Please provide an instruction." |

---

## 6. Acceptance Criteria to Implementation Tasks

### US-F01-01: Connect WhatsApp and Create Workspace

| Acceptance Criteria | Tasks |
|--------------------|-----------------------|
| QR scan -> WhatsApp Web session | **T-01a:** Deploy Baileys Node.js service (Railway). Implement HTTP API: `POST /sessions/:id/init`, `GET /sessions/:id/status`, `POST /sessions/:id/refresh-qr`. Handle `connection.update` events. **T-01b:** Implement Next.js SSE route `GET /api/onboarding/[workspaceId]/whatsapp/events` that streams Baileys events to the client. **T-01c:** Implement `QrCodeDisplay.tsx`: render QR from string (using `qrcode` npm package), show countdown, handle expiry, wire refresh button. |
| Workspace created with status "pending" | **T-01d:** Implement `POST /api/onboarding/start` route: create `workspaces` row, create `staff` row, call Baileys init. **T-01e:** Add F-01-specific columns to `001_initial_schema.sql` migration (or add migration). |
| Credentials persisted in `whatsapp_session_creds` | **T-01f:** In Baileys service, implement auth state serialization + AES-256-GCM encryption. On `saveCreds` callback, write encrypted state to `workspaces.whatsapp_session_creds`. |
| Redirect to business identity step | **T-01g:** Implement `use-onboarding.ts` hook with step state machine. On `paired` SSE event, advance to step 2. |
| QR expires -> message + refresh button | **T-01h:** Handle `qr_expired` SSE event in `QrCodeDisplay.tsx`. Show expiry message. Refresh button calls `POST /refresh-qr`. |
| Session disconnect -> preserve progress | **T-01i:** Handle `disconnected` SSE event. Show reconnect UI. Onboarding data preserved in DB -- no client state lost. |
| History import in background | **T-01j:** In Baileys service, implement history import loop after pairing. Write messages to `messages` table (F-02 schema). Create stub client records. Push progress events. |

### US-F01-02: Provide Business Identity

| Acceptance Criteria | Tasks |
|--------------------|-----------------------|
| Business name, vertical, IG, timezone saved | **T-02a:** Implement `PUT /api/onboarding/[workspaceId]/identity` route with Zod validation. Update `workspaces` row. **T-02b:** Implement `identity/page.tsx` form with fields, validation, submit handler. |
| Instagram handle optional | **T-02c:** Zod schema marks `instagramHandle` as `.nullable().optional()`. Frontend shows field as optional. |
| Timezone auto-detected | **T-02d:** In `identity/page.tsx`, detect via `Intl.DateTimeFormat().resolvedOptions().timeZone`. Pre-fill. Allow override with searchable timezone list. |
| Vertical type drives SOP generation | **T-02e:** Implement vertical type picker as searchable text input with suggestions (static list of common verticals). Free-text allowed for niche. |

### US-F01-03: Bootstrap Knowledge Base from Instagram

| Acceptance Criteria | Tasks |
|--------------------|-----------------------|
| Scrape extracts bio, captions, highlights, link-in-bio | **T-03a:** Implement `instagram-scraper.ts` in `_shared/`. HTTP-based profile fetch with multiple fallback strategies. Handle all failure modes. |
| LLM generates structured markdown KB | **T-03b:** Implement `onboarding-scrape` Edge Function: orchestrate scrape -> LLM call with `instagram-to-knowledge` prompt -> save results. Implement prompt template. |
| Draft shown for review | **T-03c:** Implement `knowledge/page.tsx`: display markdown draft in editable view (markdown editor component). |
| Owner can edit/add/delete | **T-03d:** Implement `KnowledgeEditor.tsx` with full markdown editing + preview. Submit calls `PUT /knowledge-base`. |
| Private/unavailable -> manual entry | **T-03e:** In `knowledge/page.tsx`, handle scrape failure: show explanation, switch to blank editor. |
| Partial scrape -> draft from available data | **T-03f:** LLM prompt handles sparse input. Mark empty sections "[Needs review]". |
| No IG handle -> vertical template | **T-03g:** Skip scrape. Present blank template based on vertical type. |
| KB indexed into knowledge_chunks | **T-03h:** On KB confirmation, invoke `embed-knowledge` Edge Function: split markdown by headings into ~500-token chunks, generate embeddings via `text-embedding-3-small`, upsert `knowledge_chunks`. |

### US-F01-04: Generate Vertical-Specific SOPs

| Acceptance Criteria | Tasks |
|--------------------|-----------------------|
| Deep research generates vertical_config | **T-04a:** Implement `onboarding-sops` Edge Function with `deep-research-sop` prompt. Call LLM, validate response with Zod. **T-04b:** Implement prompt template file. |
| Draft includes all four SOP sections | **T-04c:** Zod schema enforces minimum: 1 appointment type, 1 custom field, 1 lifecycle stage, 1 SOP rule. |
| Knowledge base enriches SOPs | **T-04d:** Include `knowledge_base` content in prompt if it exists. LLM uses business-specific details. |
| Niche vertical -> generic defaults | **T-04e:** Prompt instructs LLM to prefix uncertain items with "[Customize]". |
| SOP components displayed for review | **T-04f:** Implement `sops/page.tsx` with `SopReviewCard.tsx` components: appointment types table, custom fields list, lifecycle stages, SOP rules list. |
| Status updated to "sop_configured" | **T-04g:** `PUT /confirm-sops` updates `onboarding_status`. |

### US-F01-05: Refine SOPs Conversationally

| Acceptance Criteria | Tasks |
|--------------------|-----------------------|
| NL instruction modifies config | **T-05a:** Implement `POST /refine-sops` route calling `onboarding-sops` Edge Function with `sop-refinement` prompt. Validate output. Return updated config + summary. **T-05b:** Implement `sop-refinement` prompt template. |
| Chat-style editing interface | **T-05c:** Implement `refine/page.tsx` with `ConversationalEditor.tsx`: chat input, conversation history display, current config as side panel. Confirm button calls `PUT /confirm-sops`. |
| Multiple editing rounds | **T-05d:** Client maintains `conversationHistory` array in React state. Each submit appends user + assistant messages. Full history sent with each request. |
| Running summary of changes | **T-05e:** Each response includes `changesSummary`. Client accumulates in a "Changes made" panel. |

### US-F01-06: Extract and Adjust Tone Profile

| Acceptance Criteria | Tasks |
|--------------------|-----------------------|
| Tone generated from IG content | **T-06a:** Implement `onboarding-tone` Edge Function with `tone-extraction` prompt. Load `instagram_scrape_data` from workspace. **T-06b:** Implement prompt template. |
| Owner adjusts with feedback | **T-06c:** Implement `POST /refine-tone` calling Edge Function with `tone-adjustment` prompt. |
| Owner accepts -> persisted | **T-06d:** `PUT /confirm-tone` writes `tone_profile`, updates `onboarding_status = 'tone_set'`. |
| No IG data -> fallback | **T-06e:** Detect if `instagram_scrape_data` is null. Use vertical type + `ownerDescription` as input. **T-06f:** `tone/page.tsx`: if no IG data, show text input for owner to describe style before extraction. |
| Profile includes actionable attributes | **T-06g:** Prompt enforces all 6 attribute sections. Validate output contains all headers. |

### US-F01-07: Complete Onboarding and Activate Workspace

| Acceptance Criteria | Tasks |
|--------------------|-----------------------|
| Summary screen with all config details | **T-07a:** Implement `summary/page.tsx`: fetch workspace via `GET /status`, display WhatsApp status, business name, vertical, KB summary (word count), SOP highlights (counts), tone summary (first 100 chars), calendar status ("Not connected"). |
| Activate -> status = "complete" | **T-07b:** Activate button calls `POST /activate`. On success, redirect to `/inbox`. |
| Message pipeline activated | **T-07c:** `POST /activate` verifies WhatsApp connected. Baileys process begins forwarding inbound messages to pgmq. |
| Imported history available | **T-07d:** Summary shows history import status/count. If still running, show progress. If failed, show warning. |
| Revisit completed steps | **T-07e:** Each summary section is clickable, navigating to the relevant step page. `use-onboarding.ts` supports backward navigation preserving forward progress. |
| Skip Google Calendar | **T-07f:** Calendar section shows "Connect later in Settings". No blocking. (F-07, Phase 2). |
| Progressive capabilities | **T-07g:** Calculate and return capability map based on which workspace fields are populated. |

---

## 7. Dependencies

### 7.1 External Dependencies

| Dependency | Usage | Notes |
|------------|-------|-------|
| `@whiskeysockets/baileys` | WhatsApp Web protocol: QR generation, session management, message history | Node.js only. Requires separate deployment (not Deno Edge Functions). |
| Anthropic SDK (Claude Sonnet 4) | KB structuring, SOP generation, SOP refinement, tone extraction | Direct SDK per arch section 6.6. All calls logged to `llm_usage`. |
| OpenAI SDK (`text-embedding-3-small`) | Knowledge chunk embeddings | 1536-dimension vectors for `knowledge_chunks.embedding`. |
| Instagram public web endpoints | Profile scraping | No API key. Fragile -- treat as best-effort with manual fallback. |
| `pgvector` Postgres extension | Vector similarity search | Enabled in Supabase project. |
| `qrcode` (npm) | Client-side QR code rendering | Used in `QrCodeDisplay.tsx`. |

### 7.2 Internal Dependencies

| Dependency | Relationship | Notes |
|------------|-------------|-------|
| **F-02 (WhatsApp Message Pipeline)** | F-01 creates the WhatsApp session. History import writes to F-02's `messages` table. After activation, the Baileys process forwards inbound messages to pgmq (F-02's queue). | **Build order:** F-01's WhatsApp pairing is independent. History import requires `messages` table + `clients` table to exist. Stub if F-02 not ready. |
| **F-03 (Client Identity)** | History import creates client records by phone number. | Stub client creation if F-03 not ready. |
| **Supabase Auth** | Owner must be authenticated before onboarding starts. `auth.workspace_id()` function must exist. | Infrastructure prerequisite. |
| **`embed-knowledge` Edge Function** | Defined in architecture section 3.1. F-01 invokes it to index the knowledge base. | Can be built as part of F-01 if not yet implemented. |

### 7.3 Infrastructure Required Before F-01

| Component | Notes |
|-----------|-------|
| Supabase project with Auth, pgvector, pgmq enabled | Must exist. |
| Database migrations applied (`workspaces`, `staff`, `knowledge_chunks`) | Part of F-01 scope. |
| `auth.workspace_id()` function | Part of `002_rls_policies.sql`. |
| Anthropic API key (Claude Sonnet 4) | Must be provisioned and set as Edge Function secret. |
| OpenAI API key (embeddings) | Must be provisioned and set as Edge Function secret. |
| Node.js host for Baileys (Railway) | Must be provisioned. This is the only non-Supabase/Vercel infrastructure. |

---

## 8. Implementation Sequence

```
Phase A -- Foundation (3-4 days)
  1. Database migrations: workspaces, staff, knowledge_chunks + F-01 columns
  2. RLS policies + auth.workspace_id() function
  3. Supabase Auth integration (register, login)
  4. Onboarding step state machine (use-onboarding hook)
  5. Onboarding layout + step indicator UI

Phase B -- WhatsApp Pairing (3-4 days)
  6. Deploy Baileys Node.js service to Railway
  7. Baileys HTTP API: init, refresh-qr, status
  8. Next.js SSE route for QR + pairing events
  9. QrCodeDisplay component + pairing flow page
  10. Auth state encryption + DB persistence
  11. History import (background, non-blocking)

Phase C -- Business Identity + Instagram (2-3 days)
  12. Identity form page + API route
  13. Instagram scraper (_shared/instagram-scraper.ts)
  14. onboarding-scrape Edge Function + LLM prompt
  15. Knowledge editor page (markdown editor + draft review)
  16. embed-knowledge Edge Function (chunk + embed + upsert)

Phase D -- SOPs (3-4 days)
  17. deep-research-sop prompt template
  18. onboarding-sops Edge Function (generation + refinement)
  19. SOP generation page + SopReviewCard components
  20. sop-refinement prompt template
  21. Conversational refinement page + ConversationalEditor
  22. confirm-sops API route

Phase E -- Tone + Activation (2-3 days)
  23. tone-extraction + tone-adjustment prompt templates
  24. onboarding-tone Edge Function
  25. Tone profile page + adjustment flow
  26. Summary page + activation route
  27. Progressive capability calculation
  28. End-to-end testing of full onboarding flow

Total estimate: 13-18 days (XL sizing confirmed)
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

| Component | Focus |
|-----------|-------|
| Onboarding step state machine | Valid transitions, invalid transitions throw, resume from any step |
| Zod schemas for all request bodies | Required fields, timezone validation, IG handle normalization, VerticalConfig validation |
| Instagram scraper parser | Parse various HTML/JSON response shapes, handle 404, private profiles, empty content |
| Knowledge chunking logic | Split markdown by headings, respect ~500 token target, handle empty input |
| WhatsApp credential encryption | Encrypt/decrypt round-trip, handle corrupted input gracefully |

### 9.2 Integration Tests

| Test | Scope |
|------|-------|
| Full onboarding happy path | Start -> QR pair (mocked Baileys) -> identity -> scrape (mocked HTTP) -> KB save -> SOP gen (mocked LLM) -> refine -> tone -> activate. Verify DB state at each step. |
| Resume onboarding after disconnect | Create workspace at step 3, call status endpoint, verify correct resume data. |
| Knowledge indexing | Save KB, trigger embed-knowledge, verify chunks in `knowledge_chunks`, verify vector search returns relevant results. |
| LLM fallback paths | Mock LLM timeout -> verify minimal config returned. Mock invalid JSON -> verify retry + fallback. |

### 9.3 E2E Tests

| Test | Coverage |
|------|----------|
| Onboarding wizard navigation | Step indicator updates, back navigation, forward progress preserved |
| QR code display and refresh | QR renders, expiry message, refresh generates new QR |
| Knowledge base editing | Edit markdown, preview, save persists |
| Conversational SOP editing | Type instruction, see updated config, multiple rounds |

---

## 10. Security Considerations

| Concern | Mitigation |
|---------|------------|
| WhatsApp session credentials | Encrypted at rest (AES-256-GCM). Per-workspace key. Never in API responses or logs. |
| Baileys process exposure | Baileys HTTP API authenticated with a shared secret (not public). Only accessible from Next.js API routes. |
| Instagram scraping abuse | Rate limit: max 3 scrape attempts per workspace per hour. Only during onboarding. |
| LLM prompt injection | User content in delimited sections. JSON outputs validated via Zod. Text outputs length-limited. |
| Tenant isolation | `auth.workspace_id()` RLS on all tables. Edge Functions use service_role only for background writes. |
| Onboarding endpoint authorization | Every route verifies workspace ownership via `auth.workspace_id() = workspaceId` before processing. |
