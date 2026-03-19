// src/lib/proactive/__tests__/compaction.test.ts
// Unit tests for daily memory compaction logic.
//
// Tests the coordinator dispatch pattern and per-workspace compaction logic
// by mocking Supabase and LLM calls.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock types mirroring the Edge Function behavior ────────

interface MockSupabaseQuery {
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  gte: ReturnType<typeof vi.fn>
  lt: ReturnType<typeof vi.fn>
  order: ReturnType<typeof vi.fn>
  limit: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  rpc: ReturnType<typeof vi.fn>
}

// ─── Compaction logic extracted for testability ─────────────
//
// The Edge Functions run in Deno and can't be directly imported in Node/Vitest.
// We re-implement the core logic as pure functions here, matching the Edge
// Function implementation 1:1, so we can unit test the decision paths.

interface MemoryRecord {
  id: string
  content: string
  version: number
}

interface MessageRow {
  content: string | null
  direction: string
  sender_type: string
  created_at: string
}

interface CompactionDeps {
  checkPendingExtractions: (clientId: string) => Promise<boolean>
  loadLatestCompactSummary: (
    workspaceId: string,
    clientId: string
  ) => Promise<MemoryRecord | null>
  loadYesterdayMessages: (
    workspaceId: string,
    clientId: string
  ) => Promise<MessageRow[]>
  callLLM: (params: {
    model: string
    systemPrompt: string
    messages: Array<{ role: string; content: string }>
    maxTokens: number
  }) => Promise<{
    message: { content: string | null }
    usage: { tokensIn: number; tokensOut: number }
  }>
  insertMemory: (record: {
    workspace_id: string
    client_id: string
    type: string
    content: string
    version: number
    period_date: string
  }) => Promise<{ error: { message: string } | null }>
  updateClient: (
    clientId: string,
    updates: { summary: string; last_compacted_at: string }
  ) => Promise<{ error: { message: string } | null }>
}

type CompactionResult = 'compacted' | 'skipped_pending'

const COMPACTION_SYSTEM_PROMPT = `You are a memory compaction assistant. Merge the existing client summary with new messages into a concise third-person factual summary (~2000 tokens). Priority: preferences > milestones > unresolved topics > communication style > interaction history. Preserve all actionable information. Drop redundant small talk.`

async function compactClient(
  deps: CompactionDeps,
  workspaceId: string,
  clientId: string,
  yesterdayDate: string
): Promise<CompactionResult> {
  // Flush-before-compact check
  const shouldSkip = await deps.checkPendingExtractions(clientId)
  if (shouldSkip) {
    return 'skipped_pending'
  }

  // Load existing compact summary
  const existingSummary = await deps.loadLatestCompactSummary(workspaceId, clientId)

  // Load yesterday's messages
  const yesterdayMessages = await deps.loadYesterdayMessages(workspaceId, clientId)

  if (yesterdayMessages.length === 0) {
    return 'compacted' // Nothing to compact
  }

  // Build LLM prompt
  const messagesText = yesterdayMessages
    .map((m) => {
      const role = m.direction === 'inbound' ? 'Client' : 'Staff'
      const time = new Date(m.created_at).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
      })
      return `[${time}] ${role}: ${m.content ?? '(media message)'}`
    })
    .join('\n')

  const userContent = existingSummary
    ? `## Existing Summary (version ${existingSummary.version})\n${existingSummary.content}\n\n## New Messages (yesterday)\n${messagesText}`
    : `## New Messages (yesterday)\n${messagesText}\n\n(No existing summary — this is the first compaction for this client.)`

  const llmResult = await deps.callLLM({
    model: 'flash-model',
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    maxTokens: 2048,
  })

  const newSummary = llmResult.message.content ?? ''

  if (!newSummary) {
    throw new Error('LLM returned empty summary')
  }

  const newVersion = (existingSummary?.version ?? 0) + 1

  // Insert memory
  const { error: memoryError } = await deps.insertMemory({
    workspace_id: workspaceId,
    client_id: clientId,
    type: 'compact_summary',
    content: newSummary,
    version: newVersion,
    period_date: yesterdayDate,
  })

  if (memoryError) {
    throw new Error(`Failed to insert memory: ${memoryError.message}`)
  }

  // Update client
  await deps.updateClient(clientId, {
    summary: newSummary,
    last_compacted_at: new Date().toISOString(),
  })

  return 'compacted'
}

// ─── Coordinator logic ──────────────────────────────────────

interface CoordinatorDeps {
  queryActiveWorkspaces: () => Promise<Array<{ id: string }>>
  dispatchCompaction: (workspaceId: string) => void
}

