# Feature Spec — F-07: Booking & Scheduling

**Feature:** F-07
**Phase:** 2 (AI Drafting & Booking)
**Size:** XL (2+ weeks)
**PRD Functions:** BK-01, BK-02, BK-03, BK-04, BK-05, BK-06, BK-07, BK-08, BK-09, ON-07
**User Stories:** US-F07-01 through US-F07-11
**Architecture modules:** `booking-operations` (QueryAvailability, ProposeBooking, DetectConflict, GoogleCalendarGateway)
**ADR dependencies:** ADR-1 (calendar is a tool, not a separate agent), ADR-4 (booking drafts go through Client Worker)
**Depends on:** F-05 (Client Worker + context assembly), F-06 (approval workflow -- `booking_create` is a review-tier ProposedAction), F-01 (vertical_config with appointment types)
**Last updated:** March 2026

---

## Architecture alignment note

The canonical architecture (`docs/phase-3-architecture/architecture-final.md`) establishes that calendar operations are **tools within the Client Worker tool loop**, not a separate agent or service. The LLM calls `calendar_query` (read authority) and `calendar_book` (propose_write authority) during a single invocation. All booking mutations flow through the F-06 approval workflow.

Key canonical decisions this spec adheres to:

- **Edge Functions, not BullMQ** -- booking logic runs inside `process-message` (tool execution loop) and `approve-action` (booking creation on approval). Both are Supabase Edge Functions (Deno).
- **pgmq for queuing** -- retry of failed booking creation uses pgmq visibility timeout, not a separate retry mechanism.
- **Flat module structure** -- shared booking code lives in `supabase/functions/_shared/`, not in bounded-context layers.
- **Google Calendar OAuth per workspace** -- one calendar per workspace. Tokens stored encrypted in `workspace.calendar_config`. Decrypted only in Edge Functions at execution time via Supabase Vault.
- **Dynamic tool availability** -- if Google Calendar is not connected, `calendar_query` and `calendar_book` are excluded from the tool registry. The system prompt tells the LLM not to offer booking.
- **Slot proposal without locking** -- slots are checked but not locked at query time. Conflict detection runs at approval time as the final gate (architecture-final.md SS 9.2 / PRD SS 9.2).

---

## 1. Component Breakdown

### 1.1 Google Calendar Gateway (`supabase/functions/_shared/google-calendar.ts`)

The single integration point for all Google Calendar API calls. No other module calls Google Calendar directly.

**Responsibilities:**

- **Token management:** Decrypt `calendar_config` from workspace record (via Supabase Vault). Use access token for API calls. Auto-refresh using refresh token when access token expires (HTTP 401 response). Persist refreshed access token back to `workspace.calendar_config`.
- **Availability query:** Call `GET /calendars/{calendarId}/events` with `timeMin`, `timeMax`, and `singleEvents=true`. Return a flat list of busy intervals `Array<{ start: string; end: string }>`.
- **Event creation:** Call `POST /calendars/{calendarId}/events` with event details. Return the Google Calendar `eventId`.
- **Event update:** Call `PUT /calendars/{calendarId}/events/{eventId}` with updated time. Return success/failure. Used for reschedule.
- **Event deletion:** Call `DELETE /calendars/{calendarId}/events/{eventId}`. Return success/failure. Used for cancellation.
- **Error classification:** Map Google API errors to typed error codes: `token_expired`, `token_revoked`, `calendar_not_found`, `conflict`, `rate_limited`, `api_unavailable`.

```typescript
// supabase/functions/_shared/google-calendar.ts

export interface CalendarConfig {
  provider: 'google';
  calendarId: string;
  accessToken: string;   // encrypted at rest, decrypted at call time
  refreshToken: string;  // encrypted at rest, decrypted at call time
  tokenExpiresAt: string;
}

export interface BusyInterval {
  start: string; // ISO 8601 UTC
  end: string;   // ISO 8601 UTC
}

export interface CalendarEvent {
  eventId: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
}

export type CalendarErrorCode =
  | 'token_expired'
  | 'token_revoked'
  | 'calendar_not_found'
  | 'conflict'
  | 'rate_limited'
  | 'api_unavailable';

export class GoogleCalendarGateway {
  constructor(
    private config: CalendarConfig,
    private supabase: SupabaseClient,  // for persisting refreshed tokens
    private workspaceId: string
  ) {}

  async queryBusyIntervals(
    timeMin: string,
    timeMax: string
  ): Promise<BusyInterval[]>;

  async createEvent(event: {
    summary: string;
    start: string;
    end: string;
    description?: string;
  }): Promise<{ eventId: string }>;

  async updateEvent(
    eventId: string,
    update: { start: string; end: string }
  ): Promise<void>;

  async deleteEvent(eventId: string): Promise<void>;

  private async refreshAccessToken(): Promise<void>;

  private async withTokenRefresh<T>(
    fn: () => Promise<T>
  ): Promise<T>;
}
```

**Token refresh flow (`withTokenRefresh`):**

1. Execute the wrapped function.
2. If HTTP 401 returned, call `refreshAccessToken()`.
3. `refreshAccessToken()` POSTs to `https://oauth2.googleapis.com/token` with `grant_type=refresh_token`.
4. On success: update `calendar_config.accessToken` and `calendar_config.tokenExpiresAt` in the `workspaces` table (re-encrypting via Supabase Vault).
5. Retry the original function once.
6. If refresh fails (e.g., refresh token revoked): mark `calendar_config.status = 'disconnected'` on the workspace, return `CalendarError('token_revoked')`.

### 1.2 Availability Calculator (`supabase/functions/_shared/availability.ts`)

Pure, deterministic function. No API calls. Takes busy intervals + business hours + appointment type config and returns available slots.

```typescript
// supabase/functions/_shared/availability.ts

export interface AvailableSlot {
  slotId: string;       // deterministic ID: hash of start_time + appointment_type
  startTime: string;    // ISO 8601 UTC
  endTime: string;      // ISO 8601 UTC
  date: string;         // YYYY-MM-DD in workspace timezone
  dayOfWeek: string;    // 'Monday', 'Tuesday', etc.
  displayTime: string;  // formatted in workspace timezone (e.g., '10:00 AM')
}

export interface AppointmentTypeConfig {
  key: string;
  label: string;
  durationMinutes: number;
  bufferMinutes: number;
  prerequisite?: string;
}

export function calculateAvailableSlots(params: {
  busyIntervals: BusyInterval[];
  existingBookings: Array<{ start_time: string; end_time: string }>;
  businessHours: Record<string, { open: string; close: string }>;
  appointmentType: AppointmentTypeConfig;
  dateRange: { start: string; end: string };
  timezone: string;
  slotGranularityMinutes?: number; // default: 30
}): AvailableSlot[];
```

**Slot calculation algorithm:**

1. For each day in `dateRange`, determine business hours for that day of week. Skip days with no business hours (e.g., weekends if not configured).
2. Generate candidate slots at `slotGranularityMinutes` intervals (default 30 min) within business hours.
3. For each candidate slot, compute the full blocked window: `[slot.start - bufferMinutes, slot.end + bufferMinutes]`.
4. Check the blocked window against all busy intervals (from Google Calendar) AND all existing bookings (from database). If any overlap, discard the candidate.
5. Return remaining candidates as `AvailableSlot[]`.
6. All internal calculations use UTC. Display values (`date`, `dayOfWeek`, `displayTime`) are converted to the workspace timezone.

