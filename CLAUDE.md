# CRM Template — Project CLAUDE.md

## Identity

CRM template application. Solo founder building a CRM SaaS product following the 10-phase app development lifecycle:
ideation -> strategy -> design -> architecture -> feature design -> implementation -> review -> marketing -> testing -> CI/CD -> feature requests -> loop.

## Tech Stack

### Web
- Framework: Next.js (App Router)
- Language: TypeScript (strict mode, no `any`)
- Styling: Tailwind CSS
- Components: shadcn/ui
- State: React hooks + Zustand (when needed)
- Auth: Supabase Auth
- Database: Supabase (PostgreSQL)
- Payments: Stripe
- Hosting: Vercel

### Shared Conventions
- Functional components only, hooks only
- Error boundaries on all route segments
- Explicit over clever
- Minimal diff: achieve goals with fewest new abstractions
- DRY is important — flag repetition aggressively
- Well-tested code is non-negotiable
- ASCII diagrams in code comments for complex flows

## Coding Standards

### TypeScript
- `strict: true` in tsconfig
- No `any` — use `unknown` with type guards
- Prefer `interface` over `type` for object shapes
- Use discriminated unions for state machines
- Barrel exports from feature directories

### React / Next.js
- Server Components by default, `'use client'` only when needed
- Colocate components with their routes
- Use `loading.tsx` and `error.tsx` at every route segment
- Prefer Server Actions over API routes for mutations
- Image optimization via `next/image`

### Testing
- Unit: Vitest
- E2E: Playwright
- Coverage target: 80%+ on business logic
- Test naming: `describe('ComponentName', () => { it('should do X when Y') })`

### Git
- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`
- PR size: <500 LOC preferred, flag >1000 LOC
- Bisectable commits: each commit = one logical change

## Workflow — App Development SOP

This project follows a 10-phase lifecycle. Each phase is a skill: `/phase-1-ideation` through `/phase-10-feature-requests`.

**Before starting any phase:** Read the upstream `docs/phase-X/claude.md` files.
**After completing any phase:** Write the phase journal to `docs/phase-X/claude.md`.

### Phase Quick Reference

| Command | Phase | What It Does |
|---------|-------|-------------|
| `/reddit-fetch` | 1. Ideation | Scrape Reddit for pain points |
| `/superpower-brainstorming` | 1. Ideation | Generate solution concepts |
| `/plan-ceo-review` | 1, 4 | CEO-level plan review (EXPANSION/HOLD/REDUCTION) |
| `/discovery-process` | 1.2 | Full discovery cycle |
| `/tam-sam-som-calculator` | 1.2 | Market sizing |
| `/positioning-statement` | 1.2 | Positioning framework |
| `/pestel-analysis` | 1.2 | Environmental scan |
| `figma-cli` | 2 | Extract designs from Figma |
| `/ui-ux-pro-max` | 2 | Design validation (50+ styles, 97 palettes, 99 UX rules) |
| `/plan-eng-review` | 3, 4 | Engineering plan review |
| `/architecture-decision-records` | 3 | Document ADRs |
| `/user-story` | 4 | Write user stories (Cohn + Gherkin) |
| `/prioritization-advisor` | 4, 10 | Score and rank features |
| `/high-agency` | 5 | Sustained motivation + cross-session learning |
| `/superpower-writing-plans` | 5 | Decompose features into implementation plan |
| `/superpower-executing-plans` | 5 | Parallel agent execution |
| `/simplify` | 5 | Complexity reduction review |
| `/security-review` | 5 | Security audit |
| `/review` | 6 | Structured code review |
| `/qa` | 6 | QA testing via headless browser |
| `/launch-strategy` | 7 | 5-phase launch planning |
| `/seo-audit` | 7 | Technical SEO audit |
| `/ab-test-setup` | 8 | A/B test design |
| `/analytics-tracking` | 8 | Analytics implementation |
| `/ship` | 9 | Automated ship workflow (test -> review -> version -> PR) |
| `/retro` | 10 | Engineering retrospective |

## Engineering Preferences

These guide ALL plan reviews and code reviews:

1. **DRY** — flag repetition aggressively
2. **Well-tested** — too many tests > too few tests
3. **Engineered enough** — not fragile, not over-abstracted
4. **More edge cases** — thoughtfulness > speed
5. **Explicit > clever** — readable code wins
6. **Minimal diff** — fewest new abstractions and files touched
7. **Observability is scope** — logs, metrics, traces for new codepaths
8. **Security is scope** — threat model for new codepaths
9. **Diagrams are mandatory** — ASCII art for complex flows, in code comments
10. **Zero silent failures** — every failure mode must be visible

## Project Docs Structure

Every project maintains a `docs/` folder with accumulated phase decisions:

```
docs/
├── phase-1-ideation/claude.md
├── phase-1.2-product-strategy/claude.md
├── phase-2-frontend-design/claude.md
├── phase-3-architecture/claude.md + adr/
├── phase-4-feature-design/claude.md + user-stories/ + feature-specs/
├── phase-5-implementation/claude.md
├── phase-6-pr-review/claude.md
├── phase-7-marketing/claude.md
├── phase-8-testing/claude.md
├── phase-9-cicd/claude.md
└── phase-10-feature-request/claude.md
```

**Rule:** Always read upstream phase journals before starting work. Always write your phase journal when done.
