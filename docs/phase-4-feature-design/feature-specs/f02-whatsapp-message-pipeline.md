# Feature Spec -- F-02: WhatsApp Message Pipeline

**Feature:** F-02 WhatsApp Message Pipeline
**Phase:** 1 (Core Messaging & Onboarding)
**Size:** L (1-2 weeks)
**Status:** Implementable spec
**PRD Functions:** MP-01, MP-02, MP-06, MP-07, MP-08, MP-09, CS-01
**User Stories:** F02-S01 through F02-S08
**Base Architecture:** `architecture-final.md` (pgmq, Edge Functions, flat codebase)
**WhatsApp Integration:** WhatsApp Web protocol via Baileys (QR code pairing), NOT Meta Cloud API

---

## 0. Architecture Note: WhatsApp Web Protocol

The final architecture was updated to specify **Baileys v6+ (QR code pairing)** per PRD requirements (confirmed by PRD owner; see `phase-3-architecture/CLAUDE.md`). No WABA/Cloud API is used. This has one structural consequence:

**Baileys requires a persistent Node.js process.** WhatsApp Web maintains a long-lived WebSocket connection. This cannot run inside Supabase Edge Functions (stateless, 150s timeout, Deno runtime). The solution is a lightweight **WhatsApp Bridge** service -- a single Node.js process that:

1. Manages Baileys socket connections (one per workspace).
2. Receives WhatsApp Web protocol events (messages, delivery status, disconnections).
3. Enqueues messages to pgmq via Supabase client (same queue as the final architecture).
4. Exposes a small HTTP API for session management (QR code, disconnect) and outbound sending.

Everything downstream of the pgmq enqueue point remains exactly as specified in `architecture-final.md`: the `process-message` Edge Function dequeues from pgmq, runs the pipeline, invokes the LLM, etc. The bridge replaces only the `whatsapp-webhook` Edge Function and the `send-message` Edge Function's WhatsApp API calls.

**Deployment:** The bridge runs on Railway. It is the only additional infrastructure beyond Supabase + Vercel.

```
BEFORE (Cloud API):                     AFTER (WhatsApp Web):

Meta Cloud API                          WhatsApp Web Protocol (Baileys)
     |                                        |
     v                                        v
Edge Function:                          WhatsApp Bridge (Node.js)
whatsapp-webhook                        - Baileys socket per workspace
- Verify HMAC                           - Message listener
- Deduplicate                           - Dedup (message_inbox INSERT)
- pgmq.send()                           - pgmq.send() via Supabase client
     |                                        |
     v                                        v
     +-------- SAME FROM HERE DOWN -----------+
     |
  pgmq: inbound_messages
     |
  Edge Function: process-message
     |
  (normalize, client lookup, store, context assembly, LLM, etc.)
```

**What this removes:**
- `whatsapp-webhook` Edge Function (replaced by bridge message listener)
- `send-message` Edge Function's WhatsApp API call (replaced by bridge HTTP endpoint)
- HMAC webhook signature verification (not applicable -- no webhooks)
- 24-hour messaging window checks (not applicable -- WhatsApp Web has no window restrictions)
- Template message fallback (not applicable -- WhatsApp Web sends freeform)
- `whatsapp_phone_number_id`, `whatsapp_access_token`, `whatsapp_webhook_secret` workspace columns (replaced by session credentials)

**What this adds:**
- WhatsApp Bridge service (Node.js)
- `whatsapp_sessions` table
- QR code pairing flow (API + UI)
- Session credential storage (encrypted)
- Auto-reconnection logic
- History import on first connection

---

## 1. Component Breakdown

Files follow the flat codebase structure from `architecture-final.md` section 13. The WhatsApp Bridge is a separate deployable.

### 1.1 New: WhatsApp Bridge Service

```
whatsapp-bridge/
  src/
    index.ts                         # HTTP server + Baileys lifecycle
    session-manager.ts               # Manages Baileys sockets per workspace
    message-listener.ts              # Handles messages.upsert events, enqueues to pgmq
    message-sender.ts                # Sends outbound via Baileys socket
    delivery-status-handler.ts       # Handles messages.update (delivery receipts)
    history-importer.ts              # Batch import of existing conversations
    auth-state-store.ts              # Supabase-backed Baileys auth state persistence
    phone-utils.ts                   # E.164 normalization (same logic as Edge Function)
    dedup.ts                         # message_inbox INSERT for dedup check
    health-check.ts                  # Periodic socket health verification
    routes.ts                        # HTTP endpoints (QR, status, send, disconnect)
    types.ts                         # Shared types
  package.json
  Dockerfile
  railway.toml                       # Railway deployment config
```

### 1.2 New: Supabase Edge Functions

```
supabase/functions/
  process-message/
    index.ts                         # (same as architecture-final.md -- dequeue from pgmq, run pipeline)
                                     # Modified: skip 24h window check, no template fallback
```

The `process-message` Edge Function exists in the final architecture. F-02 implements the portion of it that runs before AI invocation (steps 1-6 in the data flow). Steps 7-14 (context assembly, LLM, approval) are implemented by F-05.

### 1.3 New: Supabase Shared Utilities

```
supabase/functions/_shared/
  phone-utils.ts                     # E.164 normalization (used by process-message)
  session-key.ts                     # buildSessionKey(workspaceId, clientId) pure function
```

### 1.4 New: Next.js Pages and API Routes

```
src/
  app/
    (dashboard)/
      settings/
        whatsapp/
          page.tsx                   # WhatsApp session management UI (QR code, status)
  components/
    settings/
      whatsapp-session-card.tsx      # QR code display, status indicator, reconnect button
    thread/
      delivery-status-badge.tsx      # Sent/delivered/read/failed indicator
      message-bubble.tsx             # Modified: add is_imported visual indicator
  lib/
    whatsapp-bridge.ts               # HTTP client for bridge API calls
```

### 1.5 New: Supabase Migration

```
supabase/migrations/
  004_whatsapp_sessions.sql          # whatsapp_sessions table, message_inbox modifications
```

### 1.6 Modified Files

| File | Modification |
|------|-------------|
| `supabase/migrations/001_initial_schema.sql` | Replace `whatsapp_phone_number_id`, `whatsapp_access_token`, `whatsapp_webhook_secret` workspace columns with FK to `whatsapp_sessions` |
| `supabase/functions/process-message/index.ts` | Remove 24h window check. Remove template fallback. Add `is_imported` check to skip AI drafting. |
| `supabase/functions/_shared/types.ts` | Add WhatsApp session types, import flag on message |
| `src/app/(dashboard)/settings/page.tsx` | Add WhatsApp session management link |