**Slot ID generation:** `slotId = deterministicHash(startTime + '|' + appointmentType.key)`. This allows the LLM to reference a specific slot by ID when calling `calendar_book`, and the system can validate that the slot was actually returned by a prior `calendar_query`.

### 1.3 Prerequisite Validator (`supabase/functions/_shared/booking-rules.ts`)

Deterministic check against the bookings table. Called before `calendar_book` creates a ProposedAction.

```typescript
// supabase/functions/_shared/booking-rules.ts

export interface PrerequisiteCheckResult {
  satisfied: boolean;
  missingPrerequisite?: {
    key: string;
    label: string;
  };
}

export async function checkPrerequisite(
  supabase: SupabaseClient,
  params: {
    workspaceId: string;
    clientId: string;
    appointmentType: AppointmentTypeConfig;
    allAppointmentTypes: AppointmentTypeConfig[];
  }
): Promise<PrerequisiteCheckResult>;
```

**Logic:**

1. If `appointmentType.prerequisite` is undefined or null, return `{ satisfied: true }`.
2. Query `bookings` table: `SELECT id FROM bookings WHERE workspace_id = $1 AND client_id = $2 AND appointment_type = $prerequisite AND status = 'completed' LIMIT 1`.
3. If a row exists, return `{ satisfied: true }`.
4. If no row, return `{ satisfied: false, missingPrerequisite: { key, label } }` where `label` is looked up from `allAppointmentTypes`.

Only bookings with status `completed` satisfy prerequisites. Statuses `confirmed`, `cancelled`, and `no_show` do not count.

### 1.4 Conflict Detector (`supabase/functions/_shared/conflict-detector.ts`)

Runs at approval time (inside `approve-action` Edge Function), not at proposal time. This is the final gate before calendar event creation.

```typescript
// supabase/functions/_shared/conflict-detector.ts

export interface ConflictCheckResult {
  hasConflict: boolean;
  conflictSource?: 'google_calendar' | 'database';
  conflictDetails?: string;
}

export async function detectConflict(
  gateway: GoogleCalendarGateway,
  supabase: SupabaseClient,
  params: {
    workspaceId: string;
    startTime: string;
    endTime: string;
    bufferMinutes: number;
    excludeBookingId?: string; // for reschedule: exclude the original booking
  }
): Promise<ConflictCheckResult>;
```

**Logic:**

1. Compute the buffered window: `[startTime - bufferMinutes, endTime + bufferMinutes]`.
2. **Google Calendar check:** Query busy intervals via `gateway.queryBusyIntervals()` for the buffered window. If any events overlap, return conflict.
3. **Database check:** Query `bookings` table for overlapping records: `SELECT id FROM bookings WHERE workspace_id = $1 AND status IN ('confirmed', 'at_risk') AND start_time < $bufferedEnd AND end_time > $bufferedStart AND id != $excludeBookingId LIMIT 1`.
4. If either source has a conflict, return `{ hasConflict: true, conflictSource, conflictDetails }`.

### 1.5 `calendar_query` tool definition (`supabase/functions/_shared/tool-registry.ts`)

Registered in the tool registry alongside `knowledge_search`, `update_client`, etc. Authority: **read** (no side effects, no approval needed).

```typescript
// In supabase/functions/_shared/tool-registry.ts

import { z } from 'zod';

export const calendarQuerySchema = z.object({
  // LLM provides:
  dateRange: z.object({
    start: z.string().describe('ISO 8601 date string, e.g. "2026-03-20"'),
    end: z.string().describe('ISO 8601 date string, e.g. "2026-03-27"'),
  }).describe('Date range to check availability. Max 14 days.'),
  appointmentType: z.string().describe(
    'Key from vertical_config.appointmentTypes, e.g. "initial_consultation", "first_fitting"'
  ),

  // Runtime injects (overrides LLM values):
  workspaceId: z.string().uuid(),
});
```

**Execution (`executeCalendarQuery`):**

1. Load workspace record (business hours, timezone, vertical_config, calendar_config).
2. Validate `appointmentType` exists in `vertical_config.appointmentTypes[]`. If not, return error.
3. Validate date range does not exceed 14 days. If it does, truncate to 14 days from start.
4. Check prerequisite via `checkPrerequisite()`. If not satisfied, return `{ type: 'data', data: { slots: [], prerequisiteBlocked: true, missingPrerequisite: { key, label } } }`.
5. Decrypt calendar_config tokens.
6. Instantiate `GoogleCalendarGateway`.
7. Query busy intervals for the date range.
8. Query existing bookings from database for the date range.
9. Call `calculateAvailableSlots()` with busy intervals, existing bookings, business hours, and appointment type config.
10. Return `{ type: 'data', data: { slots: AvailableSlot[], appointmentType: { key, label, durationMinutes } } }`.

**Return type:** `ToolResult` with `type: 'data'`. No side effects. No approval required.

### 1.6 `calendar_book` tool definition (`supabase/functions/_shared/tool-registry.ts`)

Authority: **propose_write**. Returns a `ProposedAction<BookingCreate>` that requires staff approval via F-06.

```typescript
export const calendarBookSchema = z.object({
  // LLM provides:
  slotId: z.string().describe(
    'The slotId from a previous calendar_query result'
  ),
  appointmentType: z.string().describe(
    'Key from vertical_config.appointmentTypes'
  ),
  notes: z.string().optional().describe(
    'Additional booking notes from the conversation'
  ),

  // Runtime injects (overrides LLM values):
  workspaceId: z.string().uuid(),
  clientId: z.string().uuid(),
});
```

**Execution (`executeCalendarBook`):**

1. Load workspace record (vertical_config, calendar_config).
2. Validate `appointmentType` exists in `vertical_config.appointmentTypes[]`.
3. Resolve `slotId` to a concrete time: re-derive the slot from `slotId` or look it up from the conversation's recent `calendar_query` results stored in the tool call log.
4. **Re-check prerequisite** via `checkPrerequisite()`. If not satisfied, return error (defense in depth -- `calendar_query` already checked, but time may have passed).
5. Construct `ProposedAction` payload:

```typescript
const payload: BookingCreatePayload = {
  appointment_type: appointmentType,
  start_time: slot.startTime,
  end_time: slot.endTime,
  notes: notes ?? null,
  slot_id: slotId,
};
```

6. Return `{ type: 'proposed', action: { actionType: 'booking_create', payload, summary } }`.

The `summary` is a human-readable string for the confirmation card, e.g., `"Book Initial Consultation for Jane Smith on Tue 22 Mar at 2:00 PM"`.

**The tool does NOT create the booking or calendar event.** It returns a ProposedAction. The actual writes happen in `approve-action` (section 1.7).

### 1.7 Booking execution handler (`supabase/functions/_shared/action-executor.ts`)

Extension to the F-06 `ActionExecutor` dispatch table. Called when staff approves a `booking_create` ProposedAction.

