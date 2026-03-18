# Feature Spec — F-03: Client Identity & Profile

**Feature:** F-03 Client Identity & Profile
**Phase:** 1
**Size:** M (3–5 days)
**PRD Functions:** CI-01, CI-02, MP-03
**Architecture module:** `client-relationship`
**ADR dependencies:** ADR-2 (database-backed session isolation — all queries scoped by `workspace_id + client_id`)
**User stories:** US-F03-01 through US-F03-05
**Depends on:** F-02 (WhatsApp Message Pipeline — delivers normalized E.164 phone number and `workspace_id` to this feature)
**Required by:** F-05 (Context Assembly — consumes `client_id` and `ClientProfile`)

---

## 1. Component Breakdown

### 1.1 Domain layer — `modules/client-relationship/domain/`

| File | Responsibility |
|------|----------------|
| `Client.ts` | Entity. Holds all columns from the `clients` table. Owns the `lifecycle_status` field and exposes `reactivate()` and `markInactive()` methods for status transitions. No LLM dependency. |
| `ClientProfile.ts` | Value object derived from a `Client` entity. Packages the fields needed by context assembly (`full_name`, `phone_number`, `lifecycle_status`, `tags`, `preferences`). Immutable once constructed. |
| `ClientRepository.ts` | Repository interface (contract). Declares the methods the application layer depends on. Infrastructure must satisfy this interface. |

**`ClientRepository` interface:**

```typescript
interface ClientRepository {
  // CI-01: exact match lookup
  findByPhone(workspaceId: string, phoneNumber: string): Promise<Client | null>;

  // CI-02 + MP-03: find-or-create (single round-trip upsert)
  findOrCreate(workspaceId: string, phoneNumber: string): Promise<Client>;

  // Staff CRUD
  findById(workspaceId: string, clientId: string): Promise<Client | null>;
  list(workspaceId: string, opts?: ListClientsOptions): Promise<Client[]>;
  update(workspaceId: string, clientId: string, patch: ClientPatch): Promise<Client>;
  softDelete(workspaceId: string, clientId: string): Promise<void>;

  // Lifecycle
  updateLifecycleStatus(
    workspaceId: string,
    clientId: string,
    status: LifecycleStatus
  ): Promise<Client>;

  // Custom fields (JSON merge patch)
  mergePreferences(
    workspaceId: string,
    clientId: string,
    patch: Record<string, unknown>
  ): Promise<Client>;

  // Inactivity job
  findClientsWithNoActivitySince(
    workspaceId: string,
    cutoff: Date
  ): Promise<Client[]>;
}
```

### 1.2 Application layer — `modules/client-relationship/application/`

| File | Use case | Called by |
|------|----------|-----------|
| `FindOrCreateClient.ts` | Executes the MP-03 upsert. Returns a `Client`. Emits no side effects beyond the DB write. | `ProcessInboundMessage` (F-02 pipeline worker) |
| `UpdateClientLifecycleStatus.ts` | Validates the new status value and writes the update. Writes an `AuditEvent` (actor, action, before/after). Returns updated `Client`. | Staff API route; `InactivityDetectionJob` |
| `MergeClientPreferences.ts` | Validates custom field values against `vertical_config.customFields` metadata (type, enum constraints). Executes JSON merge patch. Returns updated `Client`. | Staff API route |
| `AssembleClientContext.ts` | Reads `Client`, derives `ClientProfile`. Consumed by F-05 context assembly. Out of F-03 scope to implement fully, but the data contract is locked here. | F-05 |

### 1.3 Infrastructure layer — `modules/client-relationship/infrastructure/`

| File | Responsibility |
|------|----------------|
| `SupabaseClientRepository.ts` | Implements `ClientRepository`. All SQL queries include `WHERE workspace_id = $1`. Uses Supabase JS client with service-role key on the server side. |

### 1.4 Jobs layer — `jobs/`

