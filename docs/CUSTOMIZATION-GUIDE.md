# CRM Template — Customization Guide

> **Purpose:** This document is the complete reference for customizing this backend CRM template for any B2B service business. It covers every function, dependency, placeholder, and configurable setting — plus a step-by-step workflow for adapting the system to a specific business vertical (e.g., wedding dress shop, auto repair, real estate agency).

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Component Map & Dependencies](#2-component-map--dependencies)
3. [Database Schema — Tables & Customizable Fields](#3-database-schema--tables--customizable-fields)
4. [API Routes — Complete Reference](#4-api-routes--complete-reference)
5. [Edge Functions — AI Pipeline](#5-edge-functions--ai-pipeline)
6. [Shared Utilities & Type System](#6-shared-utilities--type-system)
7. [WhatsApp Integration (Baileys Server)](#7-whatsapp-integration-baileys-server)
8. [Environment Variables & Placeholders](#8-environment-variables--placeholders)
9. [Hardcoded Values That May Need Changing](#9-hardcoded-values-that-may-need-changing)
10. [Customizable Settings (No Code Changes)](#10-customizable-settings-no-code-changes)
11. [Step-by-Step: Customizing for a New Business](#11-step-by-step-customizing-for-a-new-business)
12. [Example: Wedding Dress Business](#12-example-wedding-dress-business)
13. [Checklist: Before Going Live](#13-checklist-before-going-live)

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        MOBILE APP (Future)                       │
│              (Expo / React Native — per-client build)            │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS
┌────────────────────────────▼────────────────────────────────────┐
│                     NEXT.JS API LAYER                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │
│  │ Auth     │ │ Clients  │ │ Staff    │ │ Onboarding        │  │
│  │ Routes   │ │ Routes   │ │ Routes   │ │ Routes (14 steps) │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │
│  │ Notes    │ │ Knowledge│ │ Metrics  │ │ Dashboard (Today) │  │
│  │ Routes   │ │ Routes   │ │ Routes   │ │ Routes            │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────────┘  │
│  ┌──────────┐ ┌──────────┐                                      │
│  │ Rules    │ │ Follow-  │                                      │
│  │ Routes   │ │ Ups      │                                      │
│  └──────────┘ └──────────┘                                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                     SUPABASE (PostgreSQL)                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │
│  │ 26 Tables│ │ RLS      │ │ pgvector │ │ pgmq (Queues)     │  │
│  │ + RPCs   │ │ Policies │ │ (RAG)    │ │ + pg_net triggers │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                  SUPABASE EDGE FUNCTIONS (Deno)                  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌──────────────────┐  │
│  │ process-message  │ │ categorize-note │ │ classify-edits   │  │
│  │ (AI drafting)    │ │ (extraction)    │ │ (learning loop)  │  │
│  └─────────────────┘ └─────────────────┘ └──────────────────┘  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌──────────────────┐  │
│  │ approve-action   │ │ embed-knowledge │ │ cron-* (5 jobs)  │  │
│  │ (execution)      │ │ (vectorize)     │ │ (scheduled ops)  │  │
│  └─────────────────┘ └─────────────────┘ └──────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Onboarding Pipeline: tone / sops / scrape / activate        ││
│  └─────────────────────────────────────────────────────────────┘│
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                    BAILEYS SERVER (Node.js)                      │
│  WhatsApp Web connection via QR code login                      │
│  Routes: /send, /qr/:workspaceId, /reconnect/:workspaceId      │
└─────────────────────────────────────────────────────────────────┘
                             │
                    WhatsApp Web Socket
                             │
                     [ Client's Phone ]
```

**Key insight:** This is a **multi-tenant** system. Each workspace = one business. All data is isolated by `workspace_id` with Row Level Security. The system learns and adapts per-workspace through the learning loop.

---

## 2. Component Map & Dependencies

### Dependency Flow

```
Mobile App (future)
    │
    ├──→ Next.js API Routes ──→ Supabase DB (via @supabase/supabase-js)
    │         │                        │
    │         │                        ├──→ pg_net triggers ──→ Edge Functions
    │         │                        ├──→ pgmq queues ──→ process-message EF
    │         │                        └──→ pg_cron ──→ cron-* EFs
    │         │
    │         └──→ Edge Functions (direct HTTP calls for onboarding, knowledge)
    │
    └──→ Baileys Server ──→ WhatsApp Web
              │
              └──→ Supabase DB (auth credentials, message logging, pgmq enqueue)
```

### File Structure

```
/
├── src/                          # Next.js application
│   ├── app/
│   │   ├── api/                  # 41 API route handlers
│   │   │   ├── auth/             # accept-invitation, google-calendar
│   │   │   ├── onboarding/       # start, identity, knowledge, sops, tone, activate
│   │   │   ├── today/            # dashboard, refresh
│   │   │   └── workspaces/[id]/  # clients, staff, notes, follow-ups, knowledge, rules, metrics
│   │   └── invite/               # Invitation acceptance landing page
│   └── lib/                      # Shared libraries
│       ├── clients/              # Client types, repository, schemas
│       ├── staff/                # Staff schemas, invitation helpers
│       ├── notes/                # Note & follow-up schemas
│       ├── metrics/              # Acceptance & reply metrics
│       ├── rules/                # Communication rules schemas
│       ├── onboarding/           # Onboarding step schemas
│       └── supabase/             # DB clients, middleware, auth guards
│
├── supabase/
│   ├── migrations/               # Database schema (26 tables)
│   └── functions/                # Edge Functions (Deno runtime)
│       ├── _shared/              # Shared utilities (types, context, tools, LLM)
│       │   ├── types.ts          # Core types (Client, Message, etc.)
│       │   ├── sprint2-types.ts  # Context types (GlobalContext, ReadOnlyContext)
│       │   ├── types/            # Extraction types
│       │   ├── context-assembly.ts    # Builds AI context from DB
│       │   ├── context-builders/      # Identity, agent, tools, business, memory
│       │   ├── agent-runtime.ts       # LLM tool-calling loop
│       │   ├── system-prompt.ts       # Composes system prompt
│       │   ├── tool-registry.ts       # 6 AI tools
│       │   ├── tool-executor.ts       # Tool execution with security
│       │   ├── action-executor.ts     # Approved action execution
│       │   ├── approval-policy.ts     # Tier assignment (auto/review/human_only)
│       │   ├── llm-client.ts          # OpenRouter + model config
│       │   ├── availability.ts        # Slot calculation (DST-safe)
│       │   ├── deadline-resolver.ts   # Natural language date parsing
│       │   └── reply-tracker.ts       # Client reply latency tracking
│       ├── process-message/      # Inbound WhatsApp message → AI draft
│       ├── categorize-note/      # Staff note → extracted actions
│       ├── classify-edits/       # Staff edits → learned patterns → rules
│       ├── approve-action/       # Staff approval → action execution
│       ├── embed-knowledge/      # Text → vector embeddings
│       ├── onboarding-tone/      # AI tone extraction
│       ├── onboarding-sops/      # AI SOP generation
│       ├── onboarding-scrape/    # Instagram scraper
│       ├── onboarding-activate/  # Onboarding completion gate
│       ├── cron-morning-coordinator/    # Fan-out: morning scan per workspace
│       ├── cron-morning-scan/           # Per-workspace: follow-ups, reminders
│       ├── cron-compaction-coordinator/ # Fan-out: memory compaction
│       ├── cron-compaction/             # Per-workspace: conversation summarization
│       ├── cron-timer-scanner/          # Process expired timers
│       └── cron-heartbeat/              # System health check
│
├── baileys-server/               # WhatsApp Web bridge
│   └── src/
│       ├── config.ts             # Server configuration
│       ├── socket-manager.ts     # Per-workspace WhatsApp connections
│       ├── auth-store.ts         # Credential persistence in Supabase
│       ├── message-handler.ts    # Inbound message → DB + pgmq
│       └── send-handler.ts       # Outbound message dispatch
│
├── global-context/               # LLM prompt templates (Markdown)
│   ├── role.md                   # Agent role definition + output format
│   ├── tools.md                  # Tool descriptions
│   ├── deep-research-sop.md      # SOP generation prompt
│   ├── tone-extraction.md        # Tone extraction prompt
│   ├── tone-adjustment.md        # Tone refinement prompt
│   ├── sop-refinement.md         # SOP refinement prompt
│   └── instagram-to-knowledge.md # Instagram data → KB prompt
│
└── .env.local.example            # Environment variable template
```

---

## 3. Database Schema — Tables & Customizable Fields

### 3.1 All Tables (26 total)

| # | Table | Purpose | Key Customization Points |
|---|-------|---------|--------------------------|
| 1 | `workspaces` | Business configuration | `vertical_config` (JSONB), `communication_profile` (JSONB), `business_hours` (JSONB), `tone_profile`, `calendar_config` |
| 2 | `staff` | Workspace members | Roles: owner/admin/member |
| 3 | `staff_invitations` | Invite workflow | Token-based, 7-day expiry |
| 4 | `clients` | Customer records | `preferences` (JSONB), `tags` (TEXT[]), `lifecycle_status` |
| 5 | `conversations` | WhatsApp threads | State machine: idle → awaiting_staff_review → awaiting_client_reply → follow_up_pending |
| 6 | `messages` | Message records | Direction, media support, delivery tracking |
| 7 | `drafts` | AI-generated replies | Intent classification, confidence scoring |
| 8 | `message_templates` | Pre-built templates | Category-based (greeting, confirmation, reminder) |
| 9 | `bookings` | Appointments | `appointment_type`, start/end time, confirmation status |
| 10 | `notes` | Staff observations | Trigger for `categorize-note` EF on INSERT |
| 11 | `follow_ups` | Action items | Type: follow_up/promise/reminder; status: open/completed/cancelled |
| 12 | `memories` | Compacted history | Type: conversation_summary/preferences/history |
| 13 | `proposed_actions` | AI recommendations | Tiered approval: auto/review/human_only |
| 14 | `knowledge_chunks` | RAG vectors | pgvector(1536) embeddings |
| 15 | `draft_edit_signals` | Learning data | Staff edit tracking for pattern learning |
| 16 | `edit_classifications` | Pattern analysis | Categories, severity, pattern keys |
| 17 | `pattern_recurrences` | Pattern frequency | Promotion thresholds: 3 occurrences, 2 clients |
| 18 | `communication_rules` | Learned rules | Auto-generated from patterns |
| 19 | `audit_events` | Immutable log | All operations tracked |
| 20 | `pending_timer` | Event timers | follow_up_reminder, booking_reminder |
| 21 | `daily_journal` | Daily summaries | Stats, narrative, alerts |
| 22 | `staff_notifications` | Realtime alerts | Supabase Realtime |
| 23 | `message_inbox` | Dedup cache | WhatsApp message ID uniqueness |
| 24 | `baileys_auth` | WhatsApp creds | Per-workspace session storage |
| 25 | `llm_usage` | Cost tracking | Per-function, per-model token counts |
| 26 | `cron_run_log` | Job audit | Execution history for scheduled jobs |

### 3.2 Critical Customization Points in the Schema

#### A. `clients.lifecycle_status` — **HARDCODED ENUM**

Current values:
```sql
CHECK (lifecycle_status IN (
  'open',                  -- New lead / first contact
  'chosen_service',        -- Selected a service
  'upcoming_appointment',  -- Has a booking scheduled
  'follow_up',             -- Needs follow-up
  'review_complete',       -- Service delivered, review done
  'inactive'               -- No activity for N days
))
```

**To customize:** You must modify the migration to add/change statuses for your vertical. See [Section 11.3](#113-step-3-customize-the-database-schema).

#### B. `clients.preferences` — **FLEXIBLE JSONB**

This is where all business-specific client data lives. No schema enforcement at the DB level — the AI extracts and writes to this field based on the `vertical_config.custom_fields` definition.

Example for a wedding dress shop:
```json
{
  "wedding_date": "2026-08-15",
  "dress_size": "UK 10",
  "height_cm": 165,
  "silhouette": "A-line",
  "neckline": "sweetheart",
  "budget_range": "HKD 15000-25000",
  "alteration_notes": "Hem needs shortening 2cm"
}
```

#### C. `workspaces.vertical_config` — **AI-GENERATED OR MANUAL**

Structure:
```json
{
  "sop_rules": [
    "Always confirm wedding date on first contact",
    "Discuss alteration timeline before booking fitting"
  ],
  "custom_fields": [
    { "name": "wedding_date", "description": "Client's wedding date" },
    { "name": "dress_size", "description": "UK dress size" }
  ],
  "appointment_types": [
    {
      "name": "Bridal Consultation",
      "description": "Initial dress browsing session",
      "duration_minutes": 60,
      "prerequisites": ["Know budget range"]
    }
  ],
  "lifecycle_stages": ["open", "chosen_service", "upcoming_appointment", "follow_up", "review_complete", "inactive"],
  "business_hours": {
    "monday": { "open": "10:00", "close": "19:00" },
    "tuesday": { "open": "10:00", "close": "19:00" },
    "sunday": { "open": "closed", "close": "closed" }
  }
}
```

#### D. `workspaces.tone_profile` — **AI-EXTRACTED OR MANUAL**

```json
{
  "voice": "warm, elegant, and reassuring",
  "formality": "balanced",
  "emoji_usage": "minimal",
  "greeting_style": "Hi [name]! Thank you for reaching out",
  "sign_off_style": "Looking forward to helping you find your dream dress!",
  "sample_responses": ["..."]
}
```

---

## 4. API Routes — Complete Reference

### 4.1 Authentication & Invitation

| Method | Path | Purpose | Auth Required |
|--------|------|---------|---------------|
| GET | `/api/auth/accept-invitation?token=X` | Validate invitation token, redirect to /invite | No |
| POST | `/api/auth/accept-invitation` | Complete invitation acceptance | Yes (logged-in user) |

### 4.2 Onboarding Pipeline (14 routes)

| Method | Path | Purpose | Auth Required |
|--------|------|---------|---------------|
| POST | `/api/onboarding/start` | Create workspace + owner staff | Yes |
| GET | `/api/onboarding/[id]/status` | Check onboarding progress | Yes (member) |
| PUT | `/api/onboarding/[id]/identity` | Set business name, vertical, timezone | Yes (member) |
| PUT | `/api/onboarding/[id]/knowledge-base` | Upload knowledge base text | Yes (member) |
| POST | `/api/onboarding/[id]/scrape-instagram` | Trigger Instagram scrape | Yes (member) |
| POST | `/api/onboarding/[id]/generate-sops` | AI-generate SOPs from business context | Yes (member) |
| POST | `/api/onboarding/[id]/refine-sops` | Iterate on SOPs with feedback | Yes (member) |
| PUT | `/api/onboarding/[id]/confirm-sops` | Lock in SOPs | Yes (member) |
| POST | `/api/onboarding/[id]/extract-tone` | AI-extract tone from Instagram/description | Yes (member) |
| POST | `/api/onboarding/[id]/refine-tone` | Iterate on tone with feedback | Yes (member) |
| PUT | `/api/onboarding/[id]/confirm-tone` | Lock in tone | Yes (member) |
| POST | `/api/onboarding/[id]/activate` | Mark onboarding complete | Yes (member) |
| POST | `/api/onboarding/[id]/orchestrate` | Auto-run all onboarding steps | Yes (member) |
| POST | `/api/onboarding/[id]/whatsapp/events` | WhatsApp webhook events | Yes (member) |
| GET | `/api/onboarding/[id]/whatsapp/refresh-qr` | Get new QR code | Yes (member) |

### 4.3 Dashboard

| Method | Path | Purpose | Auth Required |
|--------|------|---------|---------------|
| GET | `/api/today?workspace_id=X` | Today's bookings, action items, stats | Yes (member) |
| POST | `/api/today/refresh` | Trigger morning scan (rate-limited: 1/5min) | Yes (member) |

### 4.4 Client Management

| Method | Path | Purpose | Auth Required |
|--------|------|---------|---------------|
| GET | `/api/workspaces/[id]/clients` | List clients (filter, search, paginate) | Yes (member) |
| POST | `/api/workspaces/[id]/clients` | Create/upsert client by phone | Yes (member) |
| GET | `/api/workspaces/[id]/clients/[cid]` | Get single client | Yes (member) |
| PATCH | `/api/workspaces/[id]/clients/[cid]` | Update client (name, email, tags, preferences) | Yes (member) |
| DELETE | `/api/workspaces/[id]/clients/[cid]` | Soft-delete client | Yes (member) |
| PATCH | `/api/workspaces/[id]/clients/[cid]/lifecycle` | Update lifecycle status | Yes (member) |
| POST | `/api/workspaces/[id]/clients/merge` | Merge duplicate clients | Yes (member) |

### 4.5 Staff Management

| Method | Path | Purpose | Auth Required |
|--------|------|---------|---------------|
| GET | `/api/workspaces/[id]/staff` | List staff + pending invitations | Yes (member) |
| POST | `/api/workspaces/[id]/staff` | Invite new staff member | Yes (owner/admin) |
| GET | `/api/workspaces/[id]/staff/[sid]` | Get staff member | Yes (member) |
| PATCH | `/api/workspaces/[id]/staff/[sid]` | Update role/status | Yes (owner) |
| DELETE | `/api/workspaces/[id]/staff/[sid]` | Soft-delete staff | Yes (owner) |

### 4.6 Notes & Follow-ups

| Method | Path | Purpose | Auth Required |
|--------|------|---------|---------------|
| GET | `/api/workspaces/[id]/notes` | List notes (optional client_id filter) | Yes (member) |
| POST | `/api/workspaces/[id]/notes` | Create note (triggers AI extraction) | Yes (member) |
| DELETE | `/api/workspaces/[id]/notes/[nid]` | Delete note | Yes (member) |
| GET | `/api/workspaces/[id]/follow-ups` | List follow-ups (filter by client, status) | Yes (member) |
| POST | `/api/workspaces/[id]/follow-ups` | Create follow-up | Yes (member) |
| PATCH | `/api/workspaces/[id]/follow-ups/[fid]` | Update follow-up | Yes (member) |

### 4.7 Knowledge Base

| Method | Path | Purpose | Auth Required |
|--------|------|---------|---------------|
| GET | `/api/workspaces/[id]/knowledge` | List knowledge chunks | Yes (member) |
| POST | `/api/workspaces/[id]/knowledge` | Add + embed knowledge | Yes (member) |
| DELETE | `/api/workspaces/[id]/knowledge` | Delete all chunks by source | Yes (member) |
| PATCH | `/api/workspaces/[id]/knowledge/[kid]` | Update + re-embed chunk | Yes (member) |
| DELETE | `/api/workspaces/[id]/knowledge/[kid]` | Delete single chunk | Yes (member) |

### 4.8 Communication Rules & Metrics

| Method | Path | Purpose | Auth Required |
|--------|------|---------|---------------|
| GET | `/api/workspaces/[id]/rules` | List learned rules | Yes (member) |
| PATCH | `/api/workspaces/[id]/rules/[rid]` | Update rule instruction/active | Yes (member) |
| GET | `/api/workspaces/[id]/rules/[rid]/details` | Rule + pattern + recent edits | Yes (member) |
| GET | `/api/workspaces/[id]/metrics/acceptance?days=30` | AI draft acceptance rate | Yes (member) |
| GET | `/api/workspaces/[id]/metrics/replies?days=30` | Client reply rate + latency | Yes (member) |

---

## 5. Edge Functions — AI Pipeline

### 5.1 Message Processing Pipeline

```
WhatsApp msg → Baileys Server → DB + pgmq queue
                                       │
                                       v
                              process-message EF
                                       │
                    ┌──────────────────┼──────────────────┐
                    v                  v                  v
              Load Context      Search Knowledge     Load Rules
                    │                  │                  │
                    └──────────┬───────┘──────────────────┘
                               v
                    Compose System Prompt
                    (role + identity + SOPs + tone + rules)
                               │
                               v
                    ┌─────────────────────┐
                    │ Tool-Calling Loop   │
                    │ (max 5 iterations)  │
                    │                     │
                    │ Tools available:    │
                    │ - knowledge_search  │
                    │ - calendar_query    │
                    │ - calendar_book     │
                    │ - update_client     │
                    │ - create_note       │
                    │ - create_followup   │
                    └─────────┬───────────┘
                              v
                    Draft + ProposedActions
                              │
                    ┌─────────┴─────────┐
                    v                   v
              Save Draft         Queue Actions
              (Realtime)         (for staff approval)
```

### 5.2 Note Processing Pipeline

```
Staff creates note → DB INSERT → pg_net trigger
                                       │
                                       v
                              categorize-note EF
                                       │
                    ┌──────────────────┼──────────────────┐
                    v                  v                  v
              Load Client       Load Custom Fields   Load Open Promises
                    │                  │                  │
                    └──────────┬───────┘──────────────────┘
                               v
                    LLM Extraction (Haiku)
                               │
                    ┌──────────┼──────────┐
                    v          v          v
              FOLLOW_UP   PROMISE   CLIENT_UPDATE
              (task)      (commit)  (profile change)
                    │          │          │
                    └──────────┴──────────┘
                               v
                    proposed_actions (tier='review')
                    → Staff approves → action-executor
```

### 5.3 Learning Loop Pipeline

```
Staff edits AI draft → draft_edit_signals INSERT → pg_net trigger
                                                        │
                                                        v
                                               classify-edits EF
                                                        │
                                    ┌───────────────────┼───────────────────┐
                                    v                   v                   v
                              Classify Edit      Track Pattern       Check Threshold
                              (17 categories)    (upsert count)      (3 recurrences,
                                                                      2 clients)
                                                        │
                                                        v
                                               Threshold met?
                                               ┌────┴────┐
                                               No       Yes
                                               │         │
                                               v         v
                                             Wait   Generate Rule
                                                     (LLM instruction)
                                                         │
                                                         v
                                               communication_rules
                                               (injected into future prompts)
```

### 5.4 Scheduled Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `cron-morning-coordinator` | Daily 9 AM (workspace TZ) | Fan-out morning scan to all active workspaces |
| `cron-morning-scan` | Triggered by coordinator | Follow-up reminders, stale conversation detection, daily journal |
| `cron-compaction-coordinator` | Daily 3 AM (workspace TZ) | Fan-out memory compaction |
| `cron-compaction` | Triggered by coordinator | Summarize old conversations into memories |
| `cron-timer-scanner` | Every 3 minutes | Process expired timers (follow-up, booking reminders) |
| `cron-heartbeat` | Periodic | System health check, update `last_heartbeat_at` |

### 5.5 Onboarding Functions

| Function | Purpose | Model Used |
|----------|---------|------------|
| `onboarding-sops` | Generate/refine VerticalConfig (SOPs, custom fields, appointment types) | PRO_MODEL (Claude Sonnet) |
| `onboarding-tone` | Extract/refine ToneProfile from Instagram or description | FLASH_MODEL (Haiku) |
| `onboarding-scrape` | Scrape Instagram profile (bio, captions, category) | None (HTTP scraping) |
| `onboarding-activate` | Verify prerequisites and mark workspace ready | None (validation only) |

---

## 6. Shared Utilities & Type System

### 6.1 Key Types

**LifecycleStatus** — Client journey stages:
```typescript
'open' | 'chosen_service' | 'upcoming_appointment' | 'follow_up' | 'review_complete' | 'inactive'
```

**ConversationState** — Chat state machine:
```typescript
'idle' | 'awaiting_staff_review' | 'awaiting_client_reply' | 'follow_up_pending'
```

**IntentType** — What the client wants:
```typescript
'booking_inquiry' | 'pricing_question' | 'general_question' | 'follow_up' |
'greeting' | 'complaint' | 'cancellation' | 'reschedule' | 'out_of_scope'
```

**ProposedActionType** — What the AI wants to do:
```typescript
'client_update' | 'booking_create' | 'followup_create' | 'message_send' |
'note_create' | 'last_contacted_update' | 'tag_attach'
```

**ApprovalTier** — Who decides:
```typescript
'auto'        // System executes immediately (currently: nothing)
'review'      // Staff sees in queue, approves/rejects (currently: everything)
'human_only'  // Cannot be auto-approved (currently: nothing)
```

### 6.2 AI Tool Registry

| Tool | Authority | What It Does |
|------|-----------|-------------|
| `knowledge_search` | read | Semantic search over knowledge base (RAG) |
| `calendar_query` | read | Check available time slots |
| `calendar_book` | propose_write | Propose a booking (needs approval) |
| `update_client` | propose_write | Propose client profile changes (needs approval) |
| `create_note` | propose_write | Create an observation note (needs approval) |
| `create_followup` | propose_write | Propose a follow-up task (needs approval) |

### 6.3 Context Assembly

The AI's context is built from multiple sources, loaded in parallel:

| Data Source | Max Items | Purpose |
|-------------|-----------|---------|
| Client profile | 1 | Name, phone, preferences, lifecycle, summary |
| Recent messages | 10 | Conversation history |
| Knowledge chunks | Token-budgeted (2000) | RAG search results |
| Active bookings | 5 | Upcoming appointments |
| Open follow-ups | 5 | Pending tasks |
| Recent notes | 5 | Staff observations |
| Communication rules | 20 | Learned editing preferences |
| Compact summary | 1 | Long-term memory |

---

## 7. WhatsApp Integration (Baileys Server)

### 7.1 Architecture

- **Connection method:** QR code scan (like WhatsApp Web)
- **Library:** `@whiskeysockets/baileys` v7.0
- **Per-workspace:** Each workspace has its own WhatsApp connection
- **Credentials:** Stored in Supabase `baileys_auth` table (encrypted)
- **Auto-reconnect:** Exponential backoff on disconnect (max 60s)

### 7.2 API Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /health` | None | Health check |
| `POST /send` | X-Api-Secret | Send message: `{ workspaceId, to: "+852...", content: "..." }` |
| `GET /qr/:workspaceId` | X-Api-Secret | Get QR code for workspace |
| `POST /reconnect/:workspaceId` | X-Api-Secret | Force reconnection |

### 7.3 Inbound Message Flow

```
WhatsApp msg received
    → extractMessageContent() (text, media type, caption)
    → Dedup check (message_inbox table)
    → Find/create client by phone number
    → Find/create conversation
    → INSERT into messages table
    → Enqueue to pgmq for async AI processing
```

### 7.4 Supported Message Types

- Plain text
- Extended text (replies, links)
- Images (with caption)
- Audio / voice notes
- Video
- Documents

---

## 8. Environment Variables & Placeholders

### 8.1 Required — Must Set Before Running

| Variable | Where | Purpose | Example |
|----------|-------|---------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | `.env.local` | Supabase project URL | `https://abc.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `.env.local` | Supabase anon key (public) | `eyJ...` |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` | Supabase service role key (secret) | `eyJ...` |
| `OPENROUTER_API_KEY` | `.env.local` + EF secrets | LLM API access | `sk-or-...` |
| `SUPABASE_URL` | `baileys-server/.env` | Same as above | `https://abc.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | `baileys-server/.env` | Same as above | `eyJ...` |
| `API_SECRET` | `baileys-server/.env` | Baileys auth (min 16 chars) | `my-secret-key-here-1234` |

### 8.2 Optional — Have Defaults

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRO_MODEL` | `anthropic/claude-sonnet-4-20250514` | Primary LLM (drafting, SOP generation) |
| `FLASH_MODEL` | `anthropic/claude-haiku-4-5-20251001` | Fast LLM (classification, extraction) |
| `SMALL_MODEL` | `anthropic/claude-haiku-4-5-20251001` | Cheapest LLM (simple tasks) |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model for RAG |
| `BAILEYS_SERVER_URL` | `http://localhost:3001` | WhatsApp server address |
| `BAILEYS_API_SECRET` | (none) | Must match baileys-server API_SECRET |
| `PORT` (baileys) | `3001` | Baileys server port |

### 8.3 Edge Function Secrets (set via Supabase CLI)

```bash
supabase secrets set OPENROUTER_API_KEY=sk-or-...
supabase secrets set SUPABASE_URL=https://abc.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...
supabase secrets set BAILEYS_SERVER_URL=https://your-baileys.railway.app
supabase secrets set BAILEYS_API_SECRET=my-secret-key-here-1234
```

---

## 9. Hardcoded Values That May Need Changing

These values are embedded in code and require code changes to modify:

### 9.1 In Database Migrations

| Value | Location | Current | To Change |
|-------|----------|---------|-----------|
| `lifecycle_status` enum | `migrations/20260318000001_initial_schema.sql` | 6 values (open, chosen_service, etc.) | Add new migration with ALTER |
| `conversation.state` enum | Same | 4 values | Add new migration |
| `timer_type` values | `migrations/..._proactive_operations.sql` | follow_up_reminder, booking_reminder | Add new migration |
| Invitation expiry | `src/lib/staff/invitation.ts` | 7 days | Change `INVITATION_EXPIRY_DAYS` |

### 9.2 In Edge Functions

| Value | Location | Current | To Change |
|-------|----------|---------|-----------|
| Intent taxonomy | `_shared/sprint2-types.ts` | 9 intents | Add to `INTENT_TAXONOMY` array |
| Edit categories | `classify-edits/index.ts` | 17 categories | Modify system prompt |
| Pattern promotion threshold | `classify-edits/index.ts` | 3 recurrences, 2 clients | Change constants |
| DLQ threshold | `process-message/index.ts` | 3 retries | Change `read_ct > 3` |
| Tool-calling max loops | `_shared/agent-runtime.ts` | 5 iterations | Change constant |
| Knowledge chunk size | `embed-knowledge/index.ts` | 500 chars | Change chunking logic |
| Context token budget | `_shared/context-assembly.ts` | 2000 tokens | Change constant |
| Recent messages loaded | `_shared/context-assembly.ts` | 10 messages | Change LIMIT |
| Stale conversation timeout | Timer creation logic | 24 hours | Change timer trigger_at |
| Draft review nudge | Timer creation logic | 5 minutes | Change timer trigger_at |
| Morning scan time | pg_cron config | 01:00 UTC (9 AM HK) | Modify cron schedule |
| Compaction time | pg_cron config | 19:00 UTC (3 AM HK) | Modify cron schedule |
| Timer scan interval | pg_cron config | Every 3 minutes | Modify cron schedule |

### 9.3 In API Routes

| Value | Location | Current | To Change |
|-------|----------|---------|-----------|
| Morning scan rate limit | `api/today/refresh/route.ts` | 5 minutes | Change constant |
| Insufficient data threshold | `src/lib/metrics/schemas.ts` | 10 signals | Change `INSUFFICIENT_DATA_THRESHOLD` |
| Reply pending window | `src/lib/metrics/schemas.ts` | 72 hours | Change `REPLY_PENDING_WINDOW_HOURS` |
| Note max length | `src/lib/notes/schemas.ts` | 10,000 chars | Change Zod schema |
| Knowledge max length | `src/lib/notes/schemas.ts` | 50,000 chars | Change Zod schema |
| Pagination default | `src/lib/clients/repository.ts` | 20 per page | Change default |
| Follow-up "active" window | Follow-up route | 7 days | Change query filter |

### 9.4 In LLM Prompts

| Prompt | Location | Purpose | To Customize |
|--------|----------|---------|--------------|
| Agent role | `global-context/role.md` | Defines AI persona | Edit for vertical-specific behavior |
| Tool descriptions | `global-context/tools.md` | What tools the AI knows about | Add new tools or modify descriptions |
| SOP generation | `global-context/deep-research-sop.md` | How SOPs are generated | Edit for better vertical coverage |
| Tone extraction | `global-context/tone-extraction.md` | How tone is extracted | Edit for vertical-specific tone |

---

## 10. Customizable Settings (No Code Changes)

These are configured through the onboarding flow or API calls — no code changes needed:

| Setting | Configured Via | Stored In | Affects |
|---------|---------------|-----------|---------|
| Business name | Onboarding identity step | `workspaces.business_name` | AI prompts, notifications |
| Vertical type | Onboarding identity step | `workspaces.vertical_type` | SOP generation seed |
| Timezone | Onboarding identity step | `workspaces.timezone` | All time calculations |
| Instagram handle | Onboarding identity step | `workspaces.instagram_handle` | Scraping, tone extraction |
| SOP rules | Onboarding SOP step (AI or manual) | `workspaces.vertical_config.sop_rules` | AI behavior rules |
| Custom fields | Onboarding SOP step (AI or manual) | `workspaces.vertical_config.custom_fields` | Note extraction targets |
| Appointment types | Onboarding SOP step (AI or manual) | `workspaces.vertical_config.appointment_types` | Booking creation |
| Business hours | Onboarding SOP step | `workspaces.vertical_config.business_hours` | Availability calculation |
| Tone profile | Onboarding tone step (AI or manual) | `workspaces.tone_profile` | AI message style |
| Knowledge base | Onboarding knowledge step | `knowledge_chunks` table | RAG search results |
| Communication rules | Auto-learned from staff edits | `communication_rules` table | AI draft adjustments |
| Follow-up check days | API/DB | `workspaces.follow_up_check_days` (default 3) | Morning scan timing |
| Follow-up max attempts | API/DB | `workspaces.follow_up_max_attempts` (default 3) | Retry limit |
| Confirmation check days | API/DB | `workspaces.confirmation_check_days` (default 2) | Booking reminder timing |
| Inactivity days | API/DB | `workspaces.inactivity_days` (default 30) | Client → inactive |
| Reminder mode | API/DB | `workspaces.reminder_mode` (template/ai_draft) | Reminder style |

---

## 11. Step-by-Step: Customizing for a New Business

### 11.1 Step 1: Deep Research on the Business Vertical

**Before touching any code**, research the target business to understand:

1. **Client journey stages** — What are the steps from first contact to completed service?
2. **Critical client data** — What information MUST be captured about each client?
3. **Appointment types** — What services are offered? Duration? Prerequisites?
4. **Communication style** — How formal? Emoji use? Greeting patterns?
5. **SOP rules** — What should the AI always/never do?
6. **Follow-up patterns** — When should clients be contacted proactively?
7. **Knowledge base content** — FAQs, pricing, policies, service descriptions
8. **Pain points** — What manual tasks cause the most frustration?

**Deliverable:** A business profile document covering all the above.

### 11.2 Step 2: Set Up Infrastructure

```bash
# 1. Create Supabase project
# Go to supabase.com, create new project

# 2. Clone the template
git clone <repo-url> my-crm
cd my-crm

# 3. Copy env template
cp .env.local.example .env.local
# Fill in Supabase URL, keys, OpenRouter API key

# 4. Set up Baileys server
cd baileys-server
cp .env.example .env  # or create .env
# Fill in Supabase URL, keys, API_SECRET

# 5. Run database migrations
npx supabase db push

# 6. Deploy Edge Functions
npx supabase functions deploy

# 7. Set Edge Function secrets
supabase secrets set OPENROUTER_API_KEY=sk-or-...
supabase secrets set BAILEYS_SERVER_URL=https://...
supabase secrets set BAILEYS_API_SECRET=...

# 8. Start dev servers
npm run dev          # Next.js on :3000
cd baileys-server && npm run dev  # Baileys on :3001
```

### 11.3 Step 3: Customize the Database Schema

If the default `lifecycle_status` values don't fit your business, create a new migration:

```sql
-- supabase/migrations/YYYYMMDDHHMMSS_custom_lifecycle.sql

-- Example: Pet grooming business
ALTER TABLE clients DROP CONSTRAINT clients_lifecycle_status_check;
ALTER TABLE clients ADD CONSTRAINT clients_lifecycle_status_check
  CHECK (lifecycle_status IN (
    'inquiry',              -- First contact
    'consultation_booked',  -- Has a consultation scheduled
    'service_selected',     -- Chose a grooming package
    'appointment_booked',   -- Has appointment
    'in_service',           -- Currently being groomed
    'completed',            -- Service done
    'follow_up',            -- Needs follow-up
    'inactive'              -- Dormant
  ));
```

**Also update** the TypeScript types to match:
- `src/lib/clients/types.ts` — `LIFECYCLE_STATUSES` array
- `src/lib/onboarding/schemas.ts` — `confirmSopsSchema.lifecycle_stages`

### 11.4 Step 4: Customize Intent Taxonomy (If Needed)

If your business has unique intent types (e.g., "warranty_claim" for auto repair), add them:

**File:** `supabase/functions/_shared/sprint2-types.ts`
```typescript
export const INTENT_TAXONOMY = [
  'booking_inquiry',
  'pricing_question',
  // ... existing
  'warranty_claim',      // NEW
  'parts_availability',  // NEW
] as const;
```

### 11.5 Step 5: Prepare Knowledge Base Content

Write comprehensive knowledge base content for the business. This is the AI's reference material.

**Structure your KB content:**
```
## Services & Pricing
[All services with prices, durations, what's included]

## Frequently Asked Questions
[Common questions and answers]

## Policies
[Cancellation, refund, rescheduling, deposits]

## Process & What to Expect
[Step-by-step of the client experience]

## Care Instructions / Aftercare
[Post-service guidance]

## About the Business
[History, team, values, specialties]
```

### 11.6 Step 6: Run the Onboarding Flow

Use the API to onboard the business:

```bash
# 1. Start onboarding
curl -X POST /api/onboarding/start \
  -d '{"owner_name":"Jane","owner_phone":"+85291234567","owner_email":"jane@example.com"}'
# Returns: { workspace_id: "..." }

# 2. Connect WhatsApp (scan QR code via mobile app)

# 3. Set identity
curl -X PUT /api/onboarding/{workspace_id}/identity \
  -d '{"business_name":"Bella Bridal","vertical":"wedding_dress","timezone":"Asia/Hong_Kong"}'

# 4. Upload knowledge base
curl -X PUT /api/onboarding/{workspace_id}/knowledge-base \
  -d '{"content":"[your KB text]","source":"onboarding"}'

# 5. Generate SOPs (AI will research the vertical and generate config)
curl -X POST /api/onboarding/{workspace_id}/generate-sops \
  -d '{"vertical":"wedding_dress","business_name":"Bella Bridal","knowledge_base":"[KB text]"}'

# 6. Review and refine SOPs
curl -X POST /api/onboarding/{workspace_id}/refine-sops \
  -d '{"instruction":"Add wedding date as a required custom field","current_config":{...}}'

# 7. Confirm SOPs
curl -X PUT /api/onboarding/{workspace_id}/confirm-sops \
  -d '{"vertical_config":{...final config...}}'

# 8. Extract tone (from Instagram or description)
curl -X POST /api/onboarding/{workspace_id}/extract-tone \
  -d '{"source":"description","content":"We are an elegant bridal boutique..."}'

# 9. Confirm tone
curl -X PUT /api/onboarding/{workspace_id}/confirm-tone \
  -d '{"tone_profile":{...final tone...}}'

# 10. Activate
curl -X POST /api/onboarding/{workspace_id}/activate
```

### 11.7 Step 7: Customize LLM Prompts (If Needed)

For most businesses, the onboarding flow handles customization through `vertical_config` and `tone_profile`. But for deep customization:

**File:** `global-context/role.md`
- Modify the AI's persona, behavioral guidelines, output format

**File:** `global-context/deep-research-sop.md`
- Improve SOP generation quality for specific verticals

**File:** `supabase/functions/_shared/system-prompt.ts`
- Change how the system prompt is composed

### 11.8 Step 8: Build the Mobile App

The mobile app consumes the API routes documented in [Section 4](#4-api-routes--complete-reference). Build screens for:

1. **Login / Invitation acceptance** — `/api/auth/*`
2. **Dashboard** — `/api/today`
3. **Client list** — `/api/workspaces/[id]/clients`
4. **Client detail** — `/api/workspaces/[id]/clients/[cid]`
5. **Chat / draft review** — Supabase Realtime subscription on `drafts` and `messages`
6. **Action queue** — `proposed_actions` with approve/reject buttons
7. **Notes** — `/api/workspaces/[id]/notes`
8. **Follow-ups** — `/api/workspaces/[id]/follow-ups`
9. **Settings** — Staff management, rules, knowledge base
10. **Onboarding wizard** — Multi-step form calling onboarding routes

### 11.9 Step 9: Test & Iterate

1. Send test WhatsApp messages to the connected number
2. Verify AI drafts are contextually appropriate
3. Edit drafts — the learning loop will start detecting patterns
4. Create notes — verify extraction works for your custom fields
5. Check the dashboard — bookings, action items, stats
6. Monitor LLM costs via `llm_usage` table

---

## 12. Example: Wedding Dress Business

### 12.1 Business Research

**Client Journey:**
1. **Inquiry** → Bride contacts via WhatsApp asking about dresses
2. **Consultation Booked** → First appointment to browse dresses
3. **Dress Chosen** → Selected a dress, deposit paid
4. **Fitting Scheduled** → Alteration appointments (typically 2-3 fittings)
5. **Final Fitting** → Last check before wedding
6. **Completed** → Dress delivered
7. **Follow-up** → Post-wedding thank you, referral request

**Critical Client Data:**
- Wedding date (hard deadline!)
- Bride's height, size (UK sizing)
- Dress silhouette preference (A-line, mermaid, ballgown, etc.)
- Neckline preference
- Budget range
- Venue type (affects dress recommendations)
- Bridal party size (for bridesmaid dresses upsell)
- Alteration notes

**Appointment Types:**
| Type | Duration | Prerequisites |
|------|----------|---------------|
| Bridal Consultation | 60 min | None |
| Bridesmaid Group | 90 min | Min 3 attendees |
| First Fitting | 45 min | Dress ordered + arrived |
| Second Fitting | 30 min | First fitting complete |
| Final Fitting | 30 min | All alterations done |
| Dress Pickup | 15 min | Final fitting approved |

**SOP Rules:**
1. Always ask for wedding date on first contact
2. Never quote exact prices via WhatsApp — invite to consultation
3. If wedding is < 4 months away, flag as urgent
4. Always confirm alteration timeline with client
5. Send fitting reminder 48 hours before appointment
6. After final fitting, ask for Google review
7. Suggest bridesmaid dress consultation after bridal dress chosen

### 12.2 Database Changes

```sql
-- Migration: custom lifecycle for wedding dress
ALTER TABLE clients DROP CONSTRAINT clients_lifecycle_status_check;
ALTER TABLE clients ADD CONSTRAINT clients_lifecycle_status_check
  CHECK (lifecycle_status IN (
    'inquiry',
    'consultation_booked',
    'dress_chosen',
    'fitting_scheduled',
    'final_fitting',
    'completed',
    'follow_up',
    'inactive'
  ));
```

### 12.3 Vertical Config (via onboarding or API)

```json
{
  "sop_rules": [
    "Always ask for the wedding date on first contact — this determines all timelines",
    "Never quote exact dress prices via WhatsApp — invite to an in-store consultation",
    "If wedding date is less than 4 months away, flag the inquiry as URGENT",
    "Always explain the alteration timeline: typically 3 fittings over 6-8 weeks",
    "Send fitting reminder 48 hours before each appointment",
    "After final fitting, ask the bride for a Google review",
    "When bride chooses a dress, suggest a bridesmaid consultation",
    "Always ask about accessories (veil, tiara, shoes) at first fitting"
  ],
  "custom_fields": [
    { "name": "wedding_date", "description": "The bride's wedding date (critical deadline)" },
    { "name": "dress_size", "description": "UK dress size (6-30)" },
    { "name": "height_cm", "description": "Height in centimeters" },
    { "name": "silhouette", "description": "Preferred dress silhouette (A-line, mermaid, ballgown, sheath, fit-and-flare)" },
    { "name": "neckline", "description": "Preferred neckline (sweetheart, V-neck, off-shoulder, strapless, halter)" },
    { "name": "budget_range", "description": "Budget range in HKD" },
    { "name": "venue_type", "description": "Wedding venue type (outdoor, indoor, beach, church, hotel)" },
    { "name": "bridal_party_size", "description": "Number of bridesmaids" },
    { "name": "alteration_notes", "description": "Specific alteration requirements" }
  ],
  "appointment_types": [
    { "name": "Bridal Consultation", "description": "Initial dress browsing session", "duration_minutes": 60 },
    { "name": "Bridesmaid Group", "description": "Group session for bridesmaid dresses", "duration_minutes": 90, "prerequisites": ["Minimum 3 attendees"] },
    { "name": "First Fitting", "description": "First alteration fitting", "duration_minutes": 45, "prerequisites": ["Dress arrived in store"] },
    { "name": "Second Fitting", "description": "Second alteration fitting", "duration_minutes": 30, "prerequisites": ["First fitting completed"] },
    { "name": "Final Fitting", "description": "Final check before wedding", "duration_minutes": 30, "prerequisites": ["All alterations completed"] },
    { "name": "Dress Pickup", "description": "Collect finished dress", "duration_minutes": 15, "prerequisites": ["Final fitting approved"] }
  ],
  "lifecycle_stages": ["inquiry", "consultation_booked", "dress_chosen", "fitting_scheduled", "final_fitting", "completed", "follow_up", "inactive"],
  "business_hours": {
    "monday": { "open": "11:00", "close": "19:00" },
    "tuesday": { "open": "11:00", "close": "19:00" },
    "wednesday": { "open": "11:00", "close": "19:00" },
    "thursday": { "open": "11:00", "close": "20:00" },
    "friday": { "open": "11:00", "close": "20:00" },
    "saturday": { "open": "10:00", "close": "18:00" },
    "sunday": { "open": "12:00", "close": "17:00" }
  }
}
```

### 12.4 Tone Profile

```json
{
  "voice": "warm, elegant, and genuinely excited for each bride",
  "formality": "balanced",
  "emoji_usage": "minimal",
  "greeting_style": "Hi [name]! Thank you so much for reaching out to us",
  "sign_off_style": "We can't wait to help you find your perfect dress! 💍",
  "sample_responses": [
    "Hi Sarah! We'd love to help you find your dream wedding dress. Could you tell us your wedding date so we can make sure we have plenty of time for fittings?",
    "That's wonderful — congratulations on your upcoming wedding! We have a beautiful selection of A-line dresses. Would you like to book a bridal consultation? We recommend allowing 60 minutes so you can try on several styles."
  ]
}
```

### 12.5 Knowledge Base Content (excerpt)

```
## Bella Bridal — Knowledge Base

### Services
- Bridal Consultation: 60-minute private session, browse our collection of 200+ dresses
- Price range: HKD 8,000 — HKD 80,000
- Alterations included in dress purchase (up to 3 fittings)
- Bridesmaid dresses: HKD 1,500 — HKD 5,000

### Process
1. Book a Bridal Consultation (no charge)
2. Try on dresses with your stylist
3. Choose your dress, pay 50% deposit
4. Dress ordered (8-12 weeks delivery)
5. Three fitting appointments over 6-8 weeks
6. Final fitting 2 weeks before wedding
7. Dress pickup 1 week before wedding

### Cancellation Policy
- Deposit is non-refundable
- Free rescheduling up to 48 hours before appointment
- Late cancellation: HKD 500 fee

### FAQs
Q: How far in advance should I shop for my dress?
A: We recommend 9-12 months before your wedding for the best selection and ample time for alterations.

Q: Can I bring guests to my consultation?
A: Of course! We recommend a small group (2-3 people) for the best experience.

Q: Do you offer plus-size dresses?
A: Yes, we carry sizes UK 6-30 and can order any dress in your size.
```

---

## 13. Checklist: Before Going Live

### Infrastructure
- [ ] Supabase project created and configured
- [ ] Database migrations applied
- [ ] Edge Functions deployed
- [ ] All environment variables / secrets set
- [ ] Baileys server deployed (Railway, Fly.io, etc.)
- [ ] WhatsApp number connected via QR code

### Business Configuration
- [ ] Business name and vertical set
- [ ] Timezone configured correctly
- [ ] Knowledge base uploaded and embedded
- [ ] SOPs generated/refined and confirmed
- [ ] Tone profile extracted/refined and confirmed
- [ ] Business hours set
- [ ] Custom fields defined for the vertical
- [ ] Appointment types defined with durations

### Database Customization (if needed)
- [ ] `lifecycle_status` enum updated for vertical
- [ ] New migration created and applied
- [ ] TypeScript types updated to match schema changes
- [ ] Intent taxonomy extended (if needed)

### Testing
- [ ] Send test WhatsApp message → verify AI draft generated
- [ ] Review and edit a draft → verify learning signal created
- [ ] Create a note → verify extraction produces correct actions
- [ ] Approve a proposed action → verify execution works
- [ ] Check dashboard shows correct data
- [ ] Verify timezone calculations are correct
- [ ] Test invitation flow end-to-end
- [ ] Monitor `llm_usage` table for cost tracking

### Mobile App
- [ ] All API routes integrated
- [ ] Supabase Realtime subscriptions working (drafts, messages, notifications)
- [ ] Push notifications configured
- [ ] Login / invitation acceptance flow working
- [ ] Client list with search and filters
- [ ] Chat view with draft review
- [ ] Action queue with approve/reject
- [ ] Notes and follow-ups
- [ ] Settings (staff, rules, knowledge)

### Monitoring
- [ ] `cron_run_log` shows successful job executions
- [ ] `llm_usage` costs within budget
- [ ] `audit_events` tracking all operations
- [ ] WhatsApp connection stable (check `last_heartbeat_at`)
- [ ] Error rates acceptable in Edge Function logs

---

## Appendix A: Quick Reference — What Changes Where

| What You Want to Change | Where to Change It |
|-------------------------|--------------------|
| Client journey stages | DB migration (lifecycle_status CHECK) + `src/lib/clients/types.ts` |
| Client data fields | `vertical_config.custom_fields` (via onboarding) |
| AI behavior rules | `vertical_config.sop_rules` (via onboarding) |
| AI communication style | `workspaces.tone_profile` (via onboarding) |
| Service types | `vertical_config.appointment_types` (via onboarding) |
| Operating hours | `vertical_config.business_hours` (via onboarding) |
| FAQ / pricing / policies | Knowledge base content (via API) |
| AI persona | `global-context/role.md` |
| What tools AI has | `_shared/tool-registry.ts` |
| Auto-approval rules | `_shared/approval-policy.ts` |
| LLM models used | Environment variables |
| How often crons run | pg_cron schedule (DB config) |
| Follow-up timing | `workspaces.follow_up_check_days` |
| Inactivity threshold | `workspaces.inactivity_days` |
| Message intents | `_shared/sprint2-types.ts` INTENT_TAXONOMY |
| Staff roles | DB migration + `src/lib/staff/schemas.ts` |

## Appendix B: Adding a New AI Tool

To give the AI a new capability (e.g., "check inventory"):

1. **Define the tool** in `supabase/functions/_shared/tool-registry.ts`:
   ```typescript
   {
     name: 'check_inventory',
     authority: 'read',
     description: 'Check product availability',
     parameters: { query: { type: 'string', description: 'Product to search for' } }
   }
   ```

2. **Implement the executor** in `supabase/functions/_shared/tool-executor.ts`:
   ```typescript
   case 'check_inventory':
     return await checkInventory(supabase, args.query, session.workspaceId);
   ```

3. **Update the prompt** in `global-context/tools.md` to describe when to use it.

## Appendix C: Adding a New Timer Type

To add a new scheduled event (e.g., "wedding_date_approaching"):

1. **Create the timer** using the RPC:
   ```sql
   SELECT create_or_reset_timer(
     workspace_id, 'wedding_date_approaching', 'client', client_id,
     wedding_date - INTERVAL '30 days', '{"reminder_type": "30_day_countdown"}'
   );
   ```

2. **Handle it** in `supabase/functions/cron-timer-scanner/index.ts`:
   ```typescript
   case 'wedding_date_approaching':
     // Create notification or draft a proactive message
     break;
   ```

3. **Add the timer_type** to the DB constraint if it has one (check migration).