```typescript
// Addition to action-executor.ts dispatch table
// actionType: 'booking_create' -> executeBookingCreate()

async function executeBookingCreate(
  supabase: SupabaseClient,
  action: ProposedAction,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const payload = action.payload as BookingCreatePayload;

  // 1. Load workspace (calendar_config, vertical_config)
  const workspace = await loadWorkspace(supabase, action.workspace_id);
  const aptType = workspace.vertical_config.appointmentTypes
    .find(t => t.key === payload.appointment_type);

  // 2. Conflict detection (final gate)
  const gateway = new GoogleCalendarGateway(
    decryptCalendarConfig(workspace.calendar_config),
    supabase,
    action.workspace_id
  );

  const conflict = await detectConflict(gateway, supabase, {
    workspaceId: action.workspace_id,
    startTime: payload.start_time,
    endTime: payload.end_time,
    bufferMinutes: aptType.bufferMinutes,
  });

  if (conflict.hasConflict) {
    // Do NOT create booking. Return error to staff.
    // Trigger re-query flow (section 5.4).
    return {
      success: false,
      error: `Conflict detected (${conflict.conflictSource}): ${conflict.conflictDetails}. Please re-query availability.`,
    };
  }

  // 3. Create Google Calendar event
  const client = await loadClient(supabase, action.client_id);
  const calendarEvent = await gateway.createEvent({
    summary: `${aptType.label} - ${client.full_name}`,
    start: payload.start_time,
    end: payload.end_time,
    description: payload.notes ?? '',
  });

  // 4. Create booking record (in same transaction context)
  const { data: booking, error: dbError } = await supabase
    .from('bookings')
    .insert({
      workspace_id: action.workspace_id,
      client_id: action.client_id,
      appointment_type: payload.appointment_type,
      start_time: payload.start_time,
      end_time: payload.end_time,
      calendar_event_id: calendarEvent.eventId,
      status: 'confirmed',
      confirmation_status: 'pending',
      notes: payload.notes,
    })
    .select('id')
    .single();

  if (dbError) {
    // Calendar event was created but DB write failed.
    // Attempt to delete the calendar event to maintain atomicity.
    await gateway.deleteEvent(calendarEvent.eventId).catch(err => {
      console.error('[booking] Failed to rollback calendar event', {
        eventId: calendarEvent.eventId,
        error: err,
      });
    });
    return { success: false, error: `Database write failed: ${dbError.message}` };
  }

  // 5. Update client lifecycle status
  await supabase
    .from('clients')
    .update({ lifecycle_status: 'upcoming_appointment' })
    .eq('id', action.client_id);

  // 6. Transition conversation state
  await supabase
    .from('conversations')
    .update({ state: 'idle' })
    .eq('client_id', action.client_id)
    .eq('workspace_id', action.workspace_id);

  return { success: true };
}
```

**Atomicity approach:** Calendar event creation and database write are not in a true distributed transaction (Google Calendar has no 2PC). The strategy is: create the calendar event first, then write the database record. If the database write fails, attempt to delete the calendar event as a compensating action. If the compensating delete also fails, log the orphaned event for manual cleanup. This is the pragmatic MVP approach -- distributed sagas are deferred.

### 1.8 Reschedule execution handler

Extension to `action-executor.ts` for `booking_reschedule` action type.

```typescript
async function executeBookingReschedule(
  supabase: SupabaseClient,
  action: ProposedAction,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const payload = action.payload as BookingReschedulePayload;

  // 1. Load original booking
  const { data: original } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', payload.original_booking_id)
    .eq('workspace_id', action.workspace_id)
    .single();

  if (!original) return { success: false, error: 'Original booking not found' };

  // 2. Conflict detection for new time (exclude original booking)
  const conflict = await detectConflict(gateway, supabase, {
    workspaceId: action.workspace_id,
    startTime: payload.new_start_time,
    endTime: payload.new_end_time,
    bufferMinutes: aptType.bufferMinutes,
    excludeBookingId: original.id,
  });

  if (conflict.hasConflict) {
    return { success: false, error: `Conflict at new time: ${conflict.conflictDetails}` };
  }

  // 3. Update Google Calendar event
  await gateway.updateEvent(original.calendar_event_id, {
    start: payload.new_start_time,
    end: payload.new_end_time,
  });

  // 4. Update booking record
  await supabase
    .from('bookings')
    .update({
      start_time: payload.new_start_time,
      end_time: payload.new_end_time,
    })
    .eq('id', original.id);

  return { success: true };
}
```

Prerequisite validation is NOT re-run on reschedule (the original booking already passed it). Only the time changes.

### 1.9 Cancellation execution handler

Extension to `action-executor.ts` for `booking_cancel` action type.

```typescript
async function executeBookingCancel(
  supabase: SupabaseClient,
  action: ProposedAction,
  staffId: string
): Promise<{ success: boolean; error?: string }> {
  const payload = action.payload as BookingCancelPayload;

  // 1. Load booking
  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', payload.booking_id)
    .eq('workspace_id', action.workspace_id)
    .single();

  if (!booking) return { success: false, error: 'Booking not found' };

  // 2. Delete Google Calendar event
  if (booking.calendar_event_id) {
    await gateway.deleteEvent(booking.calendar_event_id).catch(err => {
      console.warn('[booking] Calendar event deletion failed, proceeding with DB update', err);
    });
  }

  // 3. Update booking status
  await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', booking.id);

  // 4. Re-evaluate client lifecycle status
  const { data: otherBookings } = await supabase
    .from('bookings')
    .select('id')
    .eq('client_id', action.client_id)
    .eq('workspace_id', action.workspace_id)
    .eq('status', 'confirmed')
    .neq('id', booking.id)
    .limit(1);

  if (!otherBookings?.length) {
    // No other confirmed bookings -- revert lifecycle status
    await supabase
      .from('clients')
      .update({ lifecycle_status: 'open' })
      .eq('id', action.client_id);
  }

  return { success: true };
}
```

Calendar event deletion failure is non-fatal for cancellation. The booking status is updated regardless. An orphaned calendar event is preferable to an inconsistent booking record.

### 1.10 Google Calendar OAuth page (`src/app/(dashboard)/settings/calendar/page.tsx`)

Next.js page for initiating and managing the Google Calendar OAuth flow. Part of the Settings section.

**Responsibilities:**

- Display current calendar connection status (connected/disconnected/error).
- "Connect Google Calendar" button that initiates the OAuth redirect.
- OAuth callback handling via a dedicated API route.
- "Disconnect Calendar" button that removes tokens.
- Display the connected calendar email/name.

### 1.11 OAuth API routes

**`src/app/api/auth/google-calendar/route.ts`** -- initiates the OAuth flow:

1. Build Google OAuth authorization URL with scopes: `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.readonly`.
2. Include `state` parameter with workspace_id (encrypted/signed to prevent CSRF).
3. Set `access_type=offline` for refresh token.
4. Set `prompt=consent` to always get a refresh token.
5. Redirect to Google.

**`src/app/api/auth/google-calendar/callback/route.ts`** -- handles the OAuth callback:

1. Validate `state` parameter (decrypt, verify workspace_id matches authenticated user).
2. Exchange authorization code for access + refresh tokens via `POST https://oauth2.googleapis.com/token`.
3. Fetch the primary calendar ID via `GET https://www.googleapis.com/calendar/v3/users/me/calendarList/primary`.
4. Encrypt tokens using Supabase Vault.
5. Store in `workspace.calendar_config`:

```typescript
{
  provider: 'google',
  calendarId: primaryCalendarId,
  accessToken: encryptedAccessToken,
  refreshToken: encryptedRefreshToken,
  tokenExpiresAt: expiresAt,
  connectedEmail: userEmail,
  status: 'connected',
  connectedAt: new Date().toISOString(),
}
```

6. Redirect to `/settings/calendar?connected=true`.

**`src/app/api/auth/google-calendar/disconnect/route.ts`** -- disconnects:

1. Clear `calendar_config` on the workspace (set to `null` or `{ status: 'disconnected' }`).
2. The next Client Worker invocation will not have `calendar_query` / `calendar_book` in its tool set.
3. Existing booking records and their `calendar_event_id` values remain untouched.

---

## 2. Data Model

### 2.1 `bookings` table

Already defined in architecture-final.md SS 9.1. Reproduced with F-07-specific notes:

```sql
CREATE TABLE bookings (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID        NOT NULL REFERENCES workspaces(id),
  client_id           UUID        NOT NULL REFERENCES clients(id),
  provider_id         UUID        REFERENCES staff(id),              -- nullable for MVP (single-provider workspaces)
  appointment_type    TEXT        NOT NULL,                           -- key from vertical_config.appointmentTypes
  start_time          TIMESTAMPTZ NOT NULL,
  end_time            TIMESTAMPTZ NOT NULL,
  calendar_event_id   TEXT,                                           -- Google Calendar event ID
  status              TEXT        NOT NULL DEFAULT 'confirmed',       -- 'confirmed', 'at_risk', 'cancelled', 'completed', 'no_show'
  confirmation_status TEXT        DEFAULT 'pending',                   -- 'pending', 'confirmed', 'unconfirmed'
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_client ON bookings(client_id);
CREATE INDEX idx_bookings_workspace_time ON bookings(workspace_id, start_time);

-- Overlap detection query support
CREATE INDEX idx_bookings_overlap ON bookings(workspace_id, start_time, end_time)
  WHERE status IN ('confirmed', 'at_risk');
```

**Additions beyond architecture-final.md SS 9:**
- `provider_id` -- nullable FK to `staff`. Supports multi-provider workspaces post-MVP. Single-provider workspaces leave it NULL.
- `updated_at` -- tracks reschedule timing. Updated via trigger or application code.
- `idx_bookings_overlap` -- partial index for conflict detection queries, covering only active bookings.

### 2.2 `workspace.calendar_config` JSONB shape

```typescript
type CalendarConfig = {
  provider: 'google';
  calendarId: string;         // Google Calendar ID (usually the primary)
  accessToken: string;        // AES-256 encrypted via Supabase Vault
  refreshToken: string;       // AES-256 encrypted via Supabase Vault
  tokenExpiresAt: string;     // ISO 8601 UTC
  connectedEmail: string;     // Google account email for display
  status: 'connected' | 'disconnected' | 'error';
  connectedAt: string;        // ISO 8601 UTC
  errorMessage?: string;      // populated when status = 'error'
} | null;
```

When `calendar_config` is `null` or `status !== 'connected'`, the tool registry excludes `calendar_query` and `calendar_book` for that workspace.

### 2.3 `vertical_config.appointmentTypes` shape

Defined in architecture-final.md appendix. Reproduced for clarity:

```typescript
type AppointmentTypeDef = {
  key: string;            // machine key, e.g. 'first_fitting'
  label: string;          // human-readable, e.g. 'First Fitting'
  durationMinutes: number;
  bufferMinutes: number;
  prerequisite?: string;  // key of required prior appointment type
};
```

Example for a bespoke tailor:

```json
[
  { "key": "consultation", "label": "Initial Consultation", "durationMinutes": 60, "bufferMinutes": 15 },
  { "key": "first_fitting", "label": "First Fitting", "durationMinutes": 45, "bufferMinutes": 15, "prerequisite": "consultation" },
  { "key": "second_fitting", "label": "Second Fitting", "durationMinutes": 30, "bufferMinutes": 10, "prerequisite": "first_fitting" },
  { "key": "final_fitting", "label": "Final Fitting & Collection", "durationMinutes": 30, "bufferMinutes": 10, "prerequisite": "second_fitting" }
]
```

### 2.4 `proposed_actions.payload` shapes for booking actions

**`booking_create`:**
```typescript
{
  appointment_type: string;         // key from vertical_config
  start_time: string;               // ISO 8601 UTC
  end_time: string;                 // ISO 8601 UTC
  notes: string | null;
  slot_id: string;                  // from calendar_query results
}
```

**`booking_reschedule`:**
```typescript
{
  original_booking_id: string;      // UUID of existing booking
  appointment_type: string;         // preserved from original
  new_start_time: string;           // ISO 8601 UTC
  new_end_time: string;             // ISO 8601 UTC
  original_start_time: string;      // for audit trail / confirmation card
  original_end_time: string;
}
```

**`booking_cancel`:**
```typescript
{
  booking_id: string;               // UUID of booking to cancel
  appointment_type: string;         // for display in confirmation card
  start_time: string;               // for display
  end_time: string;
  has_dependents: boolean;          // true if future bookings depend on this one
  dependent_booking_ids?: string[]; // IDs of dependent bookings (for staff awareness)
}
```

### 2.5 New audit action types

F-07 introduces these audit `action_type` values (registered alongside F-06 types):

| Trigger | `action_type` | `actor_type` | `metadata` |
|---|---|---|---|
| Booking created (approved) | `booking_created` | `staff` | `booking_id`, `appointment_type`, `start_time`, `calendar_event_id` |
| Booking rescheduled | `booking_rescheduled` | `staff` | `booking_id`, `before: { start, end }`, `after: { start, end }` |
| Booking cancelled | `booking_cancelled` | `staff` | `booking_id`, `appointment_type`, `start_time` |
| Calendar connected | `calendar_connected` | `staff` | `provider: 'google'`, `connected_email` |
| Calendar disconnected | `calendar_disconnected` | `staff` | `provider: 'google'` |
| Conflict detected at approval | `booking_conflict_detected` | `system` | `proposed_action_id`, `conflict_source`, `conflict_details` |

---

## 3. Google Calendar Integration

### 3.1 OAuth flow

```
Staff clicks "Connect Google Calendar" in Settings
        |
        v
Next.js API route: /api/auth/google-calendar
        |
        | Build authorization URL:
        | - client_id: GOOGLE_CALENDAR_CLIENT_ID (env var)
        | - redirect_uri: {APP_URL}/api/auth/google-calendar/callback
        | - scope: calendar.events + calendar.readonly
        | - access_type: offline
        | - prompt: consent
        | - state: encrypt({ workspaceId, nonce })
        |
        v
Redirect to Google OAuth consent screen
        |
        v
User grants access (or denies -> redirect back with error param)
        |
        v
Google redirects to /api/auth/google-calendar/callback?code=...&state=...
        |
        | 1. Decrypt & validate state (CSRF check)
        | 2. Exchange code for tokens (POST https://oauth2.googleapis.com/token)
        | 3. Fetch primary calendar ID
        | 4. Encrypt tokens via Supabase Vault
        | 5. UPDATE workspaces SET calendar_config = {...} WHERE id = $workspaceId
        | 6. Write audit event: calendar_connected
        |
        v
Redirect to /settings/calendar?connected=true
```

### 3.2 Availability query flow