| File | Responsibility |
|------|----------------|
| `InactivityDetectionJob.ts` | pg_cron scheduled job that invokes a Supabase Edge Function. Runs daily per workspace timezone. Finds clients whose `last_contacted_at` is older than the workspace-configured inactivity threshold (default 30 days) and whose `lifecycle_status` is not already `inactive`. Updates status to `inactive` and writes an `AuditEvent` per client. Not on the hot path. |

---

## 2. Data Model

### 2.1 `clients` table

```sql
CREATE TABLE clients (
  client_id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID          NOT NULL REFERENCES workspaces(workspace_id),
  full_name         TEXT,
  phone_number      TEXT          NOT NULL,
  email             TEXT,
  lifecycle_status  TEXT          NOT NULL DEFAULT 'open'
                    CHECK (lifecycle_status IN (
                      'open',
                      'chosen_service',
                      'upcoming_appointment',
                      'follow_up',
                      'review_complete',
                      'inactive'
                    )),
  tags              TEXT[]        NOT NULL DEFAULT '{}',
  preferences       JSONB         NOT NULL DEFAULT '{}',
  last_contacted_at TIMESTAMPTZ,
  summary           TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ                          -- soft delete for merged records (F-09)
);
```

### 2.2 Unique constraint (concurrency guard for MP-03)

```sql
ALTER TABLE clients
  ADD CONSTRAINT clients_workspace_phone_unique
  UNIQUE (workspace_id, phone_number);
```

This constraint is the mechanism that makes the upsert idempotent. Two concurrent workers racing to create the same `(workspace_id, phone_number)` pair will result in exactly one row being inserted; the loser receives the existing row via the `RETURNING *` clause.

### 2.3 Indexes

```sql
-- Primary lookup path (CI-01, MP-03) — must be sub-50ms
CREATE INDEX idx_clients_workspace_phone
  ON clients (workspace_id, phone_number)
  WHERE deleted_at IS NULL;

-- Staff list view with lifecycle filter
CREATE INDEX idx_clients_workspace_lifecycle
  ON clients (workspace_id, lifecycle_status)
  WHERE deleted_at IS NULL;

-- Inactivity detection job
CREATE INDEX idx_clients_workspace_last_contacted
  ON clients (workspace_id, last_contacted_at)
  WHERE deleted_at IS NULL AND lifecycle_status != 'inactive';
```

All three are partial indexes excluding soft-deleted rows — this keeps them small and fast.

### 2.4 Row-level security (RLS)

```sql
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

-- Staff can read and write only their own workspace's clients
CREATE POLICY clients_workspace_isolation ON clients
  USING (
    workspace_id = (
      SELECT workspace_id FROM workspace_members
      WHERE staff_id = auth.uid()
    )
  );
```

The server-side pipeline worker (`ProcessInboundMessage`) uses the Supabase service-role key and bypasses RLS. The staff-facing API uses the per-request JWT which activates RLS. Both paths still scope queries explicitly by `workspace_id` in the `WHERE` clause (defense in depth per ADR-2 / §3.4 of the architecture spec).

### 2.5 `lifecycle_status` values (§13.6 PRD)

| Value | Description |
|-------|-------------|
| `open` | New or active contact, no service selected. Default on creation. |
| `chosen_service` | Client has expressed intent to purchase a specific service. |
| `upcoming_appointment` | Confirmed booking exists for this client. |
| `follow_up` | Appointment completed; follow-up action pending. |
| `review_complete` | Follow-up cycle complete. |
| `inactive` | No interaction for the configurable inactivity period (default 30 days). Auto-set by `InactivityDetectionJob`; reverts to `open` on next inbound message. |

Status transitions are not enforced as a directed graph at the database level in Phase 1. Any status can be set from any status. A transition graph constraint may be introduced in Phase 2.

---

## 3. API Endpoints

All routes are prefixed `/api/workspaces/:workspaceId/clients`. Every route requires a valid staff JWT. RLS enforces workspace membership server-side; the application layer additionally validates that the JWT's workspace matches the route parameter.

