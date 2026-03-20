/** Categorization input sent to Haiku */
export interface CategorizationInput {
  note_content: string;
  note_created_at: string;
  client_profile: {
    full_name: string | null;
    phone_number: string | null;
    email: string | null;
    tags: string[];
    preferences: Record<string, unknown>;
    lifecycle_status: string;
  };
  workspace_custom_fields: string[];
  current_date: string;
  workspace_timezone: string;
  existing_open_promises: Array<{
    content: string;
    due_date: string | null;
  }>;
}

/** Individual extraction from categorization response */
export type Extraction =
  | {
      category: 'FOLLOW_UP';
      description: string;
      due_date: string | null;
    }
  | {
      category: 'PROMISE';
      description: string;
      due_date: string | null;
      is_duplicate: boolean;
    }
  | {
      category: 'CLIENT_UPDATE';
      field: string;
      before_value: unknown;
      after_value: unknown;
    };

/** Full categorization response from Haiku */
export interface CategorizationResponse {
  extractions: Extraction[];
}

/** Valid fields for CLIENT_UPDATE extractions */
export const UPDATABLE_FIELDS = [
  'full_name',
  'phone_number',
  'email',
  'tags',
  'lifecycle_status',
] as const;

/** Prefix for preference/custom field updates */
export const PREFERENCES_PREFIX = 'preferences.' as const;

/** Note extraction status lifecycle: pending → processing → complete/failed */
export type ExtractionStatus = 'pending' | 'processing' | 'complete' | 'failed' | 'not_applicable';

/** Context update parser result */
export interface ContextUpdateResult {
  isCommand: boolean;
  source?: 'conversation_update';
  parsedIntent?: {
    field: string;
    value: unknown;
    action: 'set' | 'add' | 'remove';
  };
}
