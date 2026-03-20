import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { createClient } from '@/lib/supabase/server'
import {
  orchestrateSchema,
  type OrchestrateInput,
  type OrchestrateStep,
  type StepResult,
  type OrchestrateResponse,
} from '@/lib/onboarding/orchestrate-schema'

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/:workspaceId/orchestrate
//
// Streamlined onboarding pipeline that runs all steps in sequence:
//
//   ┌─────────┐   ┌──────────┐   ┌─────────┐   ┌──────────┐   ┌──────────┐
//   │ identity │──>│ IG scrape│──>│ KB+embed │──>│ SOPs gen │──>│ tone ext │
//   └─────────┘   └──────────┘   └─────────┘   └──────────┘   └──────────┘
//                                                                    │
//                                    ┌───────────────┐   ┌──────────┐│
//                                    │ Google Calendar│<──│ activate ││
//                                    └───────────────┘   └──────────┘▼
//
// Best-effort: each step runs sequentially. If a step fails, subsequent
// steps that depend on its output are skipped, but independent steps
// still execute. The response reports exactly which steps succeeded,
// failed, or were skipped.
//
// Body:
// {
//   business_name: string,
//   vertical: string,
//   timezone: string,
//   instagram_handle?: string,
//   description?: string,
//   google_auth_code?: string
// }
// ──────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ??
  `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/google-calendar/callback`