### 3.1 Client CRUD

| Method | Path | Description | Request body | Response |
|--------|------|-------------|-------------|---------|
| `GET` | `/` | List clients with optional filters | — | `{ clients: Client[], total: number }` |
| `GET` | `/:clientId` | Get single client by ID | — | `Client` |
| `POST` | `/` | Create client manually (staff-initiated) | `{ phone_number, full_name?, email? }` | `Client` (201) |
| `PATCH` | `/:clientId` | Update client profile fields | `ClientPatch` | `Client` |
| `DELETE` | `/:clientId` | Soft-delete client | — | `204` |

**`GET /` query params:**

| Param | Type | Description |
|-------|------|-------------|
| `lifecycle_status` | string | Filter by status value |
| `search` | string | Partial match on `full_name` or `phone_number` |
| `page` | number | Pagination offset (default 0) |
| `limit` | number | Page size (default 50, max 200) |

**`ClientPatch` shape (all optional):**

```typescript
type ClientPatch = {
  full_name?: string;
  email?: string;
  tags?: string[];
  preferences?: Record<string, unknown>;  // merged, not replaced — see §5.3
};
```

### 3.2 Lifecycle status update

| Method | Path | Description | Request body | Response |
|--------|------|-------------|-------------|---------|
| `PATCH` | `/:clientId/lifecycle` | Update lifecycle status | `{ lifecycle_status: LifecycleStatus }` | `Client` |

Staff-initiated updates are applied immediately (no confirmation card required). An `AuditEvent` is written with `actor = staff_id`, `action = "lifecycle_status_updated"`, `before` and `after` values.

AI-proposed lifecycle status changes go through the standard `ProposedAction` / confirmation card flow (F-06 governance) and never hit this endpoint directly — they use `ProposeClientUpdate` in the application layer.

### 3.3 Internal pipeline endpoint (not staff-facing)

The `findOrCreate` operation is not an HTTP route. It is called directly by `ProcessInboundMessage` (F-02) as a TypeScript function call within the same process. No HTTP overhead on the hot path.

---

## 4. Key Implementation Details

### 4.1 Find-or-create with upsert (MP-03, CI-01, CI-02)

The entire find-or-create is a single SQL round-trip. This is the most critical correctness and performance constraint for F-03.

```sql
INSERT INTO clients (workspace_id, phone_number, lifecycle_status, preferences, created_at, updated_at)
VALUES ($1, $2, 'open', '{}', now(), now())
ON CONFLICT (workspace_id, phone_number)
DO UPDATE SET updated_at = now()
RETURNING *;
```

**Why `DO UPDATE SET updated_at = now()` and not `DO NOTHING`:**
`DO NOTHING` returns no rows on conflict. `DO UPDATE` always returns the final row (whether inserted or pre-existing), giving us a single unconditional `RETURNING *` result. The `updated_at` touch is a benign side effect.

**TypeScript implementation in `SupabaseClientRepository.ts`:**

```typescript
async findOrCreate(workspaceId: string, phoneNumber: string): Promise<Client> {
  const { data, error } = await this.supabase
    .from('clients')
    .upsert(
      { workspace_id: workspaceId, phone_number: phoneNumber, lifecycle_status: 'open', preferences: {} },
      { onConflict: 'workspace_id,phone_number', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) throw new RetryableDbError(error.message);
  return mapRowToClient(data);
}
```

If the DB call throws (network error, Postgres unavailable), a `RetryableDbError` is re-thrown. The pgmq consumer (Edge Function worker) does not delete the message from the queue, so it becomes visible again after the pgmq visibility timeout expires and is retried automatically (US-F03-02 scenario 4).

### 4.2 E.164 phone number normalization

F-03 does **not** perform normalization. Phone numbers arrive at this module already normalized to E.164 format by MP-02 (F-02). If a non-E.164 string is passed to `findOrCreate` or `findByPhone`, the repository **rejects it at the Zod schema layer** before any DB call:

```typescript
const E164_REGEX = /^\+[1-9]\d{7,14}$/;
const PhoneNumberSchema = z.string().regex(E164_REGEX, 'Must be E.164 format');
```

This prevents silent data corruption from malformed phone numbers entering the unique index.

### 4.3 Lifecycle status transitions

No directed-graph enforcement in Phase 1 — any status can be set from any status. The application service `UpdateClientLifecycleStatus` validates only that the requested value is a member of the `LifecycleStatus` enum (Zod enum schema). After writing, it emits an `AuditEvent`:

```typescript
await auditRepo.write({
  workspaceId,
  clientId,
  actor: actorId,                          // staff_id or 'system' for the inactivity job
  action: 'lifecycle_status_updated',
  before: { lifecycle_status: previousStatus },
  after:  { lifecycle_status: newStatus },
});
```

**Special transition: `inactive` → `open` on inbound message.**
`ProcessInboundMessage` (F-02) calls `findOrCreate` first, then checks if the returned client has `lifecycle_status === 'inactive'`. If so, it calls `UpdateClientLifecycleStatus` to set it to `'open'` and updates `last_contacted_at`. This happens on the hot path but is a single conditional DB write after the upsert — acceptable latency impact.

### 4.4 Vertical custom fields in `preferences` JSON

`preferences` is a `JSONB` column that serves two purposes:

1. **Vertical custom field values:** keys declared in `workspace.vertical_config.customFields[].key` (e.g., `chest_inches`, `suit_style` for bespoke tailor; `hair_type` for salon).
2. **Other client-level preferences:** e.g., `preferred_name`, `preferred_contact_time`.

No schema changes are needed when a new vertical is deployed or when an owner modifies their custom fields via the SOP editor (F-01 / ON-05).

**Write via JSON merge patch (not full overwrite):**

```sql
UPDATE clients
SET
  preferences = preferences || $patch::jsonb,
  updated_at  = now()
WHERE workspace_id = $1 AND client_id = $2
RETURNING *;
```

The `||` operator in Postgres merges at the top level, preserving keys not present in `$patch`. This satisfies US-F03-05 scenario 3 (updating one field does not wipe unrelated keys).

**Type validation before write** (in `MergeClientPreferences`):

```typescript
function validateCustomFieldPatch(
  patch: Record<string, unknown>,
  customFields: CustomFieldDef[]
): void {
  for (const [key, value] of Object.entries(patch)) {
    const def = customFields.find(f => f.key === key);
    if (!def) continue; // non-vertical keys (e.g., preferred_name) pass through unchecked
    switch (def.type) {
      case 'number':  z.number().parse(value); break;
      case 'string':  z.string().parse(value); break;
      case 'boolean': z.boolean().parse(value); break;
      case 'enum':    z.enum(def.enumValues as [string, ...string[]]).parse(value); break;
      case 'date':    z.string().datetime().parse(value); break;
    }
  }
}
```

Unknown keys that are not in `vertical_config.customFields` are allowed (see §6.3 for edge case handling).

### 4.5 Sub-50ms target for MP-03

The `findOrCreate` path must complete in under 50 ms (US-F03-03, architecture §3.4). Mechanisms:

1. **Single SQL round-trip.** The upsert returns the row without a second SELECT.
2. **Partial index on `(workspace_id, phone_number)` where `deleted_at IS NULL`.** Keeps the index small and cache-hot.
3. **Connection pool.** Supabase pgBouncer (transaction mode) keeps connections warm.
4. **No LLM calls.** F-03 is a pure DB read/write path.

Performance target is tested at the integration test level with a p99 assertion against a local Postgres container.

---

## 5. Edge Cases

### 5.1 Race condition on concurrent create (US-F03-03 scenario 4)

**Scenario:** Two pgmq consumer workers (Edge Function invocations) receive duplicate-delivered messages from `+447700900777` at the same moment. No client record exists. Both execute `findOrCreate` simultaneously.