```
Client Worker (process-message) receives inbound message
        |
        | LLM classifies intent as "booking request"
        | LLM calls calendar_query tool
        v
executeCalendarQuery() in tool executor
        |
        | 1. Load workspace (business_hours, timezone, vertical_config, calendar_config)
        | 2. Validate appointmentType exists
        | 3. Check prerequisite (booking-rules.ts)
        |    -> If blocked: return { slots: [], prerequisiteBlocked: true }
        | 4. Decrypt calendar_config
        | 5. GoogleCalendarGateway.queryBusyIntervals(timeMin, timeMax)
        |    -> Auto-refreshes token if 401
        | 6. Query existing bookings from DB for date range
        | 7. calculateAvailableSlots(busyIntervals, bookings, businessHours, aptType)
        | 8. Return { slots: AvailableSlot[] }
        |
        v
LLM receives slots in tool result
        |
        | Selects 2-4 well-distributed slots
        | Generates draft proposing options to client
        | Draft saved with status "pending_review"
        v
Staff reviews draft in inbox
```

### 3.3 Event creation flow (at approval time)

```
Staff approves ProposedAction<BookingCreate>
        |
        v
approve-action Edge Function
        |
        | executeBookingCreate()
        |
        | 1. Load workspace + calendar_config
        | 2. detectConflict() -- FINAL GATE
        |    -> Checks Google Calendar AND bookings table
        |    -> If conflict: return error, DO NOT create
        | 3. GoogleCalendarGateway.createEvent({
        |      summary: "Initial Consultation - Jane Smith",
        |      start: "2026-03-22T06:00:00Z",
        |      end: "2026-03-22T07:00:00Z",
        |      description: "Booking notes..."
        |    })
        | 4. INSERT INTO bookings (calendar_event_id, status='confirmed', ...)
        | 5. UPDATE clients SET lifecycle_status = 'upcoming_appointment'
        | 6. UPDATE conversations SET state = 'idle'
        | 7. Write audit event: booking_created
        |
        v
Booking record + calendar event created atomically
```

### 3.4 Token refresh

The `GoogleCalendarGateway` wraps every API call in `withTokenRefresh()`:

1. Check if `tokenExpiresAt` is within 5 minutes of now. If so, proactively refresh before the call.
2. Make the API call.
3. If HTTP 401 received (expired token slipped through), call `refreshAccessToken()`.
4. `refreshAccessToken()` POSTs to Google's token endpoint with `grant_type=refresh_token`.
5. On success: encrypt and persist new tokens to `workspace.calendar_config`.
6. On failure (e.g., 400 `invalid_grant`): this means the refresh token has been revoked.
   - Set `calendar_config.status = 'disconnected'` and `calendar_config.errorMessage = 'Google Calendar access was revoked. Please reconnect.'`.
   - The next inbound message will not have calendar tools available.
   - Staff sees the disconnected status on the Settings page and the conversation thread.

---

## 4. Tool Definitions (Zod Schemas)

### 4.1 `calendar_query` full schema

```typescript
import { z } from 'zod';

export const calendarQueryInputSchema = z.object({
  dateRange: z.object({
    start: z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format')
      .describe('Start date (inclusive), e.g. "2026-03-20"'),
    end: z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format')
      .describe('End date (inclusive), e.g. "2026-03-27"'),
  }).describe('Date range to search for available slots. Maximum 14 days.'),

  appointmentType: z.string()
    .min(1)
    .describe('Appointment type key from vertical_config, e.g. "consultation"'),

  // Runtime-injected (overwritten by ToolParamInjector):
  workspaceId: z.string().uuid(),
});

export const calendarQueryOutputSchema = z.object({
  slots: z.array(z.object({
    slotId: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    date: z.string(),
    dayOfWeek: z.string(),
    displayTime: z.string(),
  })),
  appointmentType: z.object({
    key: z.string(),
    label: z.string(),
    durationMinutes: z.number(),
  }),
  prerequisiteBlocked: z.boolean().optional(),
  missingPrerequisite: z.object({
    key: z.string(),
    label: z.string(),
  }).optional(),
  timezone: z.string(),
});

// Tool definition for the registry
export const calendarQueryTool: ToolDefinition = {
  name: 'calendar_query',
  description: `Check Google Calendar availability for a specific appointment type within a date range. Returns available time slots respecting business hours, existing events, buffer times, and prerequisite requirements. Use this when a client expresses interest in booking an appointment.`,
  authority: 'read',
  schema: calendarQueryInputSchema,
  execute: executeCalendarQuery,
};
```

### 4.2 `calendar_book` full schema

```typescript
export const calendarBookInputSchema = z.object({
  slotId: z.string()
    .min(1)
    .describe('The slotId from a previous calendar_query result'),

  appointmentType: z.string()
    .min(1)
    .describe('Appointment type key, must match the type used in calendar_query'),

  notes: z.string()
    .max(500)
    .optional()
    .describe('Optional booking notes from the conversation context'),

  // Runtime-injected (overwritten by ToolParamInjector):
  workspaceId: z.string().uuid(),
  clientId: z.string().uuid(),
});

// Tool definition for the registry
export const calendarBookTool: ToolDefinition = {
  name: 'calendar_book',
  description: `Propose a booking for a specific time slot. This creates a booking proposal that requires staff approval before the calendar event and booking record are created. Use this after the client has selected a specific slot from the options you presented.`,
  authority: 'propose_write',
  schema: calendarBookInputSchema,
  execute: executeCalendarBook,
};
```

### 4.3 Dynamic tool registration

In `tool-registry.ts`, tool availability is determined at context assembly time:

```typescript
export function getToolsForWorkspace(
  workspace: Workspace
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    knowledgeSearchTool,
    updateClientTool,
    createNoteTool,
    createFollowupTool,
  ];

  // Calendar tools only available when Google Calendar is connected
  if (
    workspace.calendar_config &&
    workspace.calendar_config.status === 'connected'
  ) {
    tools.push(calendarQueryTool);
    tools.push(calendarBookTool);
  }

  return tools;
}
```

When calendar tools are excluded, the system prompt includes: *"Calendar is not connected. Do not offer to check availability or book appointments. Instead, suggest the client coordinates scheduling directly with staff."*

---

## 5. Multi-Step Booking Flow

### 5.1 Happy path: new booking

```
Client sends: "I'd like to book a consultation"
        |
        v
[process-message Edge Function]
        |
        | 1. Context assembly includes:
        |    - activeBookings (any existing bookings for this client)
        |    - vertical_config.appointmentTypes
        |    - calendar tools available (calendar connected)
        |
        | 2. Client Worker classifies intent: "booking_request"
        |
        | 3. Client Worker calls calendar_query({
        |      dateRange: { start: "2026-03-20", end: "2026-03-27" },
        |      appointmentType: "consultation"
        |    })
        |
        | 4. Tool returns { slots: [...8 slots...], appointmentType: { key, label, durationMinutes } }
        |
        | 5. LLM selects 3 well-distributed slots, generates draft:
        |    "Hi! I'd love to help you book a consultation. Here are some available times:
        |     1. Thursday 20 Mar, 10:00 AM (1 hour)
        |     2. Friday 21 Mar, 2:00 PM (1 hour)
        |     3. Monday 24 Mar, 11:00 AM (1 hour)
        |     Which works best for you?"
        |
        | 6. Draft saved (status: pending_review)
        |    Proposed slot data stored in draft metadata for later matching
        v
Staff reviews and sends the draft
        |
        v
Client replies: "Wednesday 2pm works great"
        |
        v
[process-message -- second invocation]
        |
        | 1. Context includes: previous messages (slot proposal + client reply)
        |
        | 2. Client Worker matches reply to slot #2 (Fri 21 Mar 2:00 PM)
        |    (Note: LLM uses conversation context for matching)
        |
        | 3. Client Worker calls calendar_book({
        |      slotId: "slot-hash-fri-1400",
        |      appointmentType: "consultation",
        |      notes: "Client prefers afternoon slots"
        |    })
        |
        | 4. Tool returns ProposedAction<BookingCreate>
        |
        | 5. LLM generates confirmation draft:
        |    "I've noted your preference for Friday 21 Mar at 2:00 PM for your
        |     Initial Consultation. Let me confirm this with the team and
        |     I'll get back to you shortly!"
        |
        | 6. Draft saved + ProposedAction saved (status: pending, tier: review)
        |    Confirmation card appears in staff inbox
        v
Staff sees confirmation card:
  "Book Initial Consultation for Jane Smith
   Fri 21 Mar at 2:00 PM - 3:00 PM"
  [Approve] [Reject]
        |
        v (Approve)
[approve-action Edge Function]
        |
        | executeBookingCreate():
        | 1. Conflict check (final gate) -- PASS
        | 2. Create Google Calendar event
        | 3. Create booking record (status: confirmed)
        | 4. Update client lifecycle -> upcoming_appointment
        | 5. Transition conversation state -> idle
        | 6. Audit event: booking_created
        v
Booking complete. Staff sends confirmation message to client.
```