const LOG = '[POST /orchestrate]'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const pipelineStart = Date.now()

  try {
    const { workspaceId } = await params

    // ── Parse & validate ──────────────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = orchestrateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const input = parsed.data

    // Verify the authenticated user belongs to this workspace
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: staffRow } = await authClient
      .from('staff')
      .select('id')
      .eq('id', user.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!staffRow) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service client
    const supabase = getServiceClient() as any

    // Verify workspace exists
    const { data: workspace, error: wsError } = await supabase
      .from('workspaces')
      .select('id, whatsapp_connection_status')
      .eq('id', workspaceId)
      .single()

    if (wsError || !workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }

    // ── Pipeline state ────────────────────────────────────────────────────
    const results: StepResult[] = []
    let knowledgeBaseContent: string | null = null
    let hasInstagramData = false
    let verticalConfig: unknown = null
    let toneProfile: unknown = null
    let capabilities: Record<string, boolean> | null = null

    // ── Step 1: Save identity ─────────────────────────────────────────────
    results.push(
      await runStep('identity', async () => {
        const { error } = await supabase
          .from('workspaces')
          .update({
            business_name: input.business_name,
            vertical_type: input.vertical,
            timezone: input.timezone,
            instagram_handle: input.instagram_handle ?? null,
          })
          .eq('id', workspaceId)

        if (error) throw new Error(`DB update failed: ${error.message}`)
        return { saved: true }
      })
    )

    // ── Step 2: Scrape Instagram (non-blocking — continues on failure) ────
    if (input.instagram_handle) {
      results.push(
        await runStep('instagram_scrape', async () => {
          const efResponse = await fetch(
            `${SUPABASE_URL}/functions/v1/onboarding-scrape`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              },
              body: JSON.stringify({
                workspace_id: workspaceId,
                handle: input.instagram_handle,
              }),
              signal: AbortSignal.timeout(30_000),
            }
          )

          if (!efResponse.ok) {
            const errText = await efResponse.text().catch(() => 'Unknown error')
            throw new Error(`EF returned ${efResponse.status}: ${errText}`)
          }

          const result = await efResponse.json()

          // The scrape EF returns { profile, knowledge_base } — the EF
          // already saves instagram_scrape_data + knowledge_base to workspace
          if (result.knowledge_base?.structured_kb) {
            knowledgeBaseContent = result.knowledge_base.structured_kb
          }
          hasInstagramData = !!result.profile

          return {
            has_profile: !!result.profile,
            has_knowledge_base: !!result.knowledge_base,
          }
        })
      )
    } else {
      results.push(skipped('instagram_scrape'))
    }

    // ── Step 3: Knowledge base (embed existing KB or description) ─────────
    //
    // If the scrape generated a KB, it's already saved — we just need to
    // embed it. If no scrape but a description was provided, use that.
    // If neither exists, skip.

    const kbSource = knowledgeBaseContent ? 'instagram' : input.description ? 'onboarding' : null
    const kbContent = knowledgeBaseContent ?? input.description ?? null

    if (kbContent && kbContent.length >= 10) {
      // Save KB text to workspace if it came from description (scrape EF already saved its own)
      if (!knowledgeBaseContent && input.description) {
        results.push(
          await runStep('knowledge_base', async () => {
            const { error } = await supabase
              .from('workspaces')
              .update({ knowledge_base: input.description })
              .eq('id', workspaceId)

            if (error) throw new Error(`KB save failed: ${error.message}`)
            return { source: 'description' }
          })
        )
      } else {
        // KB was already saved by the scrape EF — mark as completed
        results.push({
          step: 'knowledge_base',
          success: true,
          duration_ms: 0,
          data: { source: 'instagram_scrape' },
        })
      }

      // Embed the knowledge base content
      results.push(
        await runStep('embed_knowledge', async () => {
          const efResponse = await fetch(
            `${SUPABASE_URL}/functions/v1/embed-knowledge`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              },
              body: JSON.stringify({
                workspace_id: workspaceId,
                content: kbContent,
                source: kbSource,
              }),
              signal: AbortSignal.timeout(60_000),
            }
          )

          if (!efResponse.ok) {
            const errText = await efResponse.text().catch(() => 'Unknown error')
            throw new Error(`Embed EF returned ${efResponse.status}: ${errText}`)
          }

          const embedResult = await efResponse.json()
          return { chunks: embedResult.chunks }
        })
      )
    } else {
      results.push(skipped('knowledge_base'))
      results.push(skipped('embed_knowledge'))
    }

    // ── Step 4: Generate SOPs via LLM ─────────────────────────────────────
    results.push(
      await runStep('generate_sops', async () => {
        const efResponse = await fetch(
          `${SUPABASE_URL}/functions/v1/onboarding-sops`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({
              workspace_id: workspaceId,
              mode: 'generate',
              vertical: input.vertical,
              business_name: input.business_name,
              description: input.description,
              knowledge_base: kbContent,
            }),
            signal: AbortSignal.timeout(60_000),
          }
        )

        if (!efResponse.ok) {
          const errText = await efResponse.text().catch(() => 'Unknown error')
          throw new Error(`SOPs EF returned ${efResponse.status}: ${errText}`)
        }

        const result = await efResponse.json()
        verticalConfig = result.vertical_config ?? null
        return { has_config: !!result.vertical_config }
      })
    )

    // ── Step 5: Extract tone profile via LLM ──────────────────────────────
    //
    // Prefer Instagram data as source if available, fall back to description.
    const toneSource = hasInstagramData ? 'instagram' : input.description ? 'description' : null

    if (toneSource) {
      results.push(
        await runStep('extract_tone', async () => {
          const efResponse = await fetch(
            `${SUPABASE_URL}/functions/v1/onboarding-tone`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              },
              body: JSON.stringify({
                workspace_id: workspaceId,
                mode: 'extract',
                source: toneSource,
                content: toneSource === 'description' ? input.description : undefined,
              }),
              signal: AbortSignal.timeout(60_000),
            }
          )

          if (!efResponse.ok) {
            const errText = await efResponse.text().catch(() => 'Unknown error')
            throw new Error(`Tone EF returned ${efResponse.status}: ${errText}`)
          }

          const result = await efResponse.json()
          toneProfile = result.tone_profile ?? null
          return { has_profile: !!result.tone_profile }
        })
      )
    } else {
      results.push(skipped('extract_tone'))
    }

    // ── Step 6: Google Calendar (if auth code provided) ───────────────────
    if (input.google_auth_code) {
      results.push(
        await runStep('google_calendar', async () => {
          const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code: input.google_auth_code!,
              client_id: GOOGLE_CLIENT_ID,
              client_secret: GOOGLE_CLIENT_SECRET,
              redirect_uri: GOOGLE_REDIRECT_URI,
              grant_type: 'authorization_code',
            }),
            signal: AbortSignal.timeout(15_000),
          })

          if (!tokenResponse.ok) {
            const errText = await tokenResponse.text().catch(() => 'Unknown error')
            throw new Error(`Google token exchange failed (${tokenResponse.status}): ${errText}`)
          }

          const tokens = await tokenResponse.json() as {
            access_token: string
            refresh_token?: string
            expires_in: number
          }

          const calendarConfig = {
            provider: 'google',
            calendarId: 'primary',
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            tokenExpiresAt: new Date(
              Date.now() + tokens.expires_in * 1000
            ).toISOString(),
            status: 'connected',
          }

          const { error } = await supabase
            .from('workspaces')
            .update({ calendar_config: calendarConfig })
            .eq('id', workspaceId)

          if (error) throw new Error(`Calendar config save failed: ${error.message}`)
          return { provider: 'google', connected: true }
        })
      )
    } else {
      results.push(skipped('google_calendar'))
    }

    // ── Step 7: Activate workspace ────────────────────────────────────────
    //
    // Only attempt activation if we haven't had critical failures.
    // The onboarding-activate EF checks its own prerequisites, so we
    // delegate validation to it and handle its 400 gracefully.

    results.push(
      await runStep('activate', async () => {
        const efResponse = await fetch(
          `${SUPABASE_URL}/functions/v1/onboarding-activate`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ workspace_id: workspaceId }),
            signal: AbortSignal.timeout(30_000),
          }
        )

        const result = await efResponse.json()

        if (!efResponse.ok) {
          // 400 means prerequisites not met — surface the missing steps
          const detail = result.missing_steps
            ? `Missing: ${(result.missing_steps as string[]).join(', ')}`
            : (result.error ?? 'Unknown activation error')
          throw new Error(detail)
        }

        capabilities = result.capabilities ?? null
        return { activated: true, capabilities: result.capabilities }
      })
    )

    // ── Build response ────────────────────────────────────────────────────
    const response = buildResponse(workspaceId, results, pipelineStart, {
      verticalConfig,
      toneProfile,
      capabilities,
    })

    const httpStatus = response.status === 'complete' ? 200 : 207
    console.log(
      `${LOG} workspace=${workspaceId} status=${response.status} ` +
        `completed=${response.steps_completed.length} ` +
        `failed=${response.steps_failed.length} ` +
        `skipped=${response.steps_skipped.length} ` +
        `duration=${response.total_duration_ms}ms`
    )

    return NextResponse.json(response, { status: httpStatus })
  } catch (err) {
    console.error(LOG, err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Execute a single pipeline step with timing and error capture.
 * Failures are caught and returned as a failed StepResult — never thrown.
 */
async function runStep(
  step: OrchestrateStep,
  fn: () => Promise<Record<string, unknown>>
): Promise<StepResult> {
  const start = Date.now()
  try {
    const data = await fn()
    return {
      step,
      success: true,
      duration_ms: Date.now() - start,
      data,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${LOG} Step "${step}" failed: ${message}`)
    return {
      step,
      success: false,
      error: message,
      duration_ms: Date.now() - start,
    }
  }
}

/** Mark a step as skipped (not applicable given the provided input). */
function skipped(step: OrchestrateStep): StepResult {
  return {
    step,
    success: true,
    duration_ms: 0,
    data: { skipped: true },
  }
}

/** Aggregate individual step results into the final response shape. */
function buildResponse(
  workspaceId: string,
  results: StepResult[],
  pipelineStart: number,
  extras: {
    verticalConfig: unknown
    toneProfile: unknown
    capabilities: Record<string, boolean> | null
  }
): OrchestrateResponse {
  const completed: OrchestrateStep[] = []
  const failed: Array<{ step: OrchestrateStep; error: string }> = []
  const skippedSteps: OrchestrateStep[] = []

  for (const r of results) {
    if (r.data?.skipped) {
      skippedSteps.push(r.step)
    } else if (r.success) {
      completed.push(r.step)
    } else {
      failed.push({ step: r.step, error: r.error ?? 'Unknown error' })
    }
  }

  return {
    status: failed.length === 0 ? 'complete' : 'partial',
    workspace_id: workspaceId,
    steps_completed: completed,
    steps_failed: failed,
    steps_skipped: skippedSteps,
    total_duration_ms: Date.now() - pipelineStart,
    vertical_config: extras.verticalConfig,
    tone_profile: extras.toneProfile,
    capabilities: extras.capabilities,
  }
}