**Resolution:** The `UNIQUE (workspace_id, phone_number)` constraint ensures exactly one `INSERT` succeeds. The other worker hits the `ON CONFLICT DO UPDATE` branch and receives the same row via `RETURNING *`. Both workers proceed with the same `client_id`. No application-level locking is needed.

**Verification:** Integration test spawns two concurrent promises calling `findOrCreate` with the same `(workspaceId, phoneNumber)`. Asserts that exactly one row exists in the `clients` table afterwards and that both promises resolve to the same `client_id`.

### 5.2 Invalid phone number format

**Scenario:** A caller passes a phone number that is not in E.164 format (e.g., `"07700900001"`, `"+44 77 0090 0001"`, empty string).

**Resolution:** The Zod schema at the repository boundary throws a `ZodError` synchronously before any DB call. The calling application service catches this and returns a `400 Bad Request` from the API layer (for staff-initiated creates) or throws a non-retryable error in the pipeline worker (since MP-02 should have normalized the number — this indicates a pipeline bug, not a transient failure).

### 5.3 Unknown vertical custom field keys in preferences patch

**Scenario:** Staff (or a future API caller) submits a `preferences` patch containing a key that is not declared in `workspace.vertical_config.customFields` (e.g., `"preferred_name"`, or a key from a previous vertical config that was removed).

**Resolution:** Unknown keys pass through the type validation step without error (the `if (!def) continue` branch). They are written into `preferences` via the JSON merge patch. This is intentional — `preferences` is a general-purpose store, not exclusively a vertical custom fields store. Keys are never silently dropped. If a type-validated field (e.g., `chest_inches`) has a value that fails its type assertion (string instead of number), validation throws a `ValidationError` and the patch is rejected wholesale (no partial writes).

### 5.4 Reactivation of an inactive client

**Scenario:** A client with `lifecycle_status = 'inactive'` sends a new inbound message.

**Resolution:** `findOrCreate` returns the existing record (the `DO UPDATE SET updated_at = now()` branch). `ProcessInboundMessage` checks the returned status. If `'inactive'`, it calls `UpdateClientLifecycleStatus(workspaceId, clientId, 'open')` and sets `last_contacted_at = now()`. An `AuditEvent` is written with `actor = 'system'`, `action = 'lifecycle_status_updated'`, `before = { lifecycle_status: 'inactive' }`, `after = { lifecycle_status: 'open' }`. This is a conditional write on the hot path — one extra UPDATE only when the client was previously inactive.

### 5.5 DB unavailable during pipeline find-or-create

**Scenario:** Supabase is temporarily unreachable when `findOrCreate` is called.

**Resolution:** The Supabase client throws a network error. `SupabaseClientRepository.findOrCreate` wraps the call and re-throws as `RetryableDbError`. `ProcessInboundMessage` does not catch `RetryableDbError` — it propagates to the pgmq consumer (Edge Function worker), which does not delete the message from the queue. The message stays invisible until the pgmq visibility timeout expires, at which point it becomes visible again for retry. After exceeding the max retry count, the message is moved to the dead-letter queue (DLQ). No partial record is written.

---

## 6. Acceptance Criteria → Tasks Mapping

### US-F03-01 — Phone number lookup (CI-01)

| Acceptance criterion | Task |
|---------------------|------|
| Exact E.164 match returns correct client | Implement `ClientRepository.findByPhone`. Add integration test: known number → returns client. |
| Lookup is scoped to receiving workspace | Integration test: same phone in two workspaces → only WS-001 record returned for WS-001 query. |
| No match returns empty result | Integration test: unknown number → returns `null`. |
| Exact string match (no partial) | Integration test: prefix of existing number → returns `null`. |

**Tasks:**
- [ ] T-F03-01a: Implement `SupabaseClientRepository.findByPhone` with `workspace_id + phone_number` WHERE clause.
- [ ] T-F03-01b: Write integration tests for all four Gherkin scenarios (known match, workspace scope, no match, prefix rejection).

