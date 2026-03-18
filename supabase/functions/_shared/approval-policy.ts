// supabase/functions/_shared/approval-policy.ts
// Three-tier approval: auto / review / human_only
// MVP: fixed policy, no per-workspace customization

import type { ProposedAction, ApprovalTier, ProposedActionType } from './sprint2-types.ts'

// Fixed MVP policy — all draft replies require review
const AUTO_ACTIONS: Set<ProposedActionType> = new Set([
  'note_create',
  'last_contacted_update',
])

const HUMAN_ONLY_ACTIONS: Set<ProposedActionType> = new Set([
  // No human_only actions in MVP — everything not auto is review
])

export const DEFAULT_POLICY = {
  autoActions: AUTO_ACTIONS,
  humanOnlyActions: HUMAN_ONLY_ACTIONS,
}

/**
 * Classify a proposed action into its approval tier.
 */
export function classifyTier(actionType: ProposedActionType): ApprovalTier {
  if (AUTO_ACTIONS.has(actionType)) return 'auto'
  if (HUMAN_ONLY_ACTIONS.has(actionType)) return 'human_only'
  return 'review'
}

/**
 * Evaluate all proposed actions from a Client Worker result.
 * Returns actions grouped by tier with tier assigned.
 */
export function evaluateApprovalPolicy(
  actions: ProposedAction[]
): {
  auto: ProposedAction[]
  review: ProposedAction[]
  humanOnly: ProposedAction[]
} {
  const result = {
    auto: [] as ProposedAction[],
    review: [] as ProposedAction[],
    humanOnly: [] as ProposedAction[],
  }

  for (const action of actions) {
    const tier = classifyTier(action.actionType)
    action.tier = tier

    switch (tier) {
      case 'auto':
        result.auto.push(action)
        break
      case 'review':
        result.review.push(action)
        break
      case 'human_only':
        result.humanOnly.push(action)
        break
    }
  }

  return result
}

/**
 * Build a human-readable summary of a proposed action for confirmation cards.
 */
export function buildConfirmationSummary(action: ProposedAction): string {
  switch (action.actionType) {
    case 'booking_create':
      return `Book appointment: ${action.payload.appointmentType ?? 'unknown type'}`
    case 'client_update':
      return `Update client: ${Object.keys(action.payload.changes as Record<string, unknown> ?? {}).join(', ')}`
    case 'followup_create':
      return `Create follow-up: ${action.payload.description ?? ''}`
    case 'message_send':
      return `Send message to client`
    case 'note_create':
      return `Save note: ${(action.payload.content as string ?? '').slice(0, 50)}...`
    case 'tag_attach':
      return `Add tag: ${action.payload.tag ?? ''}`
    case 'last_contacted_update':
      return `Update last contacted timestamp`
    default:
      return action.summary
  }
}
