import type { CategorizationInput } from './types/extraction.ts';

export const CATEGORIZATION_SYSTEM_PROMPT = `You are a CRM note categorization engine. Your job is to analyze a staff note about a client and extract structured, actionable items.

You will receive:
- The note text written by a staff member
- The client's current profile (name, phone, email, tags, preferences, lifecycle_status)
- The workspace's custom field definitions
- Today's date and workspace timezone
- A list of existing open promises for this client (for deduplication)

Extract ALL of the following that apply:

1. **FOLLOW_UPS**: Tasks the staff needs to do (e.g., "follow up about wedding quote", "call back about fitting"). These are NOT promises.
2. **PROMISES**: Commitments made BY staff or the business TO the client (e.g., "I promised her 10% off", "we'll have alterations ready by Tuesday"). Only extract from staff-side commitments, not client requests.
3. **CLIENT_UPDATES**: Changes to the client's profile data. Only propose changes to these fields:
   - full_name
   - phone_number (normalize to E.164 format)
   - email
   - tags (add or remove)
   - preferences (including custom fields listed in the workspace config)
   - lifecycle_status
   Do NOT propose changes to fields not in this list.

For each extracted item, include:
- A clear, concise description
- The category (FOLLOW_UP, PROMISE, or CLIENT_UPDATE)
- For follow-ups and promises: a due_date if a temporal reference exists, or null if none
- For client updates: the field name, current value (before_value), and proposed value (after_value)

DEDUPLICATION: Compare any detected promises against the existing open promises list provided. If a promise is semantically equivalent to an existing one, set is_duplicate to true.

DATE RESOLUTION: When the note contains relative date references ("by Friday", "next week", "tomorrow"), resolve them to absolute ISO 8601 dates (YYYY-MM-DD) using the provided current date and timezone. If the reference is too vague ("soon", "sometime"), set due_date to null.

If the note contains NO actionable items, return an empty extractions array.

Respond with ONLY valid JSON matching this schema:
{
  "extractions": [
    { "category": "FOLLOW_UP", "description": "...", "due_date": "YYYY-MM-DD" | null },
    { "category": "PROMISE", "description": "...", "due_date": "YYYY-MM-DD" | null, "is_duplicate": false },
    { "category": "CLIENT_UPDATE", "field": "field_name", "before_value": "...", "after_value": "..." }
  ]
}`;

export function buildCategorizationUserMessage(input: CategorizationInput): string {
  const promises = input.existing_open_promises.length > 0
    ? input.existing_open_promises.map(p =>
        `- "${p.content}" (due: ${p.due_date ?? 'no date'})`
      ).join('\n')
    : 'None';

  return `Note text:
"${input.note_content}"

Note saved at: ${input.note_created_at}
Today's date: ${input.current_date}
Timezone: ${input.workspace_timezone}

Client profile:
- Name: ${input.client_profile.full_name ?? 'Unknown'}
- Phone: ${input.client_profile.phone_number ?? 'Unknown'}
- Email: ${input.client_profile.email ?? 'Unknown'}
- Tags: ${input.client_profile.tags.join(', ') || 'None'}
- Preferences: ${JSON.stringify(input.client_profile.preferences)}
- Lifecycle status: ${input.client_profile.lifecycle_status}

Workspace custom fields: ${input.workspace_custom_fields.join(', ') || 'None'}

Existing open promises for this client:
${promises}

Extract all actionable items from the note.`;
}