### US-F03-02 — New client auto-creation (CI-02)

| Acceptance criterion | Task |
|---------------------|------|
| New record created with `lifecycle_status = 'open'` | Implement `findOrCreate` INSERT path. |
| Optional fields default to null / `{}` | Verify `full_name`, `email`, `summary` are null; `preferences = {}`. |
| Subsequent message finds existing record | Integration test: call `findOrCreate` twice with same number → same `client_id` both times, one row in DB. |
| DB unavailable → retryable error | Unit test: mock Supabase to throw → assert `RetryableDbError` propagates. |

**Tasks:**
- [ ] T-F03-02a: Implement `SupabaseClientRepository.findOrCreate` with upsert SQL.
- [ ] T-F03-02b: Implement `RetryableDbError` wrapper.
- [ ] T-F03-02c: Write integration tests for all four Gherkin scenarios.

### US-F03-03 — Find-or-create pipeline integration (MP-03)

| Acceptance criterion | Task |
|---------------------|------|
| Known client — existing record returned, no INSERT | Integration test: assert INSERT count = 0 when client exists. |
| Unknown client — new record created | Integration test: row count before/after. |
| Session key correctly composed | Unit test: `findOrCreate` → `sessionKey = workspace:${wid}:client:${cid}`. |
| Concurrent creates → exactly one record | Integration test: two concurrent `findOrCreate` calls → one DB row, both receive same `client_id`. |
| Failure → message not deleted from queue | Unit test: mock DB error → assert `RetryableDbError` propagates (pgmq-based test harness). |

**Tasks:**
- [ ] T-F03-03a: Implement `FindOrCreateClient` application service calling `ClientRepository.findOrCreate`.
- [ ] T-F03-03b: Write concurrent race condition integration test.
- [ ] T-F03-03c: Add p99 latency assertion (< 50ms) in integration test suite against local Postgres.

### US-F03-04 — Lifecycle status management

| Acceptance criterion | Task |
|---------------------|------|
| DB enum CHECK constraint accepts exactly 6 values | Add CHECK constraint in migration. Integration test: invalid value → Postgres rejects. |
| New client starts at `open` | Assert default in `findOrCreate` path. |
| AI tool → ProposedAction (not direct write) | Covered by F-06 governance spec; no F-03 task. |
| Staff direct update → saved immediately + audit event | Implement `PATCH /lifecycle` route + `UpdateClientLifecycleStatus` service. |
| Inactivity after 30 days → `inactive` + audit event | Implement `InactivityDetectionJob`. |
| `inactive` reverts to `open` on new message | Integration test in F-02 pipeline; F-03 provides the status check and update. |

**Tasks:**
- [ ] T-F03-04a: Write migration with `lifecycle_status` CHECK constraint.
- [ ] T-F03-04b: Implement `UpdateClientLifecycleStatus` application service with `AuditEvent` write.
- [ ] T-F03-04c: Implement `PATCH /api/workspaces/:workspaceId/clients/:clientId/lifecycle` route.
- [ ] T-F03-04d: Implement `InactivityDetectionJob` as a pg_cron scheduled job that invokes a Supabase Edge Function.
- [ ] T-F03-04e: Integration test: inactivity job runs → clients with `last_contacted_at` > 30 days → status becomes `inactive`, audit event present.
- [ ] T-F03-04f: Integration test: `inactive` client receives message → `findOrCreate` + status check → becomes `open`.

### US-F03-05 — Vertical custom field storage in preferences

| Acceptance criterion | Task |
|---------------------|------|
| Custom field written to `preferences` JSON | Implement `mergePreferences` using `||` JSON merge. |
| Multiple fields coexist | Integration test: write two fields → both present. |
| Update does not overwrite unrelated keys | Integration test: existing key survives partial patch. |
| UI renders dynamic fields from `vertical_config` | Front-end task (staff app) — out of this backend spec scope; data contract is `GET /:clientId` returning `preferences` + `GET /workspaces/:id` returning `vertical_config`. |
| Different verticals store different keys | Integration test: two workspaces, different verticals — no cross-contamination in preferences. |
| Custom field values included in context assembly | F-05 task; F-03 provides `Client.preferences` in `ClientProfile`. |