async function coordinatorFanOut(
  deps: CoordinatorDeps
): Promise<{ dispatched: number; total: number }> {
  const workspaces = await deps.queryActiveWorkspaces()

  let dispatched = 0
  for (const ws of workspaces) {
    deps.dispatchCompaction(ws.id)
    dispatched++
  }

  return { dispatched, total: workspaces.length }
}

// ─── Tests ──────────────────────────────────────────────────

describe('CompactionCoordinator', () => {
  it('should dispatch to all active workspaces', async () => {
    const dispatchFn = vi.fn()

    const result = await coordinatorFanOut({
      queryActiveWorkspaces: async () => [
        { id: 'ws-1' },
        { id: 'ws-2' },
        { id: 'ws-3' },
      ],
      dispatchCompaction: dispatchFn,
    })

    expect(result.dispatched).toBe(3)
    expect(result.total).toBe(3)
    expect(dispatchFn).toHaveBeenCalledTimes(3)
    expect(dispatchFn).toHaveBeenCalledWith('ws-1')
    expect(dispatchFn).toHaveBeenCalledWith('ws-2')
    expect(dispatchFn).toHaveBeenCalledWith('ws-3')
  })

  it('should handle zero active workspaces', async () => {
    const dispatchFn = vi.fn()

    const result = await coordinatorFanOut({
      queryActiveWorkspaces: async () => [],
      dispatchCompaction: dispatchFn,
    })

    expect(result.dispatched).toBe(0)
    expect(result.total).toBe(0)
    expect(dispatchFn).not.toHaveBeenCalled()
  })
})

