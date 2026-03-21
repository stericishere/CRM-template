'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

interface ConversationUnread {
  conversation_id: string
  unread_count: number
  last_message_at: string
}

interface UseUnreadCountOptions {
  workspaceId: string
}

interface UseUnreadCountReturn {
  /** Total unread count across all conversations */
  totalUnread: number
  /** Per-conversation unread breakdown */
  conversations: ConversationUnread[]
  /** Increment count (called from Realtime on inbound message INSERT) */
  incrementForConversation: (conversationId: string) => void
  /** Reset count for a conversation (called after mark-as-read) */
  markConversationRead: (conversationId: string) => Promise<void>
  /** Re-fetch from server */
  refresh: () => Promise<void>
}

const TITLE_BASE = 'Inbox'

function updateDocumentTitle(count: number): void {
  if (typeof document === 'undefined') return
  document.title = count > 0 ? `(${count}) ${TITLE_BASE}` : TITLE_BASE
}

/**
 * Server-authoritative unread count hook.
 *
 * - Fetches from GET /api/notifications/unread-count on mount
 * - Supports optimistic increment from Realtime events
 * - Resets on conversation open via PATCH mark-as-read
 * - Updates browser tab title: "(N) Inbox" or "Inbox"
 */
export function useUnreadCount({
  workspaceId,
}: UseUnreadCountOptions): UseUnreadCountReturn {
  const [conversations, setConversations] = useState<ConversationUnread[]>([])
  const mountedRef = useRef(true)

  const totalUnread = conversations.reduce(
    (sum, c) => sum + c.unread_count,
    0
  )

  // Keep tab title in sync
  useEffect(() => {
    updateDocumentTitle(totalUnread)
    return () => {
      updateDocumentTitle(0)
    }
  }, [totalUnread])

  const fetchUnreadCounts = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/notifications/unread-count?workspace_id=${encodeURIComponent(workspaceId)}`
      )
      if (!res.ok) {
        console.error('[useUnreadCount] fetch failed', res.status)
        return
      }
      const data: { conversations: ConversationUnread[] } = await res.json()
      if (mountedRef.current) {
        setConversations(data.conversations)
      }
    } catch (err) {
      console.error('[useUnreadCount] fetch error', err)
    }
  }, [workspaceId])

  // Fetch on mount and when workspaceId changes
  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `/api/notifications/unread-count?workspace_id=${encodeURIComponent(workspaceId)}`
        )
        if (!res.ok || cancelled) return
        const data: { conversations: ConversationUnread[] } = await res.json()
        if (!cancelled && mountedRef.current) {
          setConversations(data.conversations)
        }
      } catch (err) {
        if (!cancelled) console.error('[useUnreadCount] fetch error', err)
      }
    })()
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [workspaceId])

  const incrementForConversation = useCallback(
    (conversationId: string) => {
      setConversations((prev) => {
        const existing = prev.find(
          (c) => c.conversation_id === conversationId
        )
        if (existing) {
          return prev.map((c) =>
            c.conversation_id === conversationId
              ? {
                  ...c,
                  unread_count: c.unread_count + 1,
                  last_message_at: new Date().toISOString(),
                }
              : c
          )
        }
        return [
          ...prev,
          {
            conversation_id: conversationId,
            unread_count: 1,
            last_message_at: new Date().toISOString(),
          },
        ]
      })
    },
    []
  )

  const markConversationRead = useCallback(
    async (conversationId: string) => {
      // Optimistic update
      setConversations((prev) =>
        prev.filter((c) => c.conversation_id !== conversationId)
      )

      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/read`,
          { method: 'PATCH' }
        )
        if (!res.ok) {
          console.error('[useUnreadCount] mark-read failed', res.status)
          // Re-fetch to restore accurate state
          void fetchUnreadCounts()
        }
      } catch (err) {
        console.error('[useUnreadCount] mark-read error', err)
        void fetchUnreadCounts()
      }
    },
    [fetchUnreadCounts]
  )

  return {
    totalUnread,
    conversations,
    incrementForConversation,
    markConversationRead,
    refresh: fetchUnreadCounts,
  }
}