### 5.2 Slot matching logic

Slot matching is an **LLM task**, not a deterministic function. The Client Worker uses conversation context (the previously sent slot proposal) to interpret the client's reply. The proposed slots are available in the conversation history (recent messages include the sent message with slot options).

The Client Worker handles these cases via prompt instructions:

1. **Clear selection** ("Option 2", "Wednesday 2pm"): match to the specific slot, call `calendar_book`.
2. **Ambiguous selection** ("the morning one" with multiple mornings): generate clarification draft.
3. **Unproposed time** ("How about Friday at 3pm?"): call `calendar_query` for the requested time, proceed if available.
4. **Eager but no selection** ("Yes I'd like to book"): generate draft asking which slot they prefer.

### 5.3 Context assembly additions for booking

The `activeBookings` section of the context window (architecture-final.md SS 6.2) provides the Client Worker with:

```typescript
activeBookings: Array<{
  appointmentType: string;   // e.g. "consultation"
  startTime: string;         // ISO 8601
  status: string;            // "confirmed", "at_risk"
  confirmationStatus: string; // "pending", "confirmed"
}>
```

This enables the LLM to:
- Know if the client already has upcoming appointments (avoid duplicate booking).
- Identify reschedule intent (client mentions changing an existing appointment).
- Know which appointment types the client has completed (for prerequisite awareness).

### 5.4 Conflict-triggered re-query

When `executeBookingCreate()` detects a conflict at approval time:

1. The `approve-action` Edge Function returns `{ success: false, error: 'Conflict detected...' }`.
2. The staff sees the error on the confirmation card.
3. The system enqueues a synthetic event to `process-message` (via pgmq) with context: `{ type: 'booking_conflict', originalSlot: {...}, appointmentType: '...' }`.
4. The Client Worker receives this context, calls `calendar_query` with the same appointment type, and generates a new draft: *"I'm sorry, that slot is no longer available. Here are some alternative times:..."*
5. The new draft enters the normal approval workflow.

---

## 6. Conflict Detection

### 6.1 When conflict detection runs

| Point in pipeline | What runs | Why |
|---|---|---|
| `calendar_query` tool execution | No conflict check -- just reads availability | Slots are informational, not reserved |
| `calendar_book` tool execution | No conflict check -- just creates ProposedAction | Proposal is a suggestion, not a commitment |
| **`approve-action` execution** | **Full conflict detection** | **This is the commitment point. Must be accurate.** |

### 6.2 Dual-source conflict check

The `detectConflict()` function checks both sources because they can diverge:

- **Google Calendar** may have events added by the business owner directly (outside the system).
- **Bookings table** may have records not yet synced to Google Calendar (race condition during creation).

Both sources must be clear for the booking to proceed.

### 6.3 Buffer enforcement

Buffers are enforced symmetrically. For a proposed booking at 10:00-11:00 with 15-minute buffer:

- Blocked window: 09:45 - 11:15
- Any event overlapping this window triggers a conflict.

### 6.4 Stale slot mitigation

Slots are **not locked** at query time (PRD SS 9.2). The time between `calendar_query` and staff approval could be minutes or hours. Stale slots are mitigated by:

1. **Conflict detection at approval time** -- the authoritative check.
2. **ProposedAction expiry** -- `expires_at` is set to the proposed slot's `start_time`. If the slot time passes before approval, the action expires and cannot be executed.
3. **Re-query on conflict** -- automatic alternative proposal when a conflict is detected.

---

## 7. Prerequisite Validation

### 7.1 Validation points

Prerequisite validation runs at **two** points (defense in depth):

1. **In `calendar_query` execution** -- before returning slots. If the prerequisite is not met, return `{ slots: [], prerequisiteBlocked: true, missingPrerequisite }`. The LLM receives this and generates a draft explaining the requirement.

2. **In `calendar_book` execution** -- before creating the ProposedAction. If the prerequisite is not met (could happen if time passed between query and book), return an error to the LLM.

### 7.2 Prerequisite satisfaction criteria

A prerequisite is satisfied when there exists a booking in the `bookings` table with:
- `workspace_id` = current workspace
- `client_id` = current client
- `appointment_type` = the prerequisite key
- `status` = `'completed'`

The following statuses do NOT satisfy the prerequisite:
- `confirmed` -- appointment exists but has not happened yet.
- `at_risk` -- appointment is at risk of no-show.
- `cancelled` -- appointment was cancelled.
- `no_show` -- client did not attend.

### 7.3 Prerequisite chain example

For a bespoke tailor with the appointment chain `consultation -> first_fitting -> second_fitting -> final_fitting`:

- Client requests `second_fitting`: system checks for `completed` `first_fitting` booking.
- If `first_fitting` exists but status is `confirmed` (not yet attended): prerequisite NOT met. LLM explains the first fitting must be completed first.
- If `first_fitting` status is `completed`: prerequisite met, proceed with booking flow.

### 7.4 Prerequisite not re-checked on reschedule

When rescheduling an existing booking, the prerequisite was already validated when the booking was originally created. Re-checking would create false negatives (e.g., rescheduling a `second_fitting` when the `first_fitting` has already occurred but the `second_fitting` record has not been completed yet -- it is the booking being rescheduled).

---

## 8. Reschedule & Cancellation

### 8.1 Reschedule flow

```
Client sends: "Can I move my appointment to Thursday?"
        |
        v
[process-message]
        |
        | Context includes activeBookings: [{ appointmentType: "consultation",
        |   startTime: "2026-03-22T06:00:00Z", status: "confirmed" }]
        |
        | LLM classifies intent: "reschedule_request"
        | LLM identifies the booking to reschedule from context
        | LLM calls calendar_query for "consultation" around Thursday
        |
        v
Tool returns available slots on/near Thursday
        |
        | LLM drafts: "I can move your consultation to one of these times:
        |   1. Thursday 27 Mar, 10:00 AM
        |   2. Thursday 27 Mar, 3:00 PM
        |   Would either of these work?"
        v
Client selects a slot
        |
        v
[process-message -- second invocation]
        |
        | LLM calls calendar_book with new slot
        | Tool creates ProposedAction<BookingReschedule> with:
        |   - original_booking_id
        |   - new_start_time, new_end_time
        |   - original_start_time, original_end_time (for audit)
        |
        v
Staff approves -> executeBookingReschedule():
        |
        | 1. Conflict check for new time (exclude original booking)
        | 2. Update Google Calendar event with new time
        | 3. Update booking record (start_time, end_time, updated_at)
        | 4. Audit event: booking_rescheduled with before/after
        v
Done. Booking time changed, same booking_id preserved.
```

