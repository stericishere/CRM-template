// supabase/functions/_shared/llm-client.ts
// OpenRouter-compatible LLM client using OpenAI SDK
// ADR-005 amendment: routes through OpenRouter, models from env vars

import OpenAI from 'https://esm.sh/openai@4'

// Models from environment variables
export const PRO_MODEL = Deno.env.get('PRO_MODEL') ?? 'anthropic/claude-sonnet-4-20250514'
export const FLASH_MODEL = Deno.env.get('FLASH_MODEL') ?? 'anthropic/claude-haiku-4-5-20251001'
export const SMALL_MODEL = Deno.env.get('SMALL_MODEL') ?? 'anthropic/claude-haiku-4-5-20251001'
export const EMBEDDING_MODEL = Deno.env.get('EMBEDDING_MODEL') ?? 'text-embedding-3-small'

let _client: OpenAI | null = null

export function getLLMClient(): OpenAI {
  if (_client) return _client

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY environment variable')
  }

  _client = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': Deno.env.get('SITE_URL') ?? 'https://crm-template.vercel.app',
      'X-Title': 'CRM Template',
    },
  })

  return _client
}

export interface LLMCallParams {
  model?: string
  systemPrompt: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  tools?: OpenAI.Chat.ChatCompletionTool[]
  maxTokens?: number
}

export interface LLMCallResult {
  message: OpenAI.Chat.ChatCompletionMessage
  usage: { tokensIn: number; tokensOut: number }
  model: string
  finishReason: string | null
}

export async function callLLM(params: LLMCallParams): Promise<LLMCallResult> {
  const client = getLLMClient()
  const model = params.model ?? PRO_MODEL

  const response = await client.chat.completions.create({
    model,
    max_tokens: params.maxTokens ?? 1024,
    messages: [
      { role: 'system', content: params.systemPrompt },
      ...params.messages,
    ],
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
  })

  const choice = response.choices[0]
  if (!choice) throw new Error('LLM returned no choices')

  return {
    message: choice.message,
    usage: {
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
    },
    model: response.model ?? model,
    finishReason: choice.finish_reason,
  }
}

/**
 * Calculate estimated cost in USD based on model and token counts.
 */
export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing: Record<string, { input: number; output: number }> = {
    'anthropic/claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
    'anthropic/claude-haiku-4-5-20251001': { input: 0.80, output: 4.0 },
  }

  const p = pricing[model] ?? { input: 3.0, output: 15.0 }
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000
}