**Tasks:**
- [ ] T-F03-05a: Implement `MergeClientPreferences` application service with type validation against `vertical_config.customFields`.
- [ ] T-F03-05b: Implement `SupabaseClientRepository.mergePreferences` using `preferences || $patch::jsonb` SQL.
- [ ] T-F03-05c: Add `PATCH /api/workspaces/:workspaceId/clients/:clientId` support for `preferences` field via `MergeClientPreferences`.
- [ ] T-F03-05d: Integration tests for merge semantics (add, update, partial patch).
- [ ] T-F03-05e: Unit test: invalid type for a declared custom field (e.g., string passed for `number` field) → `ValidationError` thrown, no DB write.

---

## 7. Dependencies

### 7.1 Upstream (F-03 requires these to be operational)

| Dependency | What F-03 needs |
|-----------|-----------------|
| **F-02 WhatsApp Message Pipeline** | Delivers the inbound message with `workspace_id` and a pre-normalized E.164 `phone_number`. `ProcessInboundMessage` calls `FindOrCreateClient` as its first step. F-03 cannot be integration-tested end-to-end without F-02's phone normalization (MP-02). |
| **Supabase instance** | The `workspaces` table (FK target) and `workspace_members` table (for RLS policy) must exist before the `clients` migration runs. |
| **F-04 Audit Foundation** | The `AuditEvent` write in `UpdateClientLifecycleStatus` depends on `AuditRepository` being available. For Phase 1, F-03 and F-04 can be developed in parallel — the `AuditEvent` write can be a no-op stub until F-04 is merged. |

### 7.2 Downstream (these features depend on F-03 being operational)

| Downstream feature | Dependency on F-03 |
|-------------------|-------------------|
| **F-05 Context Assembly** | Calls `AssembleClientContext` which reads `Client` → `ClientProfile`. `client_id` from F-03's `findOrCreate` is the scoping key for all context assembly queries. |
| **F-06 Approval Workflow** | `ProposeClientUpdate` lives in the `client-relationship` application layer; it returns a `ProposedAction<ClientUpdate>` that F-06 evaluates and executes. |
| **F-09 Notes/Knowledge** | Client merge (CI-03, CI-04) is Phase 2 work in F-09. It uses `client_id` from F-03 records and `softDelete` from the repository interface. |
| **F-13 Intelligent Note Processing** | Extracts preference updates (e.g., name changes) and calls `MergeClientPreferences` or `ProposeClientUpdate`. Depends on the F-03 application services. |

### 7.3 Shared contracts locked by F-03

These TypeScript types must not change without a coordinated update across dependent modules:

- `Client` entity shape (all columns)
- `ClientProfile` value object (subset consumed by context assembly)
- `LifecycleStatus` enum values (consumed by F-05 context assembly, F-06 action evaluation, F-12 COS operations)
- `ClientRepository` interface (implemented by infrastructure, consumed by application and indirectly by F-05, F-06)

---

## 8. Out of Scope for F-03

| Item | Covered by |
|------|-----------|
| Phone number normalization (E.164 conversion) | F-02 / MP-02 |
| Client merge (duplicate resolution) | F-09 / CI-03, CI-04 (Phase 2) |
| Context assembly that consumes `ClientProfile` | F-05 (Phase 2) |
| AI-proposed client updates via confirmation card | F-06 approval workflow |
| Conversational context updates (e.g., "update her name to Liz") | F-13 (Phase 3) |
| Intelligent note extraction of custom field values from free text | F-13 (Phase 3) |
| Staff app UI rendering of custom fields | Front-end work tracked separately; backend data contract is defined here |
