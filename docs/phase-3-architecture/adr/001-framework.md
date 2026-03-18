# ADR-001: Next.js + Supabase Edge Functions + Baileys Server

**Status:** Accepted (updated: Baileys server added)
**Date:** 2026-03-18
**Deciders:** Solo founder
**Source:** architecture-final.md ADR-2, ADR-6, Section 16

## Context

The previous architecture (v1.0) specified Fastify as a separate Node.js API server for webhook handling, message processing, and staff-facing API endpoints. This would be a third deployment target alongside the frontend and Supabase.

The stack constraint is: Next.js (App Router) + Supabase + Vercel. We need to decide how to split server-side work between these two platforms.

WhatsApp Cloud API webhooks must return 200 within 5 seconds. LLM processing takes 10-25 seconds. These cannot run synchronously in the same function.

## Decision Drivers

- Solo founder must minimize deployment targets and operational burden
- Webhook reliability requires fast 200 response + async processing
- LLM calls need up to 30 seconds (exceeds Vercel Hobby 10s limit, tight on Pro 60s)
- Edge Functions run on Deno (not Node.js) — some npm packages may not work

## Options Considered

### Option A: Fastify separate API server (previous architecture)
- Separate Node.js process on Railway/Render
- Full npm ecosystem access
- Requires Docker deployment, monitoring, scaling

### Option B: Next.js API routes only (Vercel)
- Single deployment target
- 10s timeout on Hobby, 60s on Pro — tight for LLM calls
- Webhook URL changes on preview deployments

### Option C: Next.js + Supabase Edge Functions (original choice)
- Edge Functions for webhooks + message processing (150s timeout, Deno)
- Next.js API routes for staff app actions + Stripe webhooks
- Two deployment targets but both are managed services

### Option D: Next.js + Edge Functions + Baileys Server (chosen)
- Baileys server on Railway for WhatsApp connectivity (persistent Node.js process)
- Edge Functions for AI processing (context assembly, LLM, approval)
- Next.js for staff app + Stripe
- Three deployment targets, but Baileys enables QR pairing, no WABA, no Meta fees

## Decision

**Option D: Next.js + Supabase Edge Functions + Baileys Server on Railway.**

- **Baileys server (Railway):** Persistent Node.js process running `@whiskeysockets/baileys` v6+. Maintains WebSocket connection to WhatsApp. Handles inbound messages (save to DB + enqueue to pgmq), outbound sending, QR code pairing, auth state persistence.
- **Edge Functions (Supabase):** AI processing pipeline — dequeue from pgmq, context assembly, LLM call, tool loop, approval eval, save draft. 4 functions (down from 6 — `whatsapp-webhook` and `send-message` replaced by Baileys server).
- **Next.js (Vercel):** Staff web app + Stripe webhooks + staff-initiated actions.
- pgmq trigger fires `pg_net` to invoke `process-message` Edge Function when Baileys server enqueues a message.
- `pg_cron` polls every 1 minute as safety net.

## Consequences

### Positive
- Access to existing WhatsApp conversations (history import possible)
- No WABA registration (faster client onboarding — scan QR and go)
- No per-conversation Meta fees (free messaging)
- No 24-hour window restriction (send anytime, no templates needed)
- 150-second Edge Function timeout comfortable for LLM calls
- Baileys auth state persisted to Supabase (survives server restarts)

### Negative
- Three deployment targets (Vercel + Supabase + Railway) instead of two
- Baileys is unofficial — Meta can break the protocol at any time
- Persistent server adds ~$5-20/mo infrastructure cost
- Account ban risk (low with responsible B2B usage patterns)
- Messages during server downtime are delivered to phone only, not to system

### Reversal Trigger
Baileys becomes unsustainable (protocol breaks, account bans). Migrate to WhatsApp Cloud API: replace Baileys server with `whatsapp-webhook` Edge Function + `send-message` Edge Function. The rest of the pipeline (pgmq → process-message → draft → approval) stays identical.
