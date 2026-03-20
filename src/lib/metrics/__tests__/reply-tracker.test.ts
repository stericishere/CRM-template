import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase client mock
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>

interface MockQueryBuilder {
  select: MockFn
  eq: MockFn
  is: MockFn
  in: MockFn
  gte: MockFn
  order: MockFn
  limit: MockFn
  update: MockFn
}

function createMockSelectBuilder(resolvedValue: { data: unknown; error: unknown }): MockQueryBuilder {
  const builder: MockQueryBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    gte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    update: vi.fn(),
  }

  // Each method returns the builder for chaining, except limit (terminal for SELECT)
  builder.select.mockReturnValue(builder)
  builder.eq.mockReturnValue(builder)
  builder.is.mockReturnValue(builder)
  builder.in.mockReturnValue(builder)
  builder.gte.mockReturnValue(builder)
  builder.order.mockReturnValue(builder)
  builder.limit.mockResolvedValue(resolvedValue)
  builder.update.mockReturnValue(builder)

  return builder
}

function createMockUpdateBuilder(resolvedValue: { data: unknown; error: unknown }): MockQueryBuilder {
  const builder: MockQueryBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    gte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    update: vi.fn(),
  }

  // For UPDATE chains: update -> eq resolves with the value
  builder.update.mockReturnValue(builder)
  builder.eq.mockResolvedValue(resolvedValue)

  return builder
}

// ---------------------------------------------------------------------------
// Replicate the reply-tracker logic portably (same contract as the Deno module
// at supabase/functions/_shared/reply-tracker.ts).
//
// Since the Deno module uses Deno-style imports (https://esm.sh/...) it cannot
// be imported directly in vitest. We replicate the logic here to validate the
// contract, following the same pattern as media-processor.test.ts.
// ---------------------------------------------------------------------------

interface SignalRow {
  id: string
  created_at: string
  conversation_id: string | null
}

interface SupabaseClientLike {
  from: (table: string) => MockQueryBuilder
}

