'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Notification payload shape matching staff_notifications table.
 */
export interface StaffNotification {
  notification_id: string
  workspace_id: string
  type: string
  title: string
  body: string | null
  metadata: Record<string, unknown> | null
  read_at: string | null
  created_at: string
}

/**
 * Subscribe to staff_notifications via Supabase Realtime.
 * Stub — full implementation when notification UI is built.
 *
 * ┌─────────────────────┐  INSERT  ┌────────────────┐
 * │ staff_notifications │─────────▶│ onNotification │
 * └─────────────────────┘          └────────────────┘
 */
export function useNotificationRealtime(
  workspaceId: string,
  onNotification: (notification: StaffNotification) => void
) {
  // Stable callback ref to avoid re-subscribing on callback identity change
  const onNotificationRef = useRef(onNotification)
  onNotificationRef.current = onNotification

  useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel(`notifications:${workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'staff_notifications',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          onNotificationRef.current(payload.new as StaffNotification)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [workspaceId])
}
