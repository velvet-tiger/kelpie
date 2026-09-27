import Anthropic from '@anthropic-ai/sdk'

import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProviderPort,
  AiWebSource,
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
 * **Web search.** When the request asks for it, the model gets Anthropic's
 * server-side `web_search` tool and nothing else. A long search can end a
 * response in `pause_turn`; the adapter sends the paused turn straight back,
 * as the API expects, up to {@link MAX_PAUSE_CONTINUATIONS} times. The answer
 * is the text after the last search result, so the model's "let me look
 * that up" narration never reaches the JSON parse. Every URL the search
 * returned comes back as `webSources`.
 *
 * **Errors are returned, not thrown.** A wrong key, an empty balance, or a
 * rate limit is the key owner's problem when the key is theirs, so the
 * adapter hands back a `failed` result with the provider's message and the
 * executor decides whether the customer sees it.
 */

/** Models that accept the `server-side-fallback-2026-07-01` beta. */
const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5', 'claude-fable-5-1'])

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/**
 * Models that take `web_search_20260209`, the variant with dynamic filtering.
 * Every other model gets the basic `web_search_20250305`, which all current
 * models accept.
 */
const DYNAMIC_WEB_SEARCH_MODEL = /^claude-(opus-(5|4-8|4-7|4-6)|sonnet-(5|4-6))(\b|-)/u

/** How many times a paused search turn is resumed before the adapter gives up. */
const MAX_PAUSE_CONTINUATIONS = 3

export function webSearchToolFor(
  model: string,
  maxUses: number,
): Anthropic.Beta.BetaWebSearchTool20250305 | Anthropic.Beta.BetaWebSearchTool20260209 {
  return DYNAMIC_WEB_SEARCH_MODEL.test(model)
    ? { type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }
    : { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }
}

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
      const tools =
        request.webSearch === undefined ? undefined : [webSearchToolFor(request.model, request.webSearch.maxUses)]
      const messages: Anthropic.Beta.BetaMessageParam[] = request.messages.map((message) => ({
        role: message.role,
        content: message.text,
      }))
      const webSources: AiWebSource[] = []
      const usage = { inputTokens: 0, outputTokens: 0, requests: 0, webSearches: 0 }
      let response: Anthropic.Beta.BetaMessage | undefined

      for (let attempt = 0; attempt <= MAX_PAUSE_CONTINUATIONS; attempt += 1) {
        try {
          response = await client.beta.messages.create({
            model: request.model,
            max_tokens: request.maxTokens,
            system: renderSystem(request),
            messages,
            ...(tools === undefined ? {} : { tools }),
            ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          })
        } catch (thrown: unknown) {
          // A resumed turn that throws keeps what the earlier requests used:
          // those were billed.
          return { ...failureFromThrown(thrown), usage }
        }

        usage.requests += 1
        usage.inputTokens += response.usage.input_tokens
        usage.outputTokens += response.usage.output_tokens
        usage.webSearches += response.usage.server_tool_use?.web_search_requests ?? 0
        webSources.push(...webSourcesIn(response.content))

        if (response.stop_reason !== 'pause_turn') {
          break
        }

        // The API resumes from a trailing server_tool_use block on its own.
        // No "continue" message: that would read as a new user turn.
        messages.push({ role: 'assistant', content: response.content })
      }

      if (response === undefined) {
        return failed('no_response', 'Anthropic returned no response')
      }

      const text = answerText(response.content)
      // Only a search call reports sources, so an agent-task result is unchanged.
      const sources = tools === undefined ? {} : { webSources }

      if (response.stop_reason === 'pause_turn') {
        return {
          stopReason: 'failed',
          text,
          usage,
          ...sources,
          failure: { code: 'pause_turn', message: 'The web search did not finish. Try again with more specific notes.' },
        }
      }

      switch (response.stop_reason) {
        case 'end_turn':
        case 'stop_sequence':
          return { stopReason: 'end_turn', text: extractJsonObject(text), usage, ...sources }
        case 'max_tokens':
          return { stopReason: 'max_tokens', text, usage, ...sources }
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

/**
 * The reply text after the last server-tool block. With no search this is
 * every text block, as before; with search it skips the narration between
 * searches, which can carry braces of its own.
 */
function answerText(content: readonly Anthropic.Beta.BetaContentBlock[]): string {
  let lastToolIndex = -1

  content.forEach((block, index) => {
    if (block.type === 'server_tool_use' || block.type === 'web_search_tool_result') {
      lastToolIndex = index
    }
  })

  let text = ''

  for (const block of content.slice(lastToolIndex + 1)) {
    if (block.type === 'text') {
      text += block.text
    }
  }

  return text
}

/**
 * The pages a response's searches returned. A search that failed carries an
 * error object instead of a list, and contributes nothing.
 */
function webSourcesIn(content: readonly Anthropic.Beta.BetaContentBlock[]): readonly AiWebSource[] {
  const sources: AiWebSource[] = []

  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) {
      continue
    }
    for (const result of block.content) {
      if (result.type === 'web_search_result') {
        sources.push({ url: result.url, title: result.title })
      }
    }
  }

  return sources
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
  return {
    stopReason: 'failed',
    text: '',
    usage: { inputTokens: 0, outputTokens: 0, requests: 0, webSearches: 0 },
    failure: { code, message },
  }
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
