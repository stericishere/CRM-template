'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

interface ToastData {
  id: string
  conversationId: string
  clientName: string
  preview: string
  createdAt: number
}

interface NotificationToastProps {
  /** Called when user clicks a toast to navigate to conversation */
  onNavigate?: (conversationId: string) => void
}

const AUTO_DISMISS_MS = 5_000
const DEDUP_WINDOW_MS = 10_000
const PREVIEW_MAX_LENGTH = 100

/**
 * Notification toast container.
 *
 * - Shows client name + message preview (first 100 chars)
 * - Auto-dismisses after 5 seconds
 * - Deduplicates per conversation_id within 10-second window
 * - Clicking a toast navigates to the conversation
 *
 * Mount this component once at the root layout level.
 */
export function NotificationToast({ onNavigate }: NotificationToastProps) {
  const [toasts, setToasts] = useState<ToastData[]>([])
  const dedupMapRef = useRef<Map<string, number>>(new Map())

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const showToast = useCallback(
    (payload: {
      conversationId: string
      clientName?: string
      body?: string
      hasMedia?: boolean
    }) => {
      const now = Date.now()
      const lastShown = dedupMapRef.current.get(payload.conversationId)

      // Dedup: suppress toast if same conversation shown within window
      if (lastShown && now - lastShown < DEDUP_WINDOW_MS) {
        return
      }
      dedupMapRef.current.set(payload.conversationId, now)

      const preview = payload.hasMedia
        ? 'New media message'
        : payload.body
          ? payload.body.length > PREVIEW_MAX_LENGTH
            ? `${payload.body.slice(0, PREVIEW_MAX_LENGTH)}...`
            : payload.body
          : 'New message'

      const id = `${payload.conversationId}-${now}`
      const toast: ToastData = {
        id,
        conversationId: payload.conversationId,
        clientName: payload.clientName ?? 'Unknown',
        preview,
        createdAt: now,
      }

      setToasts((prev) => [...prev, toast])

      // Auto-dismiss
      setTimeout(() => {
        dismiss(id)
      }, AUTO_DISMISS_MS)
    },
    [dismiss]
  )

  // Clean up stale dedup entries periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      const map = dedupMapRef.current
      for (const [key, timestamp] of map.entries()) {
        if (now - timestamp > DEDUP_WINDOW_MS) {
          map.delete(key)
        }
      }
    }, DEDUP_WINDOW_MS)

    return () => clearInterval(interval)
  }, [])

  // Expose showToast via a custom event listener so other components
  // can trigger toasts without prop drilling
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        conversationId: string
        clientName?: string
        body?: string
        hasMedia?: boolean
      }
      showToast(detail)
    }

    window.addEventListener('notification-toast', handler)
    return () => window.removeEventListener('notification-toast', handler)
  }, [showToast])

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => {
            onNavigate?.(toast.conversationId)
            dismiss(toast.id)
          }}
          className="w-80 rounded-lg border border-gray-200 bg-white p-4 shadow-lg transition-opacity hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
        >
          <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {toast.clientName}
          </p>
          <p className="mt-1 line-clamp-2 text-sm text-gray-600 dark:text-gray-400">
            {toast.preview}
          </p>
        </button>
      ))}
    </div>
  )
}

/**
 * Dispatch a notification toast event from anywhere in the app.
 * The NotificationToast component listens for these events.
 */
export function dispatchNotificationToast(payload: {
  conversationId: string
  clientName?: string
  body?: string
  hasMedia?: boolean
}): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('notification-toast', { detail: payload })
  )
}
