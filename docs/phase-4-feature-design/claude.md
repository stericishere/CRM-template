# phase-4-feature-design — Decisions & Context

## Date
2026-03-18

## Summary

Feature design complete. 15 features derived from 78 PRD functions, organized into 5 sprints (~14 weeks total). Used SADD patterns: `do-and-judge` for feature list (CEO + Eng reviews), `do-in-steps` for user stories and specs, `judge-with-debate` for prioritization (three-lens debate: user value, technical risk, strategic alignment).

## Sprint 1 Scope Locked

| Feature | Size | What Ships |
|---------|------|------------|
| F-02: WhatsApp Message Pipeline | L | Baileys QR pairing, pgmq queue, message storage, session health |
| F-03: Client Identity & Profile | M | Phone-to-client resolution, lifecycle status, vertical custom fields |
| F-04: Staff Notifications & Audit | M | Supabase Realtime notifications, audit event logging |

**Exit criteria:** Messages flow end-to-end from WhatsApp → pgmq → staff app. Baileys survives container restart. Audit trail logs all mutations.

## Key Decisions

- **WhatsApp model confirmed:** QR code pairing via Baileys (like OpenClaw). No WABA, no Cloud API. PRD and architecture-final.md both aligned.
- **Feature grouping:** 78 PRD functions grouped into 15 cohesive features (not 1:1). Each feature is a deliverable unit of user value.
- **JTBD mapping corrected:** F-05 (AI Drafting) is primary server of client JTBD "ask a question quickly", not F-08 (Media). F-08 serves staff-facing JTBD only.
- **Lead nurturing added:** Owner requested proactive lead detection — woven into F-09 (follow-up creation), F-12 (COS warm lead surfacing), F-13 (buying signal detection).
- **Today's View is SQL, not LLM:** Per architecture-final.md, COS prioritization in MVP is deterministic SQL-based urgency heuristics, not an LLM call.
- **F-10 (Learning Signals) ships with F-05:** S-sized effort, every day of lost signal data is permanent. All three priority agents agreed.
- **Governance (F-06) ships with F-05:** Agent C's argument prevailed — the three-tier trust model is positioning, not overhead. "Copilot, not chatbot" is real only with approval boundaries.

## Onboarding Flow Decisions

- QR code scan creates workspace (not "owner messages system")
- Instagram scrape → draft knowledge base (with manual fallback if unavailable)
- Deep research generates vertical-specific SOPs
- Owner refines all outputs conversationally
- Google Calendar connected later (progressive enhancement)
- Existing WhatsApp conversation history imported on first connection

## Deferred Features (with rationale)

| Feature | Sprint | Rationale |
|---------|--------|-----------|
| F-08: Media Processing | Sprint 3 (stretch) | Text dominates business inquiries; voice notes and images are incremental value |
| F-13: Intelligent Note Processing | Sprint 5 | High concept, 65% confidence; manual notes (F-09) capture most value first |
| F-15: Learning Loop | Sprint 5 | Needs weeks of production signal data before analysis delivers value. XL effort. |
| Lightweight Today's View | Consider for late Sprint 3 | CEO review suggested pulling a basic view (SQL aggregation, no LLM) earlier than full F-12 |

## Key User Story Edge Cases

- **QR code expiry:** Session persistence with stored credentials; re-scan prompt when session is revoked
- **Booking conflicts:** Slots checked but not locked at query time; conflicts caught at approval time with alternatives proposed
- **Compaction data loss:** Flush-before-compact invariant ensures async extractions complete before summarization
- **Client merge:** Atomic transaction transfers all records; immutable merge-history note preserves audit trail
- **Promise extraction:** Relative dates ("next Thursday") resolved to absolute using workspace timezone; past dates created as overdue
- **Learning rule safety:** Promotion threshold (3+ occurrences, 2+ clients, 30 days) prevents noisy rules; staff can disable in Settings

## Architecture Alignment Audit

All 15 specs verified against `architecture-final.md`. Fixed stale references in F-01, F-02, F-03 (BullMQ → pgmq, Fastify → Node.js, Fly.io → Railway, Cloud API → Baileys). Remaining specs (F-04 through F-15) were clean.

## Inputs Used

- PRD v2.1 (`docs/phase-1-ideation/prd.md`)
- Architecture Final (`docs/phase-3-architecture/architecture-final.md`)
- Architecture CLAUDE.md (`docs/phase-3-architecture/claude.md`)
- ADRs 001-005 (`docs/phase-3-architecture/adr/`)
- Owner feedback: WhatsApp QR model, lead nurturing JTBD

## Outputs Produced

- `docs/phase-4-feature-design/feature-list.md` — 15 features, 78 functions, all 7 bounded contexts
- `docs/phase-4-feature-design/user-stories/` — 15 files (F-01 through F-15), ~90 user stories total
- `docs/phase-4-feature-design/feature-specs/` — 15 implementable specs with component breakdowns, data models, API endpoints, edge cases, and AC-to-task mappings
- `docs/phase-4-feature-design/priority-stack.md` — 5-sprint plan synthesized from 3-lens debate
- `.specs/reports/priority-value-2026-03-18.md` — RICE analysis
- `.specs/reports/priority-risk-2026-03-18.md` — Technical risk analysis
- `.specs/reports/priority-strategy-2026-03-18.md` — Strategic alignment analysis

## Open Questions

1. **Baileys session stability at scale** — How many concurrent WhatsApp sessions can one Railway server handle? Need load testing.
2. **Instagram scraping reliability** — Anti-scraping changes frequently. Manual knowledge entry fallback is designed but not preferred.
3. **Embedding model evaluation** — text-embedding-3-small chosen for cost. May need comparison with alternatives for knowledge search quality.
4. **Scenario type taxonomy** — The `scenario_type` field on drafts needs a defined enum before Sprint 2 (first_contact, reschedule, reminder, etc.)
5. **Async note categorization runtime** — Architecture doesn't define where NF-02 LLM call lives. Specs propose pg_net trigger → categorize-note Edge Function.

## Next Phase

Sprint 1 scope locked → `/phase-5-implementation`
