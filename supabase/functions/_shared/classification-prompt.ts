import { EDIT_CATEGORIES } from './types/learning.ts';

export function buildClassificationPrompt(
  originalDraft: string,
  finalVersion: string,
  intentClassified: string | null,
  scenarioType: string | null,
  existingPatternKeys: string[],
): string {
  return `You are an edit classifier for a business messaging assistant. Staff edited an AI-generated draft before sending it. Analyze what changed and why.

## Edit Categories (select one or more)
${EDIT_CATEGORIES.map(c => `- ${c}`).join('\n')}

## Severity Levels
- minor: cosmetic changes (punctuation, whitespace, minor word swap)
- significant: meaningful change to tone, content, or structure
- rewrite: staff replaced more than half the draft text

## Existing Pattern Keys for This Workspace
${existingPatternKeys.length > 0
  ? existingPatternKeys.map(k => `- ${k}`).join('\n')
  : '(none yet — assign new keys as needed)'}

## Pattern Key Format
Use lowercase_underscore format: {verb}_{object}_{context}
Examples: soften_greeting_tone, remove_upsell_reminders, shorten_booking_confirmation
IMPORTANT: Reuse an existing key if the edit matches an existing pattern. Only create a new key if no existing key fits.

## Context
- Intent: ${intentClassified ?? 'unknown'}
- Scenario: ${scenarioType ?? 'unknown'}

## Original Draft
${originalDraft}

## Final Version (what staff sent)
${finalVersion}

## Instructions
1. Compare the original draft and final version.
2. Identify all meaningful changes.
3. Classify each change into one or more edit categories.
4. Assess the overall severity.
5. Assign one or more pattern keys (reuse existing keys when applicable).
6. Write brief analysis notes explaining what changed and why.

Respond with valid JSON only:
{
  "edit_categories": ["category1", "category2"],
  "severity": "minor|significant|rewrite",
  "pattern_keys": ["pattern_key_1"],
  "analysis_notes": "Brief explanation of changes"
}`;
}

export const CLASSIFICATION_FEW_SHOT = [
  {
    role: 'user' as const,
    content: 'Original Draft:\n"Dear Mr. Chen, I trust this message finds you well. I am writing to confirm your appointment."\n\nFinal Version:\n"Hey David! Just confirming your appointment tomorrow 😊"',
  },
  {
    role: 'assistant' as const,
    content: '{"edit_categories":["tone_warmed","shortened"],"severity":"significant","pattern_keys":["soften_greeting_tone"],"analysis_notes":"Staff replaced formal greeting with casual, shortened the message, and added emoji."}',
  },
  {
    role: 'user' as const,
    content: 'Original Draft:\n"Your next facial is coming up! By the way, have you considered our premium anti-aging package?"\n\nFinal Version:\n"Just a reminder about your facial appointment this Thursday!"',
  },
  {
    role: 'assistant' as const,
    content: '{"edit_categories":["upsell_removed","shortened"],"severity":"significant","pattern_keys":["remove_upsell_reminders"],"analysis_notes":"Staff removed the upsell pitch and shortened to a simple reminder."}',
  },
];
