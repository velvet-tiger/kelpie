import OpenAI from 'openai'
import type { Responses } from 'openai/resources/responses/responses'

import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiMessage,
  AiProviderPort,
  AiStopReason,
} from './provider.ts'

/**
 * OpenAI Responses API adapter for the data-in-data-out port.
 *
 * One `complete()` per model call:
 *
 *   - `instructions` becomes the Responses `instructions` field: the system
 *     framing that tells the model it has no tools and must return JSON in
 *     the {@link AiCompletionRequest.responseFormat} shape.
 *   - `messages` is a plain user/assistant transcript (never more than two
 *     entries in the current flow: the task briefing, and on the repair
 *     turn, the model's invalid reply and the parse issues).
 *   - `responseFormat` is passed as `text.format` of type `json_schema`
 *     with `strict: false`. Kelpie's Zod re-parse in `proposal.ts` is the
 *     authority; the schema advertised to the model is advisory because
 *     `z.toJSONSchema` output does not meet OpenAI's strict subset.
 *   - The reply's `output_text` blocks are joined and returned as `text`.
 *     Stop reason comes from `status` / `incomplete_details`.
 *
 * API errors (a wrong key, no quota, a rate limit) come back as a `failed`
 * result carrying the provider's message, the same as `anthropic.ts`. The
 * executor decides whether the customer sees it.
 */

export interface OpenAiPortOptions {
  readonly apiKey: string
  /** Injected so tests can swap the client. Production passes nothing. */
  readonly client?: OpenAI
}

export function createOpenAiPort(options: OpenAiPortOptions): AiProviderPort {
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey })

  return {
    async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
      let response: Responses.Response
      try {
        response = await client.responses.create({
          model: request.model,
          max_output_tokens: request.maxTokens,
          instructions: request.instructions,
          input: request.messages.map(toInputItem),
          text: {
            format: {
              type: 'json_schema',
              name: request.responseFormat.name,
              schema: request.responseFormat.schema,
              strict: false,
            },
          },
        })
      } catch (thrown: unknown) {
        return failureFromThrown(thrown)
      }

      const usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      }
      let text = ''

      for (const item of response.output) {
        if (item.type === 'message') {
          for (const block of item.content) {
            if (block.type === 'output_text') {
              text += block.text
            }
          }
        }
      }

      if (response.status === 'completed') {
        return { stopReason: 'end_turn', text, usage }
      }

      if (response.status === 'incomplete') {
        const reason = response.incomplete_details?.reason
        if (reason === 'max_output_tokens') {
          return { stopReason: 'max_tokens', text, usage }
        }
        if (reason === 'content_filter') {
          return {
            stopReason: 'refusal',
            text,
            usage,
            failure: {
              code: 'content_filter',
              message: 'The provider refused this task on content-policy grounds',
            },
          }
        }
        return {
          stopReason: 'failed',
          text,
          usage,
          failure: {
            code: 'incomplete',
            message: `Response was incomplete${reason === undefined ? '' : `: ${reason}`}`,
          },
        }
      }

      // `failed`, `cancelled`, `in_progress`, `queued`, or anything the SDK
      // adds later.
      const statusLabel = response.status ?? 'unknown'
      const message =
        response.error?.message ?? `Provider returned status "${statusLabel}"`
      const stopReason: AiStopReason = 'failed'

      return {
        stopReason,
        text,
        usage,
        failure: { code: response.error?.code ?? statusLabel, message },
      }
    },
  }
}

function toInputItem(message: AiMessage): Responses.ResponseInputItem {
  return { role: message.role, content: message.text }
}

function failed(code: string, message: string): AiCompletionResult {
  return { stopReason: 'failed', text: '', usage: { inputTokens: 0, outputTokens: 0 }, failure: { code, message } }
}

function failureFromThrown(thrown: unknown): AiCompletionResult {
  if (thrown instanceof OpenAI.AuthenticationError) {
    return failed('invalid_api_key', 'The OpenAI API key was rejected. Check the key in AI settings.')
  }
  if (thrown instanceof OpenAI.PermissionDeniedError) {
    return failed('permission_denied', `OpenAI refused this key: ${thrown.message}`)
  }
  if (thrown instanceof OpenAI.NotFoundError) {
    return failed('model_not_found', `OpenAI does not know this model: ${thrown.message}`)
  }
  if (thrown instanceof OpenAI.RateLimitError) {
    return failed('rate_limited', `OpenAI rate-limited this key or the account is out of quota: ${thrown.message}`)
  }
  if (thrown instanceof OpenAI.BadRequestError) {
    return failed('bad_request', `OpenAI rejected the request: ${thrown.message}`)
  }
  if (thrown instanceof OpenAI.APIError) {
    return failed(`http_${String(thrown.status ?? 'unknown')}`, `OpenAI returned an error: ${thrown.message}`)
  }

  // Not an API error: a network failure or a bug. Rethrow so the executor
  // logs it and shows the generic message.
  throw thrown
}