async function trackReplySignal(
  supabase: SupabaseClientLike,
  conversationId: string,
  workspaceId: string
): Promise<void> {
  try {
    const selectResult = await supabase
      .from('draft_edit_signals')
      .select('id, created_at, conversation_id')
      .eq('workspace_id', workspaceId)
      .is('client_replied', null)
      .in('staff_action', ['sent_as_is', 'edited_and_sent'])
      .gte('created_at', new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(10)

    const { data: signals, error: selectError } = selectResult as {
      data: SignalRow[] | null
      error: { message: string } | null
    }

    if (selectError) {
      console.error('[reply-tracker] Signal lookup failed:', selectError.message)
      return
    }

    if (!signals || signals.length === 0) {
      return
    }

    const match =
      signals.find((s) => s.conversation_id === conversationId) ??
      signals.find((s) => s.conversation_id === null)

    if (!match) {
      return
    }

    const signalCreatedAt = new Date(match.created_at).getTime()
    const latencyMinutes = Math.round((Date.now() - signalCreatedAt) / (1000 * 60))

    const updatePayload: Record<string, unknown> = {
      client_replied: true,
      client_reply_latency_minutes: latencyMinutes,
    }
    if (match.conversation_id === null) {
      updatePayload.conversation_id = conversationId
    }

    const updateResult = await supabase
      .from('draft_edit_signals')
      .update(updatePayload)
      .eq('id', match.id)

    const { error: updateError } = updateResult as {
      error: { message: string } | null
    }

    if (updateError) {
      console.error('[reply-tracker] Signal update failed:', updateError.message)
      return
    }
  } catch (err) {
    console.error('[reply-tracker] Unexpected error:', err)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReplyTracker', () => {
  const WORKSPACE_ID = 'ws-001'
  const CONVERSATION_ID = 'conv-001'
  const SIGNAL_ID = 'sig-001'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-20T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should find and update a pending signal for the conversation', async () => {
    const signalCreatedAt = '2026-03-20T10:00:00Z' // 2 hours ago -> 120 minutes latency
    const selectBuilder = createMockSelectBuilder({
      data: [
        { id: SIGNAL_ID, created_at: signalCreatedAt, conversation_id: CONVERSATION_ID },
      ],
      error: null,
    })
    const updateBuilder = createMockUpdateBuilder({ data: null, error: null })

    let callCount = 0
    const mockSupabase = {
      from: vi.fn((table: string) => {
        expect(table).toBe('draft_edit_signals')
        callCount++
        // First call is SELECT, second is UPDATE
        return callCount === 1 ? selectBuilder : updateBuilder
      }),
    }

    await trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)

    // Verify SELECT was constructed correctly
    expect(selectBuilder.select).toHaveBeenCalledWith('id, created_at, conversation_id')
    expect(selectBuilder.eq).toHaveBeenCalledWith('workspace_id', WORKSPACE_ID)
    expect(selectBuilder.is).toHaveBeenCalledWith('client_replied', null)
    expect(selectBuilder.in).toHaveBeenCalledWith('staff_action', ['sent_as_is', 'edited_and_sent'])
    expect(selectBuilder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(selectBuilder.limit).toHaveBeenCalledWith(10)

    // Verify UPDATE was called with correct latency
    expect(updateBuilder.update).toHaveBeenCalledWith({
      client_replied: true,
      client_reply_latency_minutes: 120, // 2 hours = 120 min
    })
    expect(updateBuilder.eq).toHaveBeenCalledWith('id', SIGNAL_ID)
  })

  it('should enforce the 72h window via gte filter', async () => {
    const selectBuilder = createMockSelectBuilder({ data: [], error: null })

    const mockSupabase = {
      from: vi.fn(() => selectBuilder),
    }

    await trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)

    // The gte call should use a timestamp 72 hours before "now" (2026-03-20T12:00:00Z)
    // 72h before = 2026-03-17T12:00:00.000Z
    const gteCall = selectBuilder.gte.mock.calls[0] as [string, string] | undefined
    expect(gteCall?.[0]).toBe('created_at')
    const cutoffDate = new Date(gteCall?.[1] ?? '')
    const expectedCutoff = new Date('2026-03-17T12:00:00.000Z')
    expect(cutoffDate.getTime()).toBe(expectedCutoff.getTime())
  })

  it('should calculate latency correctly in minutes', async () => {
    // Signal created 45 minutes ago
    const signalCreatedAt = '2026-03-20T11:15:00Z' // 45 min before noon
    const selectBuilder = createMockSelectBuilder({
      data: [
        { id: SIGNAL_ID, created_at: signalCreatedAt, conversation_id: CONVERSATION_ID },
      ],
      error: null,
    })
    const updateBuilder = createMockUpdateBuilder({ data: null, error: null })

    let callCount = 0
    const mockSupabase = {
      from: vi.fn(() => {
        callCount++
        return callCount === 1 ? selectBuilder : updateBuilder
      }),
    }

    await trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)

    expect(updateBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        client_reply_latency_minutes: 45,
      })
    )
  })

  it('should be a no-op when no pending signal exists', async () => {
    const selectBuilder = createMockSelectBuilder({ data: [], error: null })

    const mockSupabase = {
      from: vi.fn(() => selectBuilder),
    }

    await trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)

    // from() should only be called once (for the SELECT), never for UPDATE
    expect(mockSupabase.from).toHaveBeenCalledTimes(1)
  })

  it('should be a no-op when SELECT returns null data', async () => {
    const selectBuilder = createMockSelectBuilder({ data: null, error: null })

    const mockSupabase = {
      from: vi.fn(() => selectBuilder),
    }

    await trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)

    expect(mockSupabase.from).toHaveBeenCalledTimes(1)
  })

  it('should not match signals from a different conversation', async () => {
    // Only signal belongs to a different conversation, and has non-null conversation_id
    const selectBuilder = createMockSelectBuilder({
      data: [
        { id: 'sig-other', created_at: '2026-03-20T10:00:00Z', conversation_id: 'conv-OTHER' },
      ],
      error: null,
    })

    const mockSupabase = {
      from: vi.fn(() => selectBuilder),
    }

    await trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)

    // No UPDATE should happen: the only signal belongs to conv-OTHER
    expect(mockSupabase.from).toHaveBeenCalledTimes(1)
  })

  it('should fall back to signal with null conversation_id within same workspace', async () => {
    const signalCreatedAt = '2026-03-20T11:00:00Z' // 60 min ago
    const selectBuilder = createMockSelectBuilder({
      data: [
        { id: 'sig-null-conv', created_at: signalCreatedAt, conversation_id: null },
      ],
      error: null,
    })
    const updateBuilder = createMockUpdateBuilder({ data: null, error: null })

    let callCount = 0
    const mockSupabase = {
      from: vi.fn(() => {
        callCount++
        return callCount === 1 ? selectBuilder : updateBuilder
      }),
    }

    await trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)

    // Should update and backfill conversation_id
    expect(updateBuilder.update).toHaveBeenCalledWith({
      client_replied: true,
      client_reply_latency_minutes: 60,
      conversation_id: CONVERSATION_ID,
    })
    expect(updateBuilder.eq).toHaveBeenCalledWith('id', 'sig-null-conv')
  })

  it('should prefer exact conversation_id match over null fallback', async () => {
    const selectBuilder = createMockSelectBuilder({
      data: [
        { id: 'sig-null', created_at: '2026-03-20T11:00:00Z', conversation_id: null },
        { id: 'sig-exact', created_at: '2026-03-20T10:30:00Z', conversation_id: CONVERSATION_ID },
      ],
      error: null,
    })
    const updateBuilder = createMockUpdateBuilder({ data: null, error: null })

    let callCount = 0
    const mockSupabase = {
      from: vi.fn(() => {
        callCount++
        return callCount === 1 ? selectBuilder : updateBuilder
      }),
    }

    await trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)

    // Should pick the exact match, not the null one
    expect(updateBuilder.eq).toHaveBeenCalledWith('id', 'sig-exact')
  })

  it('should not throw when SELECT errors (non-blocking)', async () => {
    const selectBuilder = createMockSelectBuilder({
      data: null,
      error: { message: 'DB connection failed' },
    })

    const mockSupabase = {
      from: vi.fn(() => selectBuilder),
    }

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Should not throw
    await expect(trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)).resolves.toBeUndefined()

    expect(consoleSpy).toHaveBeenCalledWith(
      '[reply-tracker] Signal lookup failed:',
      'DB connection failed'
    )
    consoleSpy.mockRestore()
  })

  it('should not throw when UPDATE errors (non-blocking)', async () => {
    const selectBuilder = createMockSelectBuilder({
      data: [
        { id: SIGNAL_ID, created_at: '2026-03-20T10:00:00Z', conversation_id: CONVERSATION_ID },
      ],
      error: null,
    })
    const updateBuilder = createMockUpdateBuilder({
      data: null,
      error: { message: 'RLS violation' },
    })

    let callCount = 0
    const mockSupabase = {
      from: vi.fn(() => {
        callCount++
        return callCount === 1 ? selectBuilder : updateBuilder
      }),
    }

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)).resolves.toBeUndefined()

    expect(consoleSpy).toHaveBeenCalledWith(
      '[reply-tracker] Signal update failed:',
      'RLS violation'
    )
    consoleSpy.mockRestore()
  })

  it('should not throw when supabase.from itself throws (non-blocking)', async () => {
    const mockSupabase = {
      from: vi.fn(() => {
        throw new Error('Client destroyed')
      }),
    }

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(trackReplySignal(mockSupabase, CONVERSATION_ID, WORKSPACE_ID)).resolves.toBeUndefined()

    expect(consoleSpy).toHaveBeenCalledWith(
      '[reply-tracker] Unexpected error:',
      expect.any(Error)
    )
    consoleSpy.mockRestore()
  })
})