---

## 2. Data Model

All tables follow the naming and conventions from `architecture-final.md` section 9. Column names use the `id` shorthand (not `workspace_id` as PK) matching the final schema.

### 2.1 Modified: `workspaces` Table

Remove Cloud API columns. Add reference to session table.

```sql
-- Remove these columns from workspaces:
--   whatsapp_phone_number_id TEXT
--   whatsapp_access_token TEXT
--   whatsapp_webhook_secret TEXT

-- The whatsapp_sessions table (below) is the source of truth for WhatsApp config.
-- No FK needed on workspaces -- the session table references workspaces.
```

### 2.2 New: `whatsapp_sessions` Table

```sql
CREATE TABLE whatsapp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id),
  connection_status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (connection_status IN ('disconnected', 'connecting', 'connected', 'reconnecting')),
  auth_credentials JSONB,              -- Baileys auth state, encrypted at app layer
  last_qr_scan_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  last_disconnected_at TIMESTAMPTZ,
  disconnect_reason TEXT,              -- 'logout', 'network', 'expired'
  history_import_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (history_import_status IN ('pending', 'in_progress', 'complete', 'failed')),
  history_import_progress JSONB,       -- { "processed": 0, "total": 0 }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_whatsapp_sessions_status ON whatsapp_sessions(connection_status);
```

**RLS:** Same pattern as all other tables:

```sql
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace isolation" ON whatsapp_sessions
  FOR ALL USING (workspace_id = auth.workspace_id());
```

### 2.3 Modified: `messages` Table

Add columns for WhatsApp Web-specific fields:

```sql
-- Add to messages table (from architecture-final.md section 9):
ALTER TABLE messages ADD COLUMN is_imported BOOLEAN NOT NULL DEFAULT false;

-- Note: the 'wamid' column already exists in the final schema.
-- It stores the WhatsApp-native message ID (same field works for Web protocol).
```

The `wamid` column name stays the same. In Baileys, the equivalent is `message.key.id`.

### 2.4 Existing: `message_inbox` Deduplication Table

Already defined in `architecture-final.md`. No changes needed:

```sql
-- Already exists:
CREATE TABLE message_inbox (
  wamid TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.5 Existing: `conversations` Table

No schema changes. The `state` column values and behavior are identical. The only difference is that WhatsApp Web has no 24-hour messaging window, so the `last_client_message_at` column is still stored but not used for window-gating.

### 2.6 Existing: `clients` Table

No schema changes. The `UNIQUE(workspace_id, phone)` constraint provides the client-matching key.

### 2.7 Full Migration: `004_whatsapp_sessions.sql`

```sql
-- Migration: 004_whatsapp_sessions.sql
-- Purpose: WhatsApp Web session management (Baileys protocol)

-- 1. Create whatsapp_sessions table
CREATE TABLE whatsapp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id),
  connection_status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (connection_status IN ('disconnected', 'connecting', 'connected', 'reconnecting')),
  auth_credentials JSONB,
  last_qr_scan_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  last_disconnected_at TIMESTAMPTZ,
  disconnect_reason TEXT,
  history_import_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (history_import_status IN ('pending', 'in_progress', 'complete', 'failed')),
  history_import_progress JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_whatsapp_sessions_status ON whatsapp_sessions(connection_status);

-- 2. Add is_imported flag to messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_imported BOOLEAN NOT NULL DEFAULT false;

-- 3. Remove Cloud API columns from workspaces (if they exist)
ALTER TABLE workspaces DROP COLUMN IF EXISTS whatsapp_phone_number_id;
ALTER TABLE workspaces DROP COLUMN IF EXISTS whatsapp_access_token;
ALTER TABLE workspaces DROP COLUMN IF EXISTS whatsapp_webhook_secret;

-- 4. RLS on whatsapp_sessions
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace isolation" ON whatsapp_sessions
  FOR ALL USING (workspace_id = auth.workspace_id());