### 8.2 Cancellation flow

```
Client sends: "I need to cancel my appointment"
        |
        v
[process-message]
        |
        | LLM classifies intent: "cancellation_request"
        | LLM identifies the booking to cancel from context
        |
        | Before proposing cancellation, check for dependent bookings:
        | - Query bookings where appointment_type has this booking's type as prerequisite
        |   AND client_id matches AND status = 'confirmed'
        |
        | LLM drafts cancellation confirmation message
        | Tool creates ProposedAction<BookingCancel> with:
        |   - booking_id
        |   - has_dependents: true/false
        |   - dependent_booking_ids: [...]
        |
        v
Staff sees confirmation card:
  "Cancel Initial Consultation for Jane Smith
   Fri 21 Mar at 2:00 PM - 3:00 PM
   WARNING: First Fitting on 28 Mar depends on this appointment"
  [Approve] [Reject]
        |
        v (Approve)
executeBookingCancel():
        | 1. Delete Google Calendar event
        | 2. Update booking status -> 'cancelled'
        | 3. Re-evaluate client lifecycle status
        | 4. Audit event: booking_cancelled
        v
Staff sends cancellation confirmation to client
```

### 8.3 Dependent booking detection

When a cancellation is proposed, the system checks for dependent future bookings:

```sql
SELECT b.id, b.appointment_type, b.start_time
FROM bookings b
JOIN LATERAL (
  SELECT prerequisite
  FROM jsonb_array_elements(
    (SELECT vertical_config->'appointmentTypes' FROM workspaces WHERE id = $workspaceId)
  ) AS apt
  WHERE apt->>'prerequisite' = $cancelledAppointmentType
) deps ON b.appointment_type = deps.prerequisite
WHERE b.client_id = $clientId
  AND b.workspace_id = $workspaceId
  AND b.status = 'confirmed';
```

This is informational only -- the system surfaces dependents to staff but does not block or auto-cascade cancellations. Staff makes the decision.

---

## 9. Edge Cases

### 9.1 Stale slots

**Scenario:** Slots returned by `calendar_query` become unavailable before staff approves.

**Handling:**
1. Conflict detection at approval time catches this.
2. ProposedAction returns error to staff.
3. System triggers re-query and generates new slot proposals.
4. ProposedAction has `expires_at` set to the proposed slot's `start_time`. If the appointment time passes, the action auto-expires.

### 9.2 OAuth token expiry

**Scenario:** Access token expires during a `calendar_query` or event creation.

**Handling:** `GoogleCalendarGateway.withTokenRefresh()` catches HTTP 401 and refreshes automatically. The original operation is retried once. This is transparent to the caller.

### 9.3 OAuth token revocation

**Scenario:** User revokes Google Calendar access from their Google account settings, or the refresh token becomes invalid.

**Handling:**
1. `refreshAccessToken()` receives HTTP 400 `invalid_grant`.
2. Gateway sets `calendar_config.status = 'disconnected'` and `errorMessage`.
3. Audit event: `calendar_disconnected` (actor: system).
4. Next Client Worker invocation: calendar tools excluded from tool set.
5. LLM is told calendar is disconnected, suggests client coordinates directly with staff.
6. Staff is notified to reconnect via the Settings page.
7. Existing booking records and `calendar_event_id` values are unaffected.

### 9.4 Timezone handling

**Rule:** All times stored in the database and sent to Google Calendar API are in UTC (`TIMESTAMPTZ`).

**Display conversion:** The availability calculator converts UTC slots to the workspace's IANA timezone for human-readable display in drafts. The `AvailableSlot.displayTime` and `AvailableSlot.dayOfWeek` fields use the workspace timezone.

**Cross-timezone clients:** The system does not track client timezones. All slot presentations use the workspace (business) timezone. This is correct for SMB contexts where clients are typically local.

**DST transitions:** The availability calculator uses a proper timezone library (e.g., `Temporal` or `date-fns-tz`) that handles DST transitions. Slots that would fall in a DST gap are skipped.

### 9.5 Google Calendar API unavailable

**Scenario:** Google Calendar API returns 5xx or times out during `calendar_query`.

**Handling:**
1. `calendar_query` returns an error result to the LLM: `{ error: 'calendar_unavailable', message: 'Unable to check calendar availability right now' }`.
2. The LLM generates a draft explaining unavailability and suggesting the client try again shortly or contact the business directly.
3. No ProposedAction is created.
4. No retry at the tool level -- the client can simply send another message later, which triggers a new `calendar_query`.

### 9.6 Google Calendar API unavailable during approval

**Scenario:** Google Calendar API fails when staff approves a booking (event creation fails).

**Handling:**
1. `executeBookingCreate()` does NOT create the booking record (atomicity).
2. Returns error to staff.
3. ProposedAction remains in `pending` status (not transitioned).
4. Staff can retry by tapping Approve again.
5. If the API outage persists, staff can reject and re-propose later.

### 9.7 Calendar event created but DB write fails

**Scenario:** Google Calendar event was successfully created, but the subsequent `bookings` INSERT fails.

**Handling:**
1. Compensating action: attempt to delete the Google Calendar event.
2. If deletion succeeds: clean state, staff can retry.
3. If deletion fails: log the orphaned event (`calendar_event_id`) for manual cleanup. The event exists in Google Calendar but has no matching booking record.
4. Return error to staff with details.

### 9.8 Multiple bookings for the same client

**Scenario:** Client has multiple upcoming bookings (e.g., consultation on Tuesday and first fitting on Friday) and sends a message about rescheduling.

**Handling:** The Client Worker has all active bookings in context (`activeBookings` array). The LLM uses conversation context to disambiguate which booking the client means. If ambiguous, the LLM generates a clarification draft: *"I see you have two upcoming appointments -- your consultation on Tuesday and your first fitting on Friday. Which one would you like to reschedule?"*

### 9.9 Rapid slot changes

**Scenario:** A busy workspace where slots change frequently between query and client selection.

**Handling:** This is inherent to the "no lock at query time" design. The system mitigates via:
1. Conflict detection at approval time (definitive check).
2. Short expiry on ProposedActions (set to slot start_time).
3. Automatic re-query and alternative proposal on conflict.

The trade-off is documented: locking introduces complexity. SMB booking volumes do not justify it.

### 9.10 Client requests booking when calendar not connected

**Handling:** Calendar tools are not in the tool registry. The LLM does not have the ability to call `calendar_query` or `calendar_book`. The system prompt instructs: *"Calendar is not connected. Do not offer to check availability or book appointments."* The LLM generates a draft suggesting the client contact the business directly to schedule.

---

## 10. Acceptance Criteria to Tasks

### Task Group 1: Google Calendar Gateway

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-01 | US-F07-01 | Implement `GoogleCalendarGateway` class with `queryBusyIntervals`, `createEvent`, `updateEvent`, `deleteEvent` | `supabase/functions/_shared/google-calendar.ts` |
| T-F07-02 | US-F07-01 | Implement token refresh flow with `withTokenRefresh` wrapper and proactive refresh | `supabase/functions/_shared/google-calendar.ts` |
| T-F07-03 | US-F07-01 | Handle token revocation: mark calendar_config as disconnected, write audit event | `supabase/functions/_shared/google-calendar.ts` |
| T-F07-04 | US-F07-01 | Token encryption/decryption via Supabase Vault for `calendar_config` | `supabase/functions/_shared/google-calendar.ts` |

