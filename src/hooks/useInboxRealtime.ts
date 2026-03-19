'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'

interface UseInboxRealtimeOptions {
  workspaceId: string
  onNewMessage?: (payload: Record<string, unknown>) => void
  onDraftReady?: (payload: Record<string, unknown>) => void
}

const DISCONNECT_TIMEOUT_MS = 10_000
const POLLING_INTERVAL_MS = 5_000

/**
 * Subscribe to Supabase Realtime for new messages and drafts,
 * scoped to a single workspace. Falls back to polling on disconnect.
 *
 * ┌──────────┐  INSERT  ┌────────────┐
 * │ messages │─────────▶│ onNewMsg   │  (inbound only)
 * └──────────┘          └────────────┘
 * ┌──────────┐  INSERT  ┌────────────┐
 * │ drafts   │─────────▶│ onDraftRdy │
 * └──────────┘          └────────────┘
 *       │ disconnect > 10s
 *       ▼
 * ┌─────────────────┐
 * │ polling fallback │  (messages + drafts, deduped by ID)
 * └─────────────────┘
 */
export function useInboxRealtime({
  workspaceId,
  onNewMessage,
  onDraftReady,
}: UseInboxRealtimeOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const channelRef = useRef<RealtimeChannel | null>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Stable callback refs to avoid re-subscribing on callback identity change
  const onNewMessageRef = useRef(onNewMessage)
  onNewMessageRef.current = onNewMessage
  const onDraftReadyRef = useRef(onDraftReady)
  onDraftReadyRef.current = onDraftReady

  // Track last-polled IDs to prevent replaying the same record
  const lastPolledMsgIdRef = useRef<string | null>(null)
  const lastPolledDraftIdRef = useRef<string | null>(null)

  const clearPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [])

  const clearDisconnectTimer = useCallback(() => {
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current)
      disconnectTimerRef.current = null
    }
  }, [])

  const startPollingFallback = useCallback(() => {
    if (pollingRef.current) return // already polling

    const supabase = createClient()

    pollingRef.current = setInterval(() => {
      // Poll for new inbound messages
      supabase
        .from('messages')
        .select('id, conversation_id, content, media_type, sender_type, created_at, direction')
        .eq('workspace_id', workspaceId)
        .eq('direction', 'inbound')
        .eq('is_read', false)
        .order('created_at', { ascending: false })
        .limit(1)
        .then(({ data }) => {
          if (data && data.length > 0) {
            const msg = data[0] as Record<string, unknown>
            if (msg.id !== lastPolledMsgIdRef.current) {
              lastPolledMsgIdRef.current = msg.id as string
              onNewMessageRef.current?.(msg)
            }
          }
        })

      // Poll for new drafts
      supabase
        .from('drafts')
        .select('id, conversation_id, content, intent_classified, created_at')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(1)
        .then(({ data }) => {
          if (data && data.length > 0) {
            const draft = data[0] as Record<string, unknown>
            if (draft.id !== lastPolledDraftIdRef.current) {
              lastPolledDraftIdRef.current = draft.id as string
              onDraftReadyRef.current?.(draft)
            }
          }
        })
    }, POLLING_INTERVAL_MS)
  }, [workspaceId])

  useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel(`inbox:${workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          // Filter out outbound messages — only notify for inbound
          const record = payload.new as Record<string, unknown>
          if (record.direction === 'outbound') return
          onNewMessageRef.current?.(record)
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'drafts',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          onDraftReadyRef.current?.(payload.new as Record<string, unknown>)
        }
      )
      .subscribe((subscriptionStatus) => {
        if (subscriptionStatus === 'SUBSCRIBED') {
          setStatus('connected')
          clearDisconnectTimer()
          clearPolling()
        } else if (subscriptionStatus === 'CLOSED' || subscriptionStatus === 'CHANNEL_ERROR') {
          setStatus('disconnected')

          // Start fallback polling after timeout
          clearDisconnectTimer()
          disconnectTimerRef.current = setTimeout(() => {
            startPollingFallback()
          }, DISCONNECT_TIMEOUT_MS)
        } else {
          setStatus('connecting')
        }
      })

    channelRef.current = channel

    return () => {
      clearDisconnectTimer()
      clearPolling()
      supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [workspaceId, clearPolling, clearDisconnectTimer, startPollingFallback])

  return { status }
}