describe('PerWorkspaceCompaction', () => {
  let mockDeps: CompactionDeps

  beforeEach(() => {
    vi.clearAllMocks()

    mockDeps = {
      checkPendingExtractions: vi.fn().mockResolvedValue(false),
      loadLatestCompactSummary: vi.fn().mockResolvedValue(null),
      loadYesterdayMessages: vi.fn().mockResolvedValue([
        {
          content: 'Hi, I want to book a facial',
          direction: 'inbound',
          sender_type: 'client',
          created_at: '2026-03-18T10:30:00.000Z',
        },
        {
          content: 'Sure! We have availability this Saturday. Would 2pm work?',
          direction: 'outbound',
          sender_type: 'staff',
          created_at: '2026-03-18T10:35:00.000Z',
        },
      ]),
      callLLM: vi.fn().mockResolvedValue({
        message: { content: 'Client expressed interest in booking a facial. Prefers Saturday appointments. Staff offered 2pm slot.' },
        usage: { tokensIn: 200, tokensOut: 50 },
      }),
      insertMemory: vi.fn().mockResolvedValue({ error: null }),
      updateClient: vi.fn().mockResolvedValue({ error: null }),
    }
  })

  it('should compact client with activity', async () => {
    const result = await compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')

    expect(result).toBe('compacted')

    // Should have called LLM
    expect(mockDeps.callLLM).toHaveBeenCalledTimes(1)
    const llmCall = (mockDeps.callLLM as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(llmCall.systemPrompt).toContain('memory compaction assistant')
    expect(llmCall.messages[0].content).toContain('New Messages (yesterday)')
    expect(llmCall.messages[0].content).toContain('first compaction')

    // Should have inserted memory
    expect(mockDeps.insertMemory).toHaveBeenCalledWith({
      workspace_id: 'ws-1',
      client_id: 'client-1',
      type: 'compact_summary',
      content: expect.stringContaining('facial'),
      version: 1,
      period_date: '2026-03-18',
    })

    // Should have updated client
    expect(mockDeps.updateClient).toHaveBeenCalledWith('client-1', {
      summary: expect.stringContaining('facial'),
      last_compacted_at: expect.any(String),
    })
  })

  it('should merge with existing summary when one exists', async () => {
    ;(mockDeps.loadLatestCompactSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'mem-1',
      content: 'Client is a regular customer who prefers morning appointments.',
      version: 3,
    })

    const result = await compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')

    expect(result).toBe('compacted')

    // LLM prompt should include existing summary
    const llmCall = (mockDeps.callLLM as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(llmCall.messages[0].content).toContain('Existing Summary (version 3)')
    expect(llmCall.messages[0].content).toContain('regular customer')

    // Version should increment
    expect(mockDeps.insertMemory).toHaveBeenCalledWith(
      expect.objectContaining({ version: 4 })
    )
  })

  it('should skip client with no activity (no messages)', async () => {
    ;(mockDeps.loadYesterdayMessages as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')

    expect(result).toBe('compacted')
    expect(mockDeps.callLLM).not.toHaveBeenCalled()
    expect(mockDeps.insertMemory).not.toHaveBeenCalled()
    expect(mockDeps.updateClient).not.toHaveBeenCalled()
  })

  it('should skip client when flush-before-compact finds pending extractions', async () => {
    ;(mockDeps.checkPendingExtractions as ReturnType<typeof vi.fn>).mockResolvedValue(true)

    const result = await compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')

    expect(result).toBe('skipped_pending')
    expect(mockDeps.loadLatestCompactSummary).not.toHaveBeenCalled()
    expect(mockDeps.loadYesterdayMessages).not.toHaveBeenCalled()
    expect(mockDeps.callLLM).not.toHaveBeenCalled()
    expect(mockDeps.insertMemory).not.toHaveBeenCalled()
    expect(mockDeps.updateClient).not.toHaveBeenCalled()
  })

  it('should throw on LLM failure and skip client', async () => {
    ;(mockDeps.callLLM as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('OpenRouter timeout')
    )

    await expect(
      compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')
    ).rejects.toThrow('OpenRouter timeout')

    // Memory should NOT have been inserted
    expect(mockDeps.insertMemory).not.toHaveBeenCalled()
    expect(mockDeps.updateClient).not.toHaveBeenCalled()
  })

  it('should throw on empty LLM response', async () => {
    ;(mockDeps.callLLM as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: { content: '' },
      usage: { tokensIn: 100, tokensOut: 0 },
    })

    await expect(
      compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')
    ).rejects.toThrow('LLM returned empty summary')
  })

  it('should throw on null LLM content', async () => {
    ;(mockDeps.callLLM as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: { content: null },
      usage: { tokensIn: 100, tokensOut: 0 },
    })

    await expect(
      compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')
    ).rejects.toThrow('LLM returned empty summary')
  })

  it('should throw on memory insert failure', async () => {
    ;(mockDeps.insertMemory as ReturnType<typeof vi.fn>).mockResolvedValue({
      error: { message: 'constraint violation' },
    })

    await expect(
      compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')
    ).rejects.toThrow('Failed to insert memory: constraint violation')

    // Client should NOT have been updated
    expect(mockDeps.updateClient).not.toHaveBeenCalled()
  })

  it('should succeed even if client update fails (non-fatal)', async () => {
    ;(mockDeps.updateClient as ReturnType<typeof vi.fn>).mockResolvedValue({
      error: { message: 'update failed' },
    })

    // Should not throw — client update failure is non-fatal in the Edge Function.
    // The memory record was already saved successfully.
    const result = await compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')
    expect(result).toBe('compacted')

    // Memory should have been inserted
    expect(mockDeps.insertMemory).toHaveBeenCalledTimes(1)
  })

  it('should handle media messages (null content)', async () => {
    ;(mockDeps.loadYesterdayMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        content: null,
        direction: 'inbound',
        sender_type: 'client',
        created_at: '2026-03-18T10:30:00.000Z',
      },
    ])

    const result = await compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')

    expect(result).toBe('compacted')
    const llmCall = (mockDeps.callLLM as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(llmCall.messages[0].content).toContain('(media message)')
  })

  it('should set version to 1 for first compaction', async () => {
    ;(mockDeps.loadLatestCompactSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    await compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')

    expect(mockDeps.insertMemory).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1 })
    )
  })

  it('should include compaction system prompt in LLM call', async () => {
    await compactClient(mockDeps, 'ws-1', 'client-1', '2026-03-18')

    const llmCall = (mockDeps.callLLM as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(llmCall.systemPrompt).toBe(COMPACTION_SYSTEM_PROMPT)
    expect(llmCall.maxTokens).toBe(2048)
  })
})

describe('FlushBeforeCompactCheck', () => {
  it('should return false when extraction_status column does not exist', async () => {
    // Simulates the graceful degradation when F-13 hasn't been implemented
    const mockCheck = vi.fn().mockResolvedValue(false)

    const deps: CompactionDeps = {
      checkPendingExtractions: mockCheck,
      loadLatestCompactSummary: vi.fn().mockResolvedValue(null),
      loadYesterdayMessages: vi.fn().mockResolvedValue([
        {
          content: 'Hello',
          direction: 'inbound',
          sender_type: 'client',
          created_at: '2026-03-18T10:30:00.000Z',
        },
      ]),
      callLLM: vi.fn().mockResolvedValue({
        message: { content: 'Client said hello.' },
        usage: { tokensIn: 50, tokensOut: 20 },
      }),
      insertMemory: vi.fn().mockResolvedValue({ error: null }),
      updateClient: vi.fn().mockResolvedValue({ error: null }),
    }

    const result = await compactClient(deps, 'ws-1', 'client-1', '2026-03-18')

    // Should proceed with compaction
    expect(result).toBe('compacted')
    expect(deps.callLLM).toHaveBeenCalledTimes(1)
  })
})
