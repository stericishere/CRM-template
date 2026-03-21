/** Fixed taxonomy of 17 edit categories */
export const EDIT_CATEGORIES = [
  'tone_softened',
  'tone_warmed',
  'tone_formalized',
  'shortened',
  'lengthened',
  'assumption_removed',
  'fact_corrected',
  'scheduling_options_added',
  'cta_softened',
  'cta_strengthened',
  'personalization_added',
  'upsell_removed',
  'policy_clarification_added',
  'greeting_changed',
  'closing_changed',
  'emoji_added_or_removed',
  'structure_reorganized',
] as const;

export type EditCategory = typeof EDIT_CATEGORIES[number];

export type EditSeverity = 'minor' | 'significant' | 'rewrite';

/** Classification LLM response */
export interface ClassificationResponse {
  edit_categories: string[];
  severity: string;
  pattern_keys: string[];
  analysis_notes: string;
}

/** Pattern recurrence row from database */
export interface PatternRecurrence {
  id: string;
  workspace_id: string;
  pattern_key: string;
  category: string;
  recurrence_count: number;
  distinct_clients: number;
  client_ids: string[];
  first_seen: string;
  last_seen: string;
  promoted: boolean;
  promoted_at: string | null;
}

/** Promotion threshold check result */
export interface PromotionResult {
  shouldPromote: boolean;
  reason: string;
}

/** Communication rule row from database */
export interface CommunicationRule {
  id: string;
  workspace_id: string;
  category: string;
  instruction: string;
  confidence: number;
  source_pattern_key: string;
  source_type: 'auto' | 'staff_flagged';
  example_edits: Array<{ original: string; final: string }> | null;
  active: boolean;
  promoted_at: string;
  updated_at: string;
}
