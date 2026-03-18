# ADR-003: Supabase Auth with RLS-enforced Workspace Isolation

**Status:** Accepted
**Date:** 2026-03-18
**Deciders:** Solo founder
**Source:** architecture-final.md Section 5, 7

## Context

The system needs:
1. Staff authentication for the web app
2. Workspace-level data isolation (each workspace's data invisible to others)
3. API security for staff-initiated actions
4. Session isolation in LLM context (cross-client data never enters context window)

The platform is deployed as a template for B2B clients. Each client company gets their own workspace. MVP is single-operator per workspace.

## Decision Drivers

- Built into Supabase (no additional auth service)
- JWT tokens carry workspace_id for RLS enforcement
- Must support future multi-staff per workspace
- Defense in depth: multiple isolation layers, not just application code

## Decision

**Supabase Auth for staff authentication, with 4-layer isolation:**

### Layer 1: Supabase Auth
- Email + password for MVP (magic link optional)
- JWT issued with `workspace_id` in `app_metadata`
- Refresh token rotation enabled

### Layer 2: Row Level Security (RLS)
- Every table has RLS enabled
- Helper function for clean policies:
```sql
CREATE OR REPLACE FUNCTION auth.workspace_id()
RETURNS uuid AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
```
- All policies use `workspace_id = auth.workspace_id()`
- `workspace_id` denormalized onto child tables for flat (no-subquery) RLS policies

### Layer 3: Context Assembly Scoping
- Every database query in `assembleContext()` includes `WHERE workspace_id = $1 AND client_id = $2`
- Application-level scoping as defense in depth (RLS catches bugs)

### Layer 4: Tool Parameter Injection
- `workspaceId` and `clientId` injected by runtime into every LLM tool call
- LLM cannot override these parameters
- Even a prompt injection attack cannot access another client's data

### Edge Function Auth
- Edge Functions use Supabase service role key (bypasses RLS)
- Service role is acceptable because:
  - Webhook payloads are authenticated by HMAC signature verification
  - Processing is scoped by application code (workspace resolved from phone_number_id)
  - This is a system process, not a user-initiated action

### OAuth (Google Calendar)
- OAuth 2.0 per workspace for Google Calendar integration
- Tokens stored encrypted in `workspace.calendar_config` via Supabase Vault/pgsodium
- Token refresh on 401

## Consequences

### Positive
- Zero additional auth infrastructure
- RLS provides database-level isolation even if application code has bugs
- 4 layers of defense: auth → RLS → query scoping → tool injection
- JWT-based: stateless, scales horizontally

### Negative
- MVP is single-operator per workspace (no RBAC)
- RLS policies add overhead to every query (mitigated by denormalized workspace_id)
- Service role in Edge Functions bypasses RLS (acceptable with signature verification)

### Reversal Triggers
- Multi-staff with roles: add `staff.role` column and role-based RLS policies
- SSO requirement: Supabase supports SAML SSO on Enterprise plan
- Per-client Google Calendar: extend OAuth to per-staff token storage
