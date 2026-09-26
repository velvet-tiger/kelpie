import Anthropic from '@anthropic-ai/sdk'

import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProviderPort,
} from './provider.ts'

/**
 * Anthropic Messages API adapter for the data-in-data-out port.
 *
 * One `complete()` per model call:
 *
 *   - `instructions` becomes `system`, followed by the JSON schema the reply
 *     must match.
 *   - `messages` is the same plain user/assistant transcript the OpenAI
 *     adapter sends.
 *   - The reply's text blocks are joined, and the outermost JSON object in
 *     them is returned as `text`.
 *
 * **No `output_config.format`.** Anthropic's JSON outputs need
 * `additionalProperties: false` on every object and refuse `not`, length and
 * number limits. The proposal schema has an open record
 * (`update_target.fields`) and renders `z.never()` as `not`, so it cannot be
 * sent as a constrained format. The schema goes into the system prompt, and
 * the executor's Zod re-parse plus its one repair turn stay the authority.
 * That is the same posture as the OpenAI adapter, which sends its format with
 * `strict: false`.
 *
 * **Refusal fallbacks.** For the models that support it, the request opts
 * into server-side fallbacks (`fallbacks: 'default'`), so a safety decline is
 * retried on a fallback model inside the same call. A reply that still ends
 * in `refusal` is reported as one.
 *
 * **Errors are returned, not thrown.** A wrong key, an empty balance, or a
 * rate limit is the key owner's problem when the key is theirs, so the
 * adapter hands back a `failed` result with the provider's message and the
 * executor decides whether the customer sees it.
 */

/** Models that accept the `server-side-fallback-2026-07-01` beta. */
const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5', 'claude-fable-5-1'])

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export interface AnthropicPortOptions {
  readonly apiKey: string
  /** Injected so tests can swap the client. Production passes nothing. */
  readonly client?: Anthropic
}

export function createAnthropicPort(options: AnthropicPortOptions): AiProviderPort {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey })

  return {
    async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
      const useFallbacks = FALLBACK_MODELS.has(request.model)
      let response: Anthropic.Beta.BetaMessage

      try {
        response = await client.beta.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          system: renderSystem(request),
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.text,
          })),
          ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        })
      } catch (thrown: unknown) {
        return failureFromThrown(thrown)
      }

      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
      let text = ''

      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text
        }
      }

      switch (response.stop_reason) {
        case 'end_turn':
        case 'stop_sequence':
          return { stopReason: 'end_turn', text: extractJsonObject(text), usage }
        case 'max_tokens':
          return { stopReason: 'max_tokens', text, usage }
        case 'refusal': {
          const explanation = response.stop_details?.explanation
          return {
            stopReason: 'refusal',
            text: '',
            usage,
            failure: {
              code: response.stop_details?.category ?? 'refusal',
              message:
                explanation === undefined || explanation === null
                  ? 'The model declined this task'
                  : `The model declined this task: ${explanation}`,
            },
          }
        }
        default: {
          const reason = response.stop_reason ?? 'unknown'
          return {
            stopReason: 'failed',
            text,
            usage,
            failure: { code: reason, message: `The model stopped with "${reason}"` },
          }
        }
      }
    },
  }
}

function renderSystem(request: AiCompletionRequest): string {
  return (
    `${request.instructions}\n\n` +
    `Reply with one JSON object and no other text. It must match this JSON schema ` +
    `(named "${request.responseFormat.name}"):\n` +
    JSON.stringify(request.responseFormat.schema)
  )
}

/**
 * The outermost `{…}` in a reply, so a stray code fence or a sentence around
 * the object does not cost a repair turn. A reply with no braces is returned
 * unchanged and fails the executor's JSON parse, which is the right outcome.
 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')

  if (start === -1 || end <= start) {
    return text
  }

  return text.slice(start, end + 1)
}

function failed(code: string, message: string): AiCompletionResult {
  return { stopReason: 'failed', text: '', usage: { inputTokens: 0, outputTokens: 0 }, failure: { code, message } }
}

function failureFromThrown(thrown: unknown): AiCompletionResult {
  if (thrown instanceof Anthropic.AuthenticationError) {
    return failed('invalid_api_key', 'The Anthropic API key was rejected. Check the key in AI settings.')
  }
  if (thrown instanceof Anthropic.PermissionDeniedError) {
    return failed('permission_denied', `Anthropic refused this key: ${thrown.message}`)
  }
  if (thrown instanceof Anthropic.NotFoundError) {
    return failed('model_not_found', `Anthropic does not know this model: ${thrown.message}`)
  }
  if (thrown instanceof Anthropic.RateLimitError) {
    return failed('rate_limited', 'Anthropic rate-limited this key. Try again shortly.')
  }
  if (thrown instanceof Anthropic.BadRequestError) {
    return failed('bad_request', `Anthropic rejected the request: ${thrown.message}`)
  }
  if (thrown instanceof Anthropic.APIError) {
    return failed(`http_${String(thrown.status ?? 'unknown')}`, `Anthropic returned an error: ${thrown.message}`)
  }

  // Not an API error: a network failure or a bug. Rethrow so the executor
  // logs it and shows the generic message.
  throw thrown
}
