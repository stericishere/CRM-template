// supabase/functions/_shared/action-executor.ts
// Dispatches approved actions to domain writes
// Called after staff approval via approve-action Edge Function
//
// Flow:
//
//   approve-action Edge Function
//         │
//         ▼
//   executeApprovedAction(supabase, action)
//         │
//         ├─ booking_create      → bookings INSERT
//         ├─ client_update       → clients UPDATE (scoped fields)
//         ├─ followup_create     → follow_ups INSERT
//         ├─ message_send        → (no-op — routed to Baileys via Next.js)
//         ├─ note_create         → notes INSERT
//         ├─ tag_attach          → clients UPDATE tags[] (read-modify-write)
//         └─ last_contacted_update → clients UPDATE last_contacted_at

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { ProposedAction } from './sprint2-types.ts'

interface ExecutionResult {
  success: boolean
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * Execute an approved action by dispatching to the appropriate domain write.
 * Each action type has its own handler.
 *
 * All writes are scoped by workspace_id to prevent cross-tenant leakage.
 */
export async function executeApprovedAction(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  try {
    switch (action.actionType) {
      case 'booking_create':
        return await executeBookingCreate(supabase, action)
      case 'client_update':
        return await executeClientUpdate(supabase, action)
      case 'followup_create':
        return await executeFollowUpCreate(supabase, action)
      case 'message_send':
        return await executeMessageSend(supabase, action)
      case 'note_create':
        return await executeNoteCreate(supabase, action)
      case 'tag_attach':
        return await executeTagAttach(supabase, action)
      case 'last_contacted_update':
        return await executeLastContactedUpdate(supabase, action)
      default:
        return { success: false, error: `Unknown action type: ${action.actionType}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[action_executor] ${action.actionType} failed:`, message)
    return { success: false, error: message }
  }
}

async function executeBookingCreate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const appointmentType = action.payload.appointmentType as string
  const startTime = action.payload.startTime as string
  const notes = (action.payload.notes as string) ?? null

  if (!appointmentType || !startTime) {
    return { success: false, error: 'Missing appointmentType or startTime in payload' }
  }

  // Look up service duration from workspace vertical_config
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('vertical_config')
    .eq('id', action.workspaceId)
    .single()

  const verticalConfig = workspace?.vertical_config as Record<string, unknown> | null
  const appointmentTypes = Array.isArray(verticalConfig?.appointmentTypes)
    ? (verticalConfig.appointmentTypes as Array<{ name: string; durationMinutes?: number }>)
    : []

  const serviceConfig = appointmentTypes.find(
    t => t.name.toLowerCase() === appointmentType.toLowerCase()
  )
  const durationMinutes = serviceConfig?.durationMinutes ?? 60 // default 60 min

  // Compute end_time from start_time + duration
  const startDate = new Date(startTime)
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000)

  const { error } = await supabase.from('bookings').insert({
    workspace_id: action.workspaceId,
    client_id: action.clientId,
    appointment_type: appointmentType,
    start_time: startDate.toISOString(),
    end_time: endDate.toISOString(),
    status: 'confirmed',
    confirmation_status: 'confirmed',
    notes,
  })

  if (error) return { success: false, error: error.message }
  return {
    success: true,
    metadata: { appointmentType, startTime, durationMinutes, endTime: endDate.toISOString() },
  }
}

async function executeClientUpdate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const changes = action.payload.changes as Record<string, unknown> ?? {}
  const { error } = await supabase
    .from('clients')
    .update(changes)
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)

  if (error) return { success: false, error: error.message }
  return { success: true, metadata: { updatedFields: Object.keys(changes) } }
}

async function executeFollowUpCreate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const { error } = await supabase.from('follow_ups').insert({
    workspace_id: action.workspaceId,
    client_id: action.clientId,
    content: action.payload.description,
    due_date: action.payload.dueDate ?? null,
    status: 'open',
    source: 'ai_proposed',
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}

async function executeMessageSend(
  _supabase: SupabaseClient,
  _action: ProposedAction
): Promise<ExecutionResult> {
  // Message sending is handled by the send Server Action in Next.js
  // This is a placeholder — approve-action routes message_send to the Baileys server
  return { success: true, metadata: { note: 'Message send routed to Baileys via Next.js Server Action' } }
}

async function executeNoteCreate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const { error } = await supabase.from('notes').insert({
    workspace_id: action.workspaceId,
    client_id: action.clientId,
    content: action.payload.content,
    source: 'ai_extracted',
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}

async function executeTagAttach(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  // Tags are stored as a text[] on the clients table.
  // Read-modify-write pattern: fetch current tags, append if not present.
  const { data: client, error: fetchError } = await supabase
    .from('clients')
    .select('tags')
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)
    .single()

  if (fetchError) return { success: false, error: fetchError.message }

  const currentTags: string[] = client?.tags ?? []
  const newTag = action.payload.tag as string
  if (currentTags.includes(newTag)) {
    return { success: true, metadata: { note: 'Tag already exists' } }
  }

  const { error } = await supabase
    .from('clients')
    .update({ tags: [...currentTags, newTag] })
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

async function executeLastContactedUpdate(
  supabase: SupabaseClient,
  action: ProposedAction
): Promise<ExecutionResult> {
  const { error } = await supabase
    .from('clients')
    .update({ last_contacted_at: new Date().toISOString() })
    .eq('id', action.clientId)
    .eq('workspace_id', action.workspaceId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}
