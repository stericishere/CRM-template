import { callLLM } from './llm-client.ts';

export async function generateRuleInstruction(
  patternKey: string,
  category: string,
  exampleEdits: Array<{ original: string; final: string }>,
): Promise<string> {
  const prompt = `You are writing a communication instruction for an AI messaging assistant. Based on these examples of staff corrections, write a single clear instruction that the AI should follow in all future drafts.

## Pattern: ${patternKey}
## Category: ${category}

## Staff Edit Examples
${exampleEdits.map((e, i) => `
### Example ${i + 1}
Original: ${e.original}
Staff corrected to: ${e.final}
`).join('\n')}

## Instructions
Write ONE imperative instruction sentence (1-2 lines max) addressed to the AI drafter.
- Use imperative voice: "Do X" or "Do not do Y"
- Be specific enough for the AI to act on
- Do not reference internal system concepts (pattern keys, signal IDs, counts)
- Do not reference specific client names from the examples

Respond with the instruction text only, no JSON wrapping.`;

  const result = await callLLM({
    model: 'cheap',
    systemPrompt: 'You write clear, concise communication instructions.',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 200,
  });

  const text = result.message.content?.[0]?.type === 'text'
    ? result.message.content[0].text
    : typeof result.message.content === 'string'
      ? result.message.content
      : '';

  return text.trim();
}