### Task Group 2: OAuth Flow (Next.js)

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-05 | US-F07-01 | Create OAuth initiation API route with state parameter and CSRF protection | `src/app/api/auth/google-calendar/route.ts` |
| T-F07-06 | US-F07-01 | Create OAuth callback API route: exchange code, fetch calendar ID, encrypt and store tokens | `src/app/api/auth/google-calendar/callback/route.ts` |
| T-F07-07 | US-F07-01 | Create disconnect API route: clear calendar_config, write audit event | `src/app/api/auth/google-calendar/disconnect/route.ts` |
| T-F07-08 | US-F07-01 | Build Settings > Calendar page: connection status, connect/disconnect buttons, connected email display | `src/app/(dashboard)/settings/calendar/page.tsx` |

### Task Group 3: Availability Engine

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-09 | US-F07-02 | Implement `calculateAvailableSlots` pure function with business hours, buffer, and granularity logic | `supabase/functions/_shared/availability.ts` |
| T-F07-10 | US-F07-02 | Unit tests for `calculateAvailableSlots`: business hours enforcement, buffer enforcement, DST edge cases, empty results | `supabase/functions/_shared/availability.test.ts` |
| T-F07-11 | US-F07-02 | Implement deterministic slot ID generation (`slotId` hash) | `supabase/functions/_shared/availability.ts` |

### Task Group 4: Tool Definitions

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-12 | US-F07-02 | Implement `calendar_query` tool: Zod schema, execution function, registration in tool registry | `supabase/functions/_shared/tool-registry.ts` |
| T-F07-13 | US-F07-05 | Implement `calendar_book` tool: Zod schema, execution function, ProposedAction creation | `supabase/functions/_shared/tool-registry.ts` |
| T-F07-14 | US-F07-02 | Dynamic tool availability: exclude calendar tools when calendar not connected, update system prompt | `supabase/functions/_shared/tool-registry.ts`, `supabase/functions/_shared/context-assembly.ts` |

### Task Group 5: Booking Rules

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-15 | US-F07-09 | Implement `checkPrerequisite` function: query bookings table for completed prerequisite | `supabase/functions/_shared/booking-rules.ts` |
| T-F07-16 | US-F07-09 | Unit tests for prerequisite validation: satisfied, not satisfied, cancelled/no-show prerequisite, no prerequisite defined | `supabase/functions/_shared/booking-rules.test.ts` |

### Task Group 6: Conflict Detection

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-17 | US-F07-07 | Implement `detectConflict` function: dual-source check (Google Calendar + bookings table) with buffer enforcement | `supabase/functions/_shared/conflict-detector.ts` |
| T-F07-18 | US-F07-07 | Unit tests for conflict detection: no conflict, calendar conflict, database conflict, buffer conflict, reschedule exclusion | `supabase/functions/_shared/conflict-detector.test.ts` |

### Task Group 7: Approval Execution Handlers

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-19 | US-F07-06 | Implement `executeBookingCreate` handler: conflict check, calendar event creation, booking record, lifecycle update, conversation state transition | `supabase/functions/_shared/action-executor.ts` |
| T-F07-20 | US-F07-06 | Implement compensating action: delete calendar event if DB write fails | `supabase/functions/_shared/action-executor.ts` |
| T-F07-21 | US-F07-10 | Implement `executeBookingReschedule` handler: conflict check (exclude original), update calendar event, update booking record | `supabase/functions/_shared/action-executor.ts` |
| T-F07-22 | US-F07-11 | Implement `executeBookingCancel` handler: delete calendar event, update booking status, re-evaluate lifecycle | `supabase/functions/_shared/action-executor.ts` |
| T-F07-23 | US-F07-11 | Implement dependent booking detection for cancellation warning | `supabase/functions/_shared/action-executor.ts` |

### Task Group 8: Database

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-24 | US-F07-06 | Add `provider_id`, `updated_at` columns and `idx_bookings_overlap` partial index to bookings table | `supabase/migrations/XXX_f07_bookings_additions.sql` |
| T-F07-25 | All | Add `booking_reschedule` and `booking_cancel` to `proposed_actions.action_type` accepted values | `supabase/functions/_shared/approval-policy.ts` |
| T-F07-26 | All | Register F-07 audit action types: `booking_created`, `booking_rescheduled`, `booking_cancelled`, `calendar_connected`, `calendar_disconnected`, `booking_conflict_detected` | `supabase/functions/_shared/types.ts` |

### Task Group 9: Integration & Wiring

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-27 | US-F07-08 | Implement conflict-triggered re-query: enqueue synthetic event on conflict, Client Worker generates alternative slots | `supabase/functions/approve-action/index.ts`, `supabase/functions/process-message/index.ts` |
| T-F07-28 | US-F07-03, US-F07-04 | Add booking-specific prompt instructions: slot presentation format (2-4 options, day/time/duration), slot matching behavior, reschedule/cancel intent recognition | `supabase/functions/_shared/context-assembly.ts` |
| T-F07-29 | US-F07-01 | Support calendar connection during onboarding flow (summary step links to OAuth) | `src/app/(dashboard)/settings/calendar/page.tsx`, onboarding integration |

### Task Group 10: End-to-End Testing

| Task | AC Source | Description | File(s) |
|---|---|---|---|
| T-F07-30 | All | E2E test: full booking happy path (query -> propose -> select -> approve -> booking created) | Test suite |
| T-F07-31 | US-F07-07 | E2E test: conflict detection at approval time triggers re-query | Test suite |
| T-F07-32 | US-F07-10, US-F07-11 | E2E test: reschedule and cancellation flows | Test suite |
| T-F07-33 | US-F07-01 | E2E test: OAuth flow (connect, token refresh, disconnect, revocation) | Test suite |

---

## Implementation Order

**Phase A (foundation -- no Google Calendar needed):**
1. T-F07-09, T-F07-10, T-F07-11 -- Availability calculator (pure function, fully testable)
2. T-F07-15, T-F07-16 -- Prerequisite validator (database query, testable with mocks)
3. T-F07-17, T-F07-18 -- Conflict detector (testable with mocked gateway)
4. T-F07-24, T-F07-25, T-F07-26 -- Database migrations and type registrations

**Phase B (Google Calendar integration):**
5. T-F07-01, T-F07-02, T-F07-03, T-F07-04 -- GoogleCalendarGateway
6. T-F07-05, T-F07-06, T-F07-07, T-F07-08 -- OAuth flow (Next.js)

**Phase C (tool wiring):**
7. T-F07-12, T-F07-13, T-F07-14 -- Tool definitions and dynamic availability
8. T-F07-19, T-F07-20, T-F07-21, T-F07-22, T-F07-23 -- Approval execution handlers
9. T-F07-27 -- Conflict-triggered re-query

**Phase D (prompt & polish):**
10. T-F07-28 -- Booking-specific prompt instructions
11. T-F07-29 -- Onboarding integration

**Phase E (end-to-end):**
12. T-F07-30, T-F07-31, T-F07-32, T-F07-33 -- E2E tests
