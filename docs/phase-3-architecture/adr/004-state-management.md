# ADR-004: Server-Driven State with Supabase Realtime

**Status:** Accepted
**Date:** 2026-03-18
**Deciders:** Solo founder
**Source:** architecture-final.md Sections 10, 14

## Context

The staff web app needs:
1. Real-time updates (new messages, draft ready, action pending) without polling
2. Conversation state management (idle → awaiting_staff_review → awaiting_client_reply → ...)
3. Client-side state for interactive UI elements (draft editing, form input)

The previous architecture did not specify a real-time mechanism.

## Decision Drivers

- Must show new messages and drafts within ~1 second of creation
- Staff must see inbound messages immediately (before AI processing completes)
- No custom WebSocket server to build or maintain
- Supabase Realtime is included in the platform (no additional cost)

## Decision

### Real-time: Supabase Realtime (Postgres Changes)

Staff app subscribes to table changes via WebSocket:

| Table | Events | Staff sees |
|---|---|---|
| `messages` | INSERT | New inbound message immediately (dual notification pattern) |
| `drafts` | INSERT, UPDATE | Draft ready for review, draft status changes |
| `proposed_actions` | INSERT, UPDATE | Confirmation cards, approval status |
| `conversations` | UPDATE | State badges in inbox |

**Dual notification pattern** (cherry-picked from Solution B):
1. Webhook handler saves raw message to `messages` table immediately → Realtime fires → staff sees "new message" in inbox
2. Processing Edge Function saves draft → Realtime fires → staff sees "draft ready" in thread

This means staff sees the inbound message within 1 second of arrival, even though AI processing takes 10-25 seconds.

All Realtime subscriptions filter by `workspace_id` (denormalized on these tables for efficient filtering). RLS provides the security boundary.

### Conversation state: Server-side state machine

States: `idle`, `awaiting_staff_review`, `awaiting_client_reply`, `follow_up_pending`, `booking_in_progress`

Transitions validated by application code (not LLM). State stored in `conversations.state` column. Transitions are deterministic functions of events (message received, draft sent, booking confirmed, etc.).

### Client-side state: React hooks only (no global store)

- No Zustand, no Redux for MVP
- React `useState` / `useReducer` for local UI state (draft editing, form input)
- Server state managed by RSC + Supabase Realtime
- Data fetching: React Server Components for initial load, Realtime for live updates

## Consequences

### Positive
- Zero custom real-time infrastructure
- Staff sees messages before AI processing completes (dual notification)
- Realtime respects RLS (workspace isolation automatic)
- No global state management library to learn/maintain

### Negative
- Supabase Realtime connection limit: 200 (free), 500 (Pro) concurrent connections
- If staff is offline, they miss live updates (but data is in DB, visible on next page load)
- No offline support (requires service worker + local cache — deferred)

### Reversal Triggers
- > 500 concurrent staff sessions: Supabase Enterprise or custom WebSocket
- Offline-first requirement: add service worker with local state sync
- Complex client-side state: add Zustand when 3+ components share non-trivial state