-- 5. Create pgmq queue for history import (separate from inbound_messages)
SELECT pgmq.create('history_import');
SELECT pgmq.create('history_import_dlq');
```

---

## 3. API Endpoints

### 3.1 WhatsApp Bridge HTTP API

The bridge exposes a small HTTP API. Requests are authenticated via a shared secret (`BRIDGE_API_SECRET`) passed in the `Authorization` header. The bridge is not internet-facing -- only the Next.js app and Edge Functions call it.

#### `POST /session/connect`

Initiates Baileys socket, returns QR code.

**Request:** `{ "workspace_id": "uuid" }`

**Response:**
```json
{
  "qr_code": "2@abc...xyz",
  "session_id": "uuid",
  "status": "connecting",
  "expires_in_seconds": 60
}
```

The `qr_code` value is the raw QR string from Baileys. The Next.js frontend renders it as a QR image using a client-side library (e.g., `qrcode.react`).

#### `GET /session/status?workspace_id=uuid`

Returns current session health.

**Response:**
```json
{
  "connection_status": "connected",
  "last_connected_at": "2026-03-18T10:00:00Z",
  "history_import_status": "complete",
  "history_import_progress": { "processed": 50000, "total": 50000 }
}
```

#### `POST /session/disconnect`

Gracefully closes the Baileys socket.

**Request:** `{ "workspace_id": "uuid" }`

**Response:** `{ "status": "disconnected" }`

#### `POST /message/send`

Sends an outbound message via the connected Baileys socket.

**Request:**
```json
{
  "workspace_id": "uuid",
  "phone": "+61412345678",
  "content": "Hello, your appointment is confirmed.",
  "wamid_ref": "optional-client-generated-id"
}
```

**Response:**
```json
{
  "wamid": "3EB0...",
  "status": "sent",
  "timestamp": "2026-03-18T10:30:00Z"
}
```

**Error (session disconnected):**
```json
{
  "error": "session_disconnected",
  "message": "WhatsApp session is not connected. Re-scan QR code."
}
```

#### `POST /session/qr-refresh`

Generates a fresh QR code if the previous one expired.

**Request:** `{ "workspace_id": "uuid" }`

**Response:** Same shape as `POST /session/connect`.

### 3.2 Next.js API Routes (Staff App)

These are thin proxies to the bridge, with Supabase Auth enforcement.

#### `POST /api/whatsapp/connect`

Staff-facing endpoint. Validates auth, extracts workspace_id from JWT, calls bridge `POST /session/connect`.

#### `GET /api/whatsapp/status`

Staff-facing endpoint. Returns session status from `whatsapp_sessions` table (reads directly from Supabase, no bridge call needed for read).

#### `POST /api/whatsapp/disconnect`

Staff-facing endpoint. Calls bridge `POST /session/disconnect`.

#### `POST /api/messages/send`

Staff-facing endpoint for sending approved outbound messages.

**Request:**
```json
{
  "conversation_id": "uuid",
  "content": "Hello, your appointment is confirmed.",
  "draft_id": "uuid | null"
}
```

**Behavior:**
1. Read conversation to get client phone.
2. Check `whatsapp_sessions.connection_status` = 'connected'.
3. Call bridge `POST /message/send`.
4. On success: INSERT message record (direction: outbound, sender_type: staff, wamid from bridge response).
5. Update `conversations.last_message_at`.
6. Return message record.

#### `GET /api/conversations/:id/messages`

Paginated message history. Cursor-based pagination using `created_at`.

**Query params:** `?limit=50&before=<timestamp>`

**Response:**
```json
{
  "messages": [...],
  "has_more": true,
  "next_cursor": "2026-03-18T08:59:00Z"
}
```

#### `POST /api/messages/:id/retry`

Retries a failed outbound message.

### 3.3 Supabase Realtime (replacing SSE)

Per `architecture-final.md` section 14, the staff app uses Supabase Realtime for push updates. F-02 emits these events via database INSERTs/UPDATEs (Realtime triggers automatically on table changes):

| Event Source | Table Change | Staff App Receives |
|---|---|---|
| New inbound message stored | INSERT on `messages` | "New message" notification (< 1s) |
| Delivery status update | UPDATE on `messages.delivery_status` | Status badge change |
| Session status change | UPDATE on `whatsapp_sessions.connection_status` | Banner: "WhatsApp disconnected" |
| Import progress | UPDATE on `whatsapp_sessions.history_import_progress` | Progress indicator |

No custom SSE endpoint needed. Supabase Realtime handles all push via the existing `useRealtimeInbox` hook pattern from the final architecture.

---

## 4. Key Implementation Details

### 4.1 WhatsApp Web Library: Baileys

**Package:** `@whiskeysockets/baileys` (actively maintained multi-device fork)

**Why Baileys:**
- Native WhatsApp Web multi-device protocol (no Chromium/Puppeteer).
- Full access to existing conversations, contacts, and message history.
- No WABA application required. No 24-hour window restriction. No template requirement.
- Owner scans QR code to pair their existing WhatsApp account.

**Socket initialization (session-manager.ts):**

```typescript
import makeWASocket, {
  DisconnectReason,
  WASocket,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";

class SessionManager {
  private sockets: Map<string, WASocket> = new Map();
  private supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  async connect(workspaceId: string): Promise<{ qrCode?: string }> {
    const authState = await this.loadAuthState(workspaceId);

    const socket = makeWASocket({
      auth: authState.state,
      printQRInTerminal: false,
    });

    socket.ev.on("creds.update", authState.saveCreds);

    socket.ev.on("connection.update", (update) =>
      this.handleConnectionUpdate(workspaceId, update)
    );

    socket.ev.on("messages.upsert", (msg) =>
      this.messageListener.onMessages(workspaceId, msg)
    );

    socket.ev.on("messages.update", (updates) =>
      this.deliveryStatusHandler.onUpdates(workspaceId, updates)
    );

    this.sockets.set(workspaceId, socket);
    // QR code returned via connection.update callback
  }
}
```

**Auth state persistence (auth-state-store.ts):**

Baileys auth state is stored in `whatsapp_sessions.auth_credentials`. The default file-based `useMultiFileAuthState` is replaced with a Supabase-backed implementation:

```typescript
async function useSupabaseAuthState(
  workspaceId: string,
  supabase: SupabaseClient
) {
  const { data } = await supabase
    .from("whatsapp_sessions")
    .select("auth_credentials")
    .eq("workspace_id", workspaceId)
    .single();

  const creds = data?.auth_credentials
    ? decryptCredentials(data.auth_credentials)
    : initAuthCreds();

  return {
    state: { creds, keys: makeInMemoryStore() },
    saveCreds: async () => {
      const encrypted = encryptCredentials(creds);
      await supabase
        .from("whatsapp_sessions")
        .update({
          auth_credentials: encrypted,
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId);
    },
  };
}
```

**Credential encryption:** Auth credentials are encrypted with AES-256-GCM using a key derived from `WHATSAPP_CREDENTIAL_SECRET` before storage. Supabase database encryption provides an additional layer at rest.

### 4.2 Message Queue: pgmq

Per `architecture-final.md` section 8.2. The bridge enqueues to pgmq using the Supabase JS client (calling an RPC wrapper function or using the `pgmq` extension directly via SQL).

**Enqueue from bridge (message-listener.ts):**

```typescript
async function enqueueInbound(
  workspaceId: string,
  rawMessage: BaileysMessage
): Promise<void> {
  const wamid = rawMessage.key.id;

  // Layer 1 dedup: INSERT to message_inbox
  const { data } = await supabase.rpc("dedup_and_enqueue", {
    p_wamid: wamid,
    p_workspace_id: workspaceId,
    p_phone: rawMessage.key.remoteJid?.replace(/@.*$/, ""),
    p_body: rawMessage.message?.conversation
      || rawMessage.message?.extendedTextMessage?.text
      || null,
    p_media_type: detectMediaType(rawMessage),
    p_timestamp: rawMessage.messageTimestamp,
    p_is_imported: false,
  });

  // data.enqueued = true if new, false if duplicate
  if (!data?.enqueued) {
    console.log(`Dedup: skipped duplicate wamid=${wamid}`);
  }
}
```

**Supabase RPC function for atomic dedup + enqueue:**

```sql
-- Atomic dedup check + pgmq enqueue in one transaction
CREATE OR REPLACE FUNCTION dedup_and_enqueue(
  p_wamid TEXT,
  p_workspace_id UUID,
  p_phone TEXT,
  p_body TEXT,
  p_media_type TEXT,
  p_timestamp BIGINT,
  p_is_imported BOOLEAN DEFAULT false
) RETURNS JSONB AS $$
DECLARE
  v_inserted BOOLEAN;
BEGIN
  -- Dedup check
  INSERT INTO message_inbox (wamid, workspace_id)
  VALUES (p_wamid, p_workspace_id)
  ON CONFLICT (wamid) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('enqueued', false);
  END IF;

  -- Enqueue to pgmq
  PERFORM pgmq.send(
    'inbound_messages',
    jsonb_build_object(
      'wamid', p_wamid,
      'workspace_id', p_workspace_id,
      'phone_number', p_phone,
      'message_body', p_body,
      'media_type', p_media_type,
      'whatsapp_timestamp', p_timestamp,
      'is_imported', p_is_imported
    )
  );

  RETURN jsonb_build_object('enqueued', true);
END;
$$ LANGUAGE plpgsql;
```

**Per-client ordering:** Same as `architecture-final.md` section 8.2. The `process-message` Edge Function acquires an advisory lock:

```sql
SELECT pg_try_advisory_lock(hashtext($session_key));
```

If the lock is held, the message stays in pgmq and becomes visible again after the 60s visibility timeout.

**Retry + DLQ:** pgmq tracks `read_ct` automatically. After 3 failed attempts (`read_ct > 3`), the worker moves the message to `inbound_dlq`.

### 4.3 Deduplication Strategy

Two-layer dedup, same as the final architecture:

**Layer 1 -- At enqueue time (Postgres `message_inbox` table):**
The `dedup_and_enqueue` RPC function performs an `INSERT ... ON CONFLICT DO NOTHING`. If the `wamid` already exists, no pgmq message is created. This is ACID-consistent with the enqueue operation.

**Layer 2 -- At storage time (unique index on `messages.wamid`):**
When `process-message` inserts the message record, the `idx_messages_wamid` index catches any duplicate that slipped through Layer 1 (e.g., if the bridge crashed between dedup check and enqueue, and the message was retried).

**Why two layers:**
- Layer 1 prevents unnecessary pgmq jobs.
- Layer 2 is the authoritative guard and survives any timing issues.
- Together they provide exactly-once storage.

### 4.4 Phone Number Normalization

**Library:** `libphonenumber-js`

The normalization logic exists in two places (bridge + Edge Function `_shared/`) because the bridge (Node.js) and Edge Functions (Deno) have separate runtimes. `libphonenumber-js` works in both environments.

```typescript
// phone-utils.ts (identical copy in bridge and _shared/)

import { parsePhoneNumber, type CountryCode } from "libphonenumber-js";

type NormalizeResult =
  | { success: true; e164: string }
  | { success: false; error: string; raw: string };

export function normalizePhone(
  raw: string,
  defaultCountry: CountryCode
): NormalizeResult {
  // Baileys JIDs: "61412345678@s.whatsapp.net" -> strip suffix
  const stripped = raw.replace(/@.*$/, "").replace(/[^+\d]/g, "");
  const withPlus = stripped.startsWith("+") ? stripped : `+${stripped}`;

  try {
    const parsed = parsePhoneNumber(withPlus, defaultCountry);
    if (!parsed?.isValid()) {
      return { success: false, error: "INVALID_PHONE", raw };
    }
    return { success: true, e164: parsed.format("E.164") };
  } catch {
    return { success: false, error: "PARSE_FAILED", raw };
  }
}
```

**Country context:** Derived from workspace `timezone` field:

```typescript
const TIMEZONE_TO_COUNTRY: Record<string, CountryCode> = {
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "America/New_York": "US",
  "America/Los_Angeles": "US",
  "Europe/London": "GB",
  // Extensible per deployment
};
```

**Invalid numbers:** Normalization failure causes the message to be moved to `inbound_dlq` after retry exhaustion. The pgmq `read_ct > 3` check triggers the DLQ move.

### 4.5 Session Key Resolution

```typescript
// session-key.ts

export function buildSessionKey(workspaceId: string, clientId: string): string {
  return `workspace:${workspaceId}:client:${clientId}`;
}

export function parseSessionKey(key: string): {
  workspaceId: string;
  clientId: string;
} {
  const match = key.match(/^workspace:(.+):client:(.+)$/);
  if (!match) throw new Error(`Invalid session key: ${key}`);
  return { workspaceId: match[1], clientId: match[2] };
}
```

Used by `process-message` to:
1. Build the advisory lock key: `hashtext(session_key)`.
2. Scope all database queries: `WHERE workspace_id = $1 AND client_id = $2`.

### 4.6 History Import

**Trigger:** After first successful QR connection, when `whatsapp_sessions.history_import_status = 'pending'`.

Baileys fires a `messaging-history.set` event (or delivers historical messages via `messages.upsert` with `type: 'append'`) during the initial sync after QR pairing.

**Implementation (history-importer.ts):**

```typescript
class HistoryImporter {
  private readonly BATCH_SIZE = 100;
  private readonly RATE_LIMIT_MS = 20; // ~50 msg/sec

  async importAll(workspaceId: string, socket: WASocket): Promise<void> {
    await this.updateStatus(workspaceId, "in_progress");

    try {
      const chats = await this.getChats(socket);
      let total = 0;
      let processed = 0;

      // Count total (excluding group chats)
      for (const chat of chats) {
        if (!chat.id.endsWith("@g.us")) {
          total += chat.messages?.length ?? 0;
        }
      }
      await this.updateProgress(workspaceId, { processed: 0, total });

      for (const chat of chats) {
        if (chat.id.endsWith("@g.us")) continue; // Skip groups

        const batches = chunk(chat.messages ?? [], this.BATCH_SIZE);
        for (const batch of batches) {
          // Enqueue each message through the same dedup_and_enqueue function
          for (const msg of batch) {
            await this.supabase.rpc("dedup_and_enqueue", {
              p_wamid: msg.key.id,
              p_workspace_id: workspaceId,
              p_phone: chat.id.replace(/@.*$/, ""),
              p_body: msg.message?.conversation || null,
              p_media_type: detectMediaType(msg),
              p_timestamp: msg.messageTimestamp,
              p_is_imported: true, // <-- skips AI drafting downstream
            });
          }

          processed += batch.length;
          await this.updateProgress(workspaceId, { processed, total });

          // Rate limit to avoid overwhelming pgmq + Edge Functions
          await sleep(this.RATE_LIMIT_MS * batch.length);
        }
      }

      await this.updateStatus(workspaceId, "complete");
    } catch (error) {
      await this.updateStatus(workspaceId, "failed");
      throw error;
    }
  }
}
```

**Priority:** History import messages are enqueued to the same `inbound_messages` pgmq queue with `is_imported: true`. The `process-message` Edge Function processes them through the same pipeline (normalize, client find-or-create, store) but checks `is_imported` and skips AI draft generation.

An alternative is a separate `history_import` pgmq queue with lower processing priority. This is preferred for large accounts:

```sql
-- Separate queue for history import
SELECT pgmq.create('history_import');

-- pg_cron processes history_import less frequently than inbound_messages
SELECT cron.schedule(
  'process-history-import',
  '*/2 * * * *',  -- every 2 minutes (vs every 1 minute for live)
  $$ SELECT net.http_post(...) $$
);
```

**Decision: Use separate queue.** This ensures live messages always have priority. The bridge enqueues history to `history_import`; live messages go to `inbound_messages`.

### 4.7 Session Health Monitoring

**Event-driven (primary):**

```typescript
// session-manager.ts

private async handleConnectionUpdate(
  workspaceId: string,
  update: Partial<ConnectionState>
): Promise<void> {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    // Store QR string for polling by frontend
    this.pendingQRs.set(workspaceId, qr);
    await this.updateSession(workspaceId, {
      connection_status: "connecting",
      last_qr_scan_at: new Date().toISOString(),
    });
  }

  if (connection === "open") {
    await this.onConnected(workspaceId);
  }

  if (connection === "close") {
    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
    const isLoggedOut = statusCode === DisconnectReason.loggedOut;

    await this.onDisconnected(workspaceId, {
      reason: isLoggedOut ? "logout" : "network",
      shouldReconnect: !isLoggedOut,
    });

    if (!isLoggedOut) {
      // Auto-reconnect with stored credentials
      setTimeout(() => this.connect(workspaceId), 3000);
    }
  }
}

private async onConnected(workspaceId: string): Promise<void> {
  await this.updateSession(workspaceId, {
    connection_status: "connected",
    last_connected_at: new Date().toISOString(),
    disconnect_reason: null,
  });

  // Trigger history import on first connection
  const session = await this.getSession(workspaceId);
  if (session.history_import_status === "pending") {
    this.historyImporter.importAll(workspaceId, this.sockets.get(workspaceId)!);
  }
}

private async onDisconnected(
  workspaceId: string,
  opts: { reason: string; shouldReconnect: boolean }
): Promise<void> {
  const status = opts.shouldReconnect ? "reconnecting" : "disconnected";

  await this.updateSession(workspaceId, {
    connection_status: status,
    last_disconnected_at: new Date().toISOString(),
    disconnect_reason: opts.reason,
  });

  // If not reconnecting within 30s, the Supabase Realtime update
  // on whatsapp_sessions.connection_status will trigger the staff app
  // to show "WhatsApp disconnected" banner.
  // No separate push notification mechanism needed -- Realtime handles it.

  if (opts.shouldReconnect) {
    // If still disconnected after 30s, staff sees it via Realtime
    setTimeout(async () => {
      const current = await this.getSession(workspaceId);
      if (current.connection_status !== "connected") {
        await this.updateSession(workspaceId, {
          connection_status: "disconnected",
        });
      }
    }, 30_000);
  }
}
```

**Periodic health check (safety net):**

```typescript
// health-check.ts -- runs every 60s in the bridge process

async function periodicHealthCheck(sessionManager: SessionManager) {
  const { data: sessions } = await supabase
    .from("whatsapp_sessions")
    .select("workspace_id")
    .eq("connection_status", "connected");

  for (const { workspace_id } of sessions ?? []) {
    const socket = sessionManager.getSocket(workspace_id);
    if (!socket || socket.ws?.readyState !== 1 /* OPEN */) {
      await sessionManager.onDisconnected(workspace_id, {
        reason: "stale_connection",
        shouldReconnect: true,
      });
    }
  }
}

setInterval(() => periodicHealthCheck(sessionManager), 60_000);
```

**Server restart recovery:**

On startup, the bridge queries `whatsapp_sessions` for all rows with `connection_status IN ('connected', 'reconnecting')` and attempts to reconnect each using stored credentials:

```typescript
// index.ts -- bridge startup

async function restoreActiveSessions(): Promise<void> {
  const { data: sessions } = await supabase
    .from("whatsapp_sessions")
    .select("workspace_id")
    .in("connection_status", ["connected", "reconnecting"]);

  for (const { workspace_id } of sessions ?? []) {
    console.log(`Restoring session for workspace ${workspace_id}`);
    await sessionManager.connect(workspace_id);
  }
}
```

### 4.8 Delivery Status Tracking

```typescript
// delivery-status-handler.ts

class DeliveryStatusHandler {
  private STATUS_RANK: Record<string, number> = {
    sent: 1,
    delivered: 2,
    read: 3,
  };

  async onUpdates(workspaceId: string, updates: WAMessageUpdate[]): Promise<void> {
    for (const update of updates) {
      const wamid = update.key.id;
      if (!wamid) continue;

      const newStatus = this.mapStatus(update.update?.status);
      if (!newStatus) continue;

      // Fetch current message from Supabase
      const { data: message } = await this.supabase
        .from("messages")
        .select("id, delivery_status, direction")
        .eq("wamid", wamid)
        .single();

      if (!message || message.direction !== "outbound") continue;

      // Forward-only progression (handle out-of-order receipts)
      const currentRank = this.STATUS_RANK[message.delivery_status] ?? 0;
      const newRank = this.STATUS_RANK[newStatus] ?? 0;

      if (newStatus === "failed" || newRank > currentRank) {
        await this.supabase
          .from("messages")
          .update({ delivery_status: newStatus })
          .eq("id", message.id);
        // Supabase Realtime fires automatically on UPDATE
      }
    }
  }

  private mapStatus(status?: number): string | null {
    switch (status) {
      case 1: return "sent";       // SERVER_ACK
      case 2: return "delivered";   // DELIVERY_ACK
      case 3: return "read";        // READ
      case 4: return "read";        // PLAYED (voice notes)
      case 5: return "failed";      // ERROR
      default: return null;
    }
  }
}
```

### 4.9 Process-Message Edge Function (F-02 Scope)

The `process-message` Edge Function from `architecture-final.md` handles the full pipeline. F-02 implements steps 1-6 (up to message storage). Steps 7+ (context assembly, LLM, approval) are F-05.

**F-02 modifications to `process-message`:**

```typescript
// supabase/functions/process-message/index.ts

// Step 1: Dequeue from pgmq
const msg = await pgmq.read("inbound_messages", 60, 1);
if (!msg) return; // no pending messages

// Step 2: Acquire advisory lock for per-client ordering
const sessionKey = buildSessionKey(msg.workspace_id, clientId);
const locked = await sql`SELECT pg_try_advisory_lock(hashtext(${sessionKey}))`;
if (!locked) return; // another worker has this client; message retries after VT

try {
  // Step 3: Normalize phone number
  const workspace = await getWorkspace(msg.workspace_id);
  const country = timezoneToCountry(workspace.timezone);
  const normalized = normalizePhone(msg.phone_number, country);

  if (!normalized.success) {
    // Move to DLQ after retries exhausted
    if (msg.read_ct > 3) {
      await pgmq.send("inbound_dlq", msg);
      await pgmq.archive("inbound_messages", msg.msg_id);
    }
    return; // will retry via visibility timeout
  }

  // Step 4: Client find-or-create
  const client = await findOrCreateClient(msg.workspace_id, normalized.e164);

  // Step 5: Conversation find-or-create
  const conversation = await findOrCreateConversation(msg.workspace_id, client.id);

  // Step 6: Store message
  await sql`
    INSERT INTO messages (conversation_id, workspace_id, direction, content,
      media_type, sender_type, delivery_status, wamid, is_imported, created_at)
    VALUES (${conversation.id}, ${msg.workspace_id}, 'inbound', ${msg.message_body},
      ${msg.media_type}, 'client', 'delivered', ${msg.wamid}, ${msg.is_imported}, now())
    ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
  `;
  -- Supabase Realtime fires on INSERT -> staff sees message immediately

  // Update conversation timestamps
  await sql`
    UPDATE conversations
    SET last_message_at = now(),
        last_client_message_at = now(),
        state = CASE WHEN state = 'idle' THEN 'awaiting_staff_review' ELSE state END
    WHERE id = ${conversation.id}
  `;

  // Update client last_contacted_at
  await sql`
    UPDATE clients SET last_contacted_at = now() WHERE id = ${client.id}
  `;

  // Step 7+: AI drafting -- ONLY if not imported
  if (!msg.is_imported) {
    // F-05 implements this: context assembly, LLM call, draft generation
    // For F-02, this is a no-op placeholder
  }

  // Archive processed message
  await pgmq.archive("inbound_messages", msg.msg_id);

} finally {
  await sql`SELECT pg_advisory_unlock(hashtext(${sessionKey}))`;
}
```

---

## 5. Edge Cases

### 5.1 Duplicate Messages

| Scenario | Handling |
|----------|----------|
| Same wamid arrives twice within seconds | Layer 1: `message_inbox` INSERT ON CONFLICT skips; no pgmq enqueue |
| Bridge crashes between dedup and enqueue | On restart, message arrives again from Baileys; Layer 1 catches it |
| message_inbox entry exists but pgmq job was lost | Message is silently dropped. This is acceptable: Baileys will re-deliver on reconnect |
| process-message crashes after dequeue but before storage | pgmq visibility timeout (60s) expires; message becomes visible for retry. Layer 2 (messages.wamid index) catches if already stored. |
| History import re-encounters already-imported message | Same two-layer dedup applies |

### 5.2 Out-of-Order Delivery

| Scenario | Handling |
|----------|----------|
| Status "read" arrives before "delivered" | `DeliveryStatusHandler` compares rank; "read" (3) > "delivered" (2), advances directly |
| Two messages from same client arrive near-simultaneously | Advisory lock ensures sequential processing; second message waits for VT expiry |
| Messages stored out of timestamp order | `messages.created_at` uses `now()` for insert time; display uses this column for ordering. WhatsApp timestamp stored separately for reference. |

### 5.3 Session Disconnect

| Scenario | Handling |
|----------|----------|
| Transient network drop (< 30s) | Auto-reconnect via stored credentials; `connection_status` briefly `reconnecting`, back to `connected`. No staff notification if < 30s. |
| Persistent failure (> 30s) | `connection_status` updated to `disconnected` via Supabase UPDATE -> Realtime pushes to staff app -> banner shown |
| User logged out from phone | `DisconnectReason.loggedOut` detected; credentials cleared; staff prompted for QR re-scan |
| Outbound send attempted while disconnected | Bridge returns `{ error: "session_disconnected" }`; Next.js shows "Re-scan QR code" prompt; draft stays approved |
| Bridge process restarts | `restoreActiveSessions()` reconnects all active workspaces using stored credentials |
| Bridge process dies permanently | `whatsapp_sessions.connection_status` remains stale. Periodic health check from bridge is gone. Mitigation: Railway auto-restarts; for monitoring, a pg_cron job can check `last_connected_at` staleness. |

### 5.4 History Import for Large Accounts

| Scenario | Handling |
|----------|----------|
| 500+ conversations, 50,000+ messages | Batched enqueue (100/batch), rate limited (~50 msg/sec), progress tracked in `history_import_progress` |
| Live messages arrive during import | Live messages go to `inbound_messages` queue (processed every 1 min via pg_cron). Import goes to `history_import` queue (processed every 2 min). Live always has priority. |
| Import interrupted by bridge restart | `history_import_status` stays `in_progress`. On restart, bridge re-examines chat history. Dedup layer prevents double-processing of already-imported messages. |
| Group chats in history | Skipped (`@g.us` JIDs filtered out) |
| Memory pressure | Streaming batch processing; never loads all messages into bridge memory at once |
| Import takes hours for very large accounts | Progress reported via `history_import_progress` Realtime updates. Staff sees "Importing history... 12,500 / 50,000" in settings. |

### 5.5 Phone Number Edge Cases

| Scenario | Handling |
|----------|----------|
| Baileys JID: `61412345678@s.whatsapp.net` | Strip `@s.whatsapp.net`, prefix `+`, parse -> `+61412345678` |
| Already has `+` prefix: `+14155551234@s.whatsapp.net` | Strip suffix, parse normally |
| Non-numeric JID (broadcast list, status updates) | Fails validation; message moves to DLQ |
| Same person, two WhatsApp numbers | Two separate client records (by design). Manual merge via F-03. |

### 5.6 Concurrent Processing

| Scenario | Handling |
|----------|----------|
| Two workers dequeue messages for same client | Advisory lock: second worker fails `pg_try_advisory_lock`, releases message back to pgmq |
| Staff sends reply while inbound is being processed | Advisory lock serializes. Outbound send waits if inbound processing holds the lock. |
| Multiple workspaces sending simultaneously | Different session keys -> different advisory locks -> full parallelism |

### 5.7 Bridge Single Point of Failure

| Scenario | Handling |
|----------|----------|
| Bridge goes down | No new inbound messages received (WhatsApp queues them server-side for ~30 days). Outbound sends fail with "session_disconnected". |
| Bridge restarts | `restoreActiveSessions()` reconnects all workspaces. Baileys replays any messages received while disconnected. |
| Bridge deployment (rolling update) | Brief disconnection; auto-reconnect on new instance startup. Messages queued by WhatsApp server are replayed. |
| Scaling beyond one bridge instance | Not needed for MVP (1-10 workspaces). Future: shard by workspace_id, each bridge instance manages a subset of workspaces. |

---

## 6. Acceptance Criteria to Tasks Mapping

### F02-S01: Inbound Message Receipt and Queue Enqueue

| AC Scenario | Tasks |
|-------------|-------|
| Text message received from WhatsApp Web session | T-01: Implement `message-listener.ts` -- subscribe to Baileys `messages.upsert`, extract message fields |
| | T-02: Implement `dedup_and_enqueue` Postgres RPC function |
| | T-03: Wire message listener to call `dedup_and_enqueue` for each received message |
| Duplicate message rejected | T-04: Verify `message_inbox` ON CONFLICT DO NOTHING behavior in integration test |
| | T-05: Add dedup logging/metrics counter |
| Sequential per-client processing | T-06: Implement advisory lock acquisition in `process-message` Edge Function |
| Message received while worker is down | T-07: Verify pgmq durability -- enqueued messages survive Edge Function downtime |

### F02-S02: Phone Number Normalization to E.164

| AC Scenario | Tasks |
|-------------|-------|
| Local format normalized | T-08: Implement `phone-utils.ts` with `normalizePhone()` using `libphonenumber-js` |
| Number already in E.164 | T-09: Handle pass-through case (with Baileys JID stripping) |
| Number with formatting characters | T-10: Strip non-numeric chars before parsing |
| Invalid phone number | T-11: Return error result; `process-message` moves to DLQ after 3 retries |
| | T-12: Implement `timezoneToCountry` mapping |

### F02-S03: Session Key Resolution

| AC Scenario | Tasks |
|-------------|-------|
| Existing client matched | T-13: Implement client lookup by `(workspace_id, phone)` in `process-message` |
| New client auto-created | T-14: Implement client INSERT with `lifecycle_status: 'open'` |
| | T-15: Implement conversation INSERT with `state: 'idle'` on new client |
| Session key scopes queries | T-16: Implement `buildSessionKey()` and `parseSessionKey()` in `session-key.ts` |
| | T-17: Use session key for advisory lock in `process-message` |

### F02-S04: Message Storage and Client Association

| AC Scenario | Tasks |
|-------------|-------|
| Inbound text message stored | T-18: INSERT into `messages` table in `process-message` |
| | T-19: UPDATE `conversations.last_message_at` and `last_client_message_at` |
| | T-20: UPDATE `clients.last_contacted_at` |
| Outbound message stored | T-21: Implement `POST /api/messages/send` Next.js route |
| | T-22: Implement `message-sender.ts` in bridge (Baileys `sendMessage()`) |
| | T-23: INSERT outbound message record after bridge confirms send |
| Message with media | T-24: Download media from Baileys, upload to Supabase Storage |
| | T-25: Set `media_type`, `media_url` on message record |
| Chronological display | T-26: Implement `GET /api/conversations/:id/messages` with cursor pagination |

### F02-S05: Session Health Monitoring and Re-authentication

| AC Scenario | Tasks |
|-------------|-------|
| Healthy session confirmed | T-27: Implement periodic health check (60s interval) in bridge |
| Session disconnection detected | T-28: Handle Baileys `connection.update` close event |
| | T-29: UPDATE `whatsapp_sessions.connection_status` -> Realtime notifies staff |
| Outbound blocked during disconnection | T-30: Check `connection_status` before calling bridge `POST /message/send` |
| QR re-scan | T-31: Implement `POST /session/connect` bridge endpoint |
| | T-32: Implement `POST /api/whatsapp/connect` Next.js proxy route |
| | T-33: Build `whatsapp-session-card.tsx` component (QR display + status) |
| Auto-reconnection | T-34: Implement Supabase-backed auth state store (`auth-state-store.ts`) |
| | T-35: Implement auto-reconnect on non-logout disconnect |
| | T-36: Implement `restoreActiveSessions()` on bridge startup |
| | T-37: 30s grace period before surfacing disconnect to staff |

### F02-S06: Delivery Status Tracking

| AC Scenario | Tasks |
|-------------|-------|
| Message sent | T-38: Map Baileys SERVER_ACK (1) to `sent` |
| Message delivered | T-39: Map Baileys DELIVERY_ACK (2) to `delivered` |
| Message read | T-40: Map Baileys READ/PLAYED (3/4) to `read` |
| Delivery fails | T-41: Map Baileys ERROR (5) to `failed` |
| Out-of-order status | T-42: Implement forward-only status progression in `delivery-status-handler.ts` |
| | T-43: Build `delivery-status-badge.tsx` component |

### F02-S07: Conversation History Import

| AC Scenario | Tasks |
|-------------|-------|
| History imported after first QR scan | T-44: Detect first connection (`history_import_status = 'pending'`) in `onConnected()` |
| | T-45: Create `history_import` pgmq queue in migration |
| Imported messages through standard pipeline | T-46: Implement `history-importer.ts` with batch enqueue |
| | T-47: Implement `process-history-import` Edge Function (or reuse `process-message` with queue param) |
| Imported messages skip AI drafting | T-48: Check `is_imported` flag in `process-message`; skip LLM invocation |
| Large volume handling | T-49: Implement batch size (100) and rate limiting (~50 msg/sec) |
| | T-50: Implement progress tracking via `history_import_progress` UPDATE |
| Import completes | T-51: UPDATE `history_import_status` to `complete` |
| Duplicate prevention during import | T-52: Same `dedup_and_enqueue` RPC handles import dedup |

### F02-S08: Deduplication and Ordering

| AC Scenario | Tasks |
|-------------|-------|
| Duplicate wamid rejected | T-04 (covered by S01) |
| Per-client sequential processing | T-06 (covered by S01) |
| Different clients concurrent | T-53: Verify parallel advisory locks in integration test |
| Optimistic lock conflict | T-54: Handle advisory lock failure in `process-message` (release message back to pgmq) |
| Failed job retry with backoff | T-55: Check `read_ct > 3` in `process-message`; move to DLQ |
| | T-56: Implement DLQ monitoring (pg_cron check for DLQ depth) |

---

## 7. Dependencies

### 7.1 NPM Packages (WhatsApp Bridge)

| Package | Version | Purpose |
|---------|---------|---------|
| `@whiskeysockets/baileys` | `^6.x` | WhatsApp Web multi-device protocol |
| `@supabase/supabase-js` | `^2.x` | Supabase client for pgmq enqueue, session table reads/writes |
| `libphonenumber-js` | `^1.x` | Phone number normalization (bridge-side pre-validation) |
| `express` | `^4.x` | HTTP server for bridge API endpoints |
| `pino` | `^9.x` | Structured logging |

### 7.2 NPM Packages (Edge Functions -- Deno)

| Package | Import | Purpose |
|---------|--------|---------|
| `libphonenumber-js` | `npm:libphonenumber-js` | Phone normalization in `process-message` |

### 7.3 NPM Packages (Next.js Staff App)

| Package | Version | Purpose |
|---------|---------|---------|
| `qrcode.react` | `^4.x` | Render QR code string from bridge as scannable image |

### 7.4 Infrastructure

| Component | Requirement | Notes |
|-----------|-------------|-------|
| Supabase (Postgres) | pgmq extension enabled | Queue for inbound messages. Already in final architecture. |
| Supabase (Realtime) | Enabled on `messages`, `whatsapp_sessions` tables | Push updates to staff app. Already in final architecture. |
| Supabase (Storage) | Media bucket | Store downloaded voice notes, images, documents. |
| WhatsApp Bridge VPS | Node.js 20+, persistent process | Railway. Single instance for MVP. |

### 7.5 Environment Variables

**WhatsApp Bridge:**
```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...           # service role key (not anon)
WHATSAPP_CREDENTIAL_SECRET=<32-byte-hex>  # AES-256-GCM key for auth state encryption
BRIDGE_API_SECRET=<random-secret>     # shared secret for Next.js -> bridge auth
BRIDGE_PORT=3001
```

**Next.js App:**
```env
WHATSAPP_BRIDGE_URL=https://bridge.fly.dev
BRIDGE_API_SECRET=<same-shared-secret>
```

**Supabase Edge Functions:**
```env
# No bridge-specific env vars needed.
# process-message reads from pgmq (same as final architecture).
```

### 7.6 Feature Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| F-01 (Onboarding) | F-02 depends on F-01 | Workspace must exist. QR scan is part of onboarding flow. |
| F-03 (Client Identity) | F-02 creates clients | `findOrCreateClient` in `process-message` creates client records. |
| F-04 (Notifications) | F-02 triggers notifications | Supabase Realtime on `messages` INSERT notifies staff. |
| F-05 (AI Drafting) | F-02 hands off to F-05 | `process-message` calls F-05's context assembly + LLM invocation after storing the message. `is_imported` flag tells F-05 to skip. |

### 7.7 Baileys-Specific Risks

**Protocol stability:** Baileys depends on reverse-engineered WhatsApp Web protocol. WhatsApp can change the protocol at any time. Mitigations:
- Pin exact Baileys version in `package.json`.
- Monitor `@whiskeysockets/baileys` GitHub for breaking changes.
- All Baileys interaction is contained within the bridge service. The rest of the system (pgmq, Edge Functions, Next.js) is protocol-agnostic.
- Wrap Baileys in adapter functions; never expose Baileys types beyond the bridge.

**Multi-device support:** Baileys v6+ supports WhatsApp multi-device. Phone does not need to stay online after initial QR scan.

**Rate limiting:** WhatsApp may throttle or ban accounts sending too many messages. Mitigations:
- Outbound rate limit: 1 message/second/workspace (enforced in bridge).
- History import rate limit: 50 messages/second (configurable).
- No bulk messaging features.

**Account ban risk:** Using unofficial APIs (Baileys) may violate WhatsApp ToS. This is a known business risk per PRD. The bridge architecture allows swapping to Cloud API later by replacing the bridge with the `whatsapp-webhook` Edge Function from `architecture-final.md` -- the rest of the system (pgmq onwards) is unchanged.

---

## 8. Testing Strategy

### 8.1 Unit Tests

| Module | Test Scope |
|--------|-----------|
| `phone-utils.ts` | E.164 normalization: Baileys JID formats, local numbers, already-E.164, invalid |
| `session-key.ts` | Build/parse round-trip, invalid key rejection |
| `delivery-status-handler.ts` | Forward-only progression, out-of-order handling, unmapped status codes |
| `dedup_and_enqueue` RPC | Duplicate rejection, successful enqueue, concurrent calls |

### 8.2 Integration Tests

| Test | Scope |
|------|-------|
| End-to-end inbound | Mock Baileys event -> bridge enqueue -> pgmq -> process-message -> stored message |
| Dedup double-layer | message_inbox conflict + messages.wamid conflict |
| Advisory lock serialization | Two concurrent process-message calls for same client; verify sequential |
| Session disconnect/reconnect | Simulate Baileys close event -> status update -> Realtime fires -> auto-reconnect |
| History import batch | Import 1000 messages; verify all stored with `is_imported = true`; verify dedup |
| Outbound send | Call bridge /message/send -> Baileys sendMessage mock -> message record created |

### 8.3 Load Tests

| Scenario | Target |
|----------|--------|
| 100 messages across 10 clients | All stored, per-client ordering verified |
| History import 50,000 messages + live messages concurrent | Live messages processed within 5s of arrival; import completes without OOM |
| Bridge restart during active sessions | All sessions restored within 30s |

---

## 9. Rollout Plan

### Phase 1: Foundation (Days 1-3)
- Migration `004_whatsapp_sessions.sql`
- `dedup_and_enqueue` RPC function
- `phone-utils.ts` + `session-key.ts` shared utilities
- pgmq queue creation: `history_import`, `history_import_dlq`

### Phase 2: WhatsApp Bridge Core (Days 4-6)
- Bridge scaffold: Node.js server, Docker, Railway deploy
- `session-manager.ts`: connect, disconnect, auth state persistence
- `auth-state-store.ts`: Supabase-backed credential storage
- `message-listener.ts`: Baileys event -> `dedup_and_enqueue`
- Bridge HTTP routes: `/session/connect`, `/session/status`, `/session/disconnect`

### Phase 3: Pipeline Integration (Days 7-8)
- `process-message` Edge Function: F-02 scope (normalize, client find-or-create, store, conversation update)
- `POST /api/messages/send` Next.js route + `message-sender.ts` bridge endpoint
- `GET /api/conversations/:id/messages` pagination endpoint

### Phase 4: Session Health + QR UI (Days 9-10)
- Connection event handling (auto-reconnect, 30s grace period)
- Periodic health check
- `restoreActiveSessions()` on bridge startup
- `whatsapp-session-card.tsx` component (QR code, status, reconnect)
- WhatsApp settings page in staff app

### Phase 5: Delivery Status + History Import (Days 11-12)
- `delivery-status-handler.ts` (Baileys status events -> messages UPDATE)
- `delivery-status-badge.tsx` component
- `history-importer.ts` (batch enqueue to `history_import` queue)
- Progress tracking via `history_import_progress` Realtime updates

### Phase 6: Hardening (Days 13-14)
- DLQ monitoring (pg_cron checks DLQ depth, alerts)
- Integration tests for all edge cases
- Load testing (concurrent messages, history import + live)
- Dedup log cleanup (pg_cron purges `message_inbox` rows > 30 days)
- Bridge health endpoint for Railway checks
