import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'

import { createAnthropicPort, extractJsonObject } from './anthropic.ts'
import { createOpenAiPort } from './openai.ts'
import type { AiCompletionRequest } from './provider.ts'

/**
 * The two provider adapters against fake SDK clients: what each sends, how
 * each reads a reply, and how each turns an SDK error into a `failed` result
 * rather than a throw. No network.
 */

const request: AiCompletionRequest = {
  model: 'claude-opus-5',
  maxTokens: 16000,
  instructions: 'You are the Kelpie hosted AI. You have no tools.',
  messages: [{ role: 'user', text: 'Enrich Ada.' }],
  responseFormat: { name: 'kelpie_proposal', schema: { type: 'object' } },
}

function anthropicClient(create: (params: unknown) => Promise<unknown>): Anthropic {
  return { beta: { messages: { create } } } as unknown as Anthropic
}

function anthropicMessage(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: '{"summary":"ok","operations":[]}' }],
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 30, output_tokens: 10 },
    ...overrides,
  }
}

describe('createAnthropicPort', () => {
  it('sends the schema in the system prompt and opts Opus into refusal fallbacks', async () => {
    const sent: Record<string, unknown>[] = []
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient((params) => {
        sent.push(params as Record<string, unknown>)
        return Promise.resolve(anthropicMessage({}))
      }),
    })

    const result = await port.complete(request)

    expect(result).toEqual({
      stopReason: 'end_turn',
      text: '{"summary":"ok","operations":[]}',
      usage: { inputTokens: 30, outputTokens: 10, requests: 1, webSearches: 0 },
    })
    expect(sent[0]).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'Enrich Ada.' }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    expect(sent[0]?.system).toContain('You have no tools.')
    expect(sent[0]?.system).toContain('"kelpie_proposal"')
    expect(sent[0]?.system).toContain('{"type":"object"}')
    // No constrained format: the proposal schema is outside the supported subset.
    expect(sent[0]).not.toHaveProperty('output_config')
  })

  it('leaves out fallbacks for a model that does not take them', async () => {
    const sent: Record<string, unknown>[] = []
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient((params) => {
        sent.push(params as Record<string, unknown>)
        return Promise.resolve(anthropicMessage({}))
      }),
    })

    await port.complete({ ...request, model: 'claude-haiku-4-5' })

    expect(sent[0]).not.toHaveProperty('fallbacks')
    expect(sent[0]).not.toHaveProperty('betas')
  })

  it('strips a code fence around the JSON object', async () => {
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient(() =>
        Promise.resolve(anthropicMessage({ content: [{ type: 'text', text: '```json\n{"summary":"x","operations":[]}\n```' }] })),
      ),
    })

    expect((await port.complete(request)).text).toBe('{"summary":"x","operations":[]}')
  })

  it('reports a refusal with its explanation', async () => {
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient(() =>
        Promise.resolve(
          anthropicMessage({
            content: [],
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: 'Out of policy.' },
          }),
        ),
      ),
    })

    expect(await port.complete(request)).toMatchObject({
      stopReason: 'refusal',
      failure: { code: 'cyber', message: 'The model declined this task: Out of policy.' },
    })
  })

  it('reports max_tokens so the executor does not attempt a repair', async () => {
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient(() => Promise.resolve(anthropicMessage({ stop_reason: 'max_tokens' }))),
    })

    expect((await port.complete(request)).stopReason).toBe('max_tokens')
  })

  it('returns a rejected key as a failure the workspace can act on', async () => {
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient(() =>
        Promise.reject(new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers())),
      ),
    })

    expect(await port.complete(request)).toEqual({
      stopReason: 'failed',
      text: '',
      // The provider answered nothing, so nothing counts as a request.
      usage: { inputTokens: 0, outputTokens: 0, requests: 0, webSearches: 0 },
      failure: { code: 'invalid_api_key', message: 'The Anthropic API key was rejected. Check the key in AI settings.' },
    })
  })

  it('rethrows an error that is not an API error', async () => {
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient(() => Promise.reject(new TypeError('socket hang up'))),
    })

    await expect(port.complete(request)).rejects.toThrow('socket hang up')
  })
})

describe('extractJsonObject', () => {
  it('keeps a bare object and trims prose around one', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
    expect(extractJsonObject('Here you go: {"a":{"b":2}} Done.')).toBe('{"a":{"b":2}}')
  })

  it('returns text with no object unchanged, so the JSON parse fails', () => {
    expect(extractJsonObject('no json here')).toBe('no json here')
  })
})

function openAiClient(create: (params: unknown) => Promise<unknown>): OpenAI {
  return { responses: { create } } as unknown as OpenAI
}

describe('createOpenAiPort', () => {
  it('reads the output text of a completed response', async () => {
    const port = createOpenAiPort({
      apiKey: 'unused',
      client: openAiClient(() =>
        Promise.resolve({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"ok"}' }] }],
          usage: { input_tokens: 5, output_tokens: 6 },
        }),
      ),
    })

    expect(await port.complete({ ...request, model: 'gpt-5-mini' })).toEqual({
      stopReason: 'end_turn',
      text: '{"summary":"ok"}',
      usage: { inputTokens: 5, outputTokens: 6, requests: 1, webSearches: 0 },
    })
  })

  it('returns a rate limit or empty quota as a failure with the provider message', async () => {
    const port = createOpenAiPort({
      apiKey: 'unused',
      client: openAiClient(() =>
        Promise.reject(new OpenAI.RateLimitError(429, { message: 'You exceeded your current quota' }, undefined, new Headers())),
      ),
    })

    const result = await port.complete({ ...request, model: 'gpt-5-mini' })

    expect(result.stopReason).toBe('failed')
    expect(result.failure?.code).toBe('rate_limited')
    expect(result.failure?.message).toContain('You exceeded your current quota')
  })
})

describe('web search', () => {
  const searchRequest: AiCompletionRequest = { ...request, webSearch: { maxUses: 4 } }

  it('hands Anthropic the web search tool, resumes a paused turn, and reads the answer after the last search', async () => {
    const sent: Record<string, unknown>[] = []
    const replies = [
      anthropicMessage({
        stop_reason: 'pause_turn',
        usage: { input_tokens: 30, output_tokens: 10, server_tool_use: { web_search_requests: 1 } },
        content: [
          { type: 'text', text: 'Let me look {that} up.' },
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'Dana Reyes' } },
        ],
      }),
      anthropicMessage({
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srv_1',
            content: [{ type: 'web_search_result', url: 'https://brightline.health/team', title: 'Team', encrypted_content: 'x' }],
          },
          { type: 'text', text: '{"candidates":[]}' },
        ],
      }),
    ]
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient((params) => {
        // Copy the messages: the adapter appends to the same array between calls.
        const copy = params as Record<string, unknown>
        sent.push({ ...copy, messages: [...(copy.messages as unknown[])] })
        return Promise.resolve(replies.shift())
      }),
    })

    const result = await port.complete(searchRequest)

    expect(result).toEqual({
      stopReason: 'end_turn',
      text: '{"candidates":[]}',
      // Two requests: the paused turn and its continuation. One search between them.
      usage: { inputTokens: 60, outputTokens: 20, requests: 2, webSearches: 1 },
      webSources: [{ url: 'https://brightline.health/team', title: 'Team' }],
    })
    expect(sent[0]?.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }])
    // The paused turn goes back as it came, with no "continue" message.
    expect(sent[1]?.messages).toMatchObject([{ role: 'user' }, { role: 'assistant' }])
  })

  it('uses the basic web search tool on a model without dynamic filtering', async () => {
    const sent: Record<string, unknown>[] = []
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient((params) => {
        sent.push(params as Record<string, unknown>)
        return Promise.resolve(anthropicMessage({}))
      }),
    })

    await port.complete({ ...searchRequest, model: 'claude-haiku-4-5' })

    expect(sent[0]?.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }])
  })

  it('fails a search that is still paused after the last continuation', async () => {
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient(() =>
        Promise.resolve(
          anthropicMessage({
            stop_reason: 'pause_turn',
            content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } }],
          }),
        ),
      ),
    })

    const result = await port.complete(searchRequest)

    expect(result.stopReason).toBe('failed')
    expect(result.failure?.code).toBe('pause_turn')
  })

  it('hands OpenAI the web search tool and reads its sources and citations', async () => {
    const sent: Record<string, unknown>[] = []
    const port = createOpenAiPort({
      apiKey: 'unused',
      client: openAiClient((params) => {
        sent.push(params as Record<string, unknown>)
        return Promise.resolve({
          status: 'completed',
          output: [
            {
              type: 'web_search_call',
              id: 'ws_1',
              status: 'completed',
              action: { type: 'search', sources: [{ type: 'url', url: 'https://brightline.health/team' }] },
            },
            {
              type: 'web_search_call',
              id: 'ws_2',
              status: 'completed',
              action: { type: 'open_page', url: 'https://brightline.health/team' },
            },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: '{"candidates":[]}',
                  annotations: [
                    { type: 'url_citation', url: 'https://example.com/a', title: 'A', start_index: 0, end_index: 1 },
                  ],
                },
              ],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 6 },
        })
      }),
    })

    const result = await port.complete({ ...searchRequest, model: 'gpt-5-mini' })

    expect(sent[0]).toMatchObject({
      tools: [{ type: 'web_search' }],
      max_tool_calls: 4,
      include: ['web_search_call.action.sources'],
    })
    expect(result.webSources).toEqual([
      { url: 'https://brightline.health/team', title: 'https://brightline.health/team' },
      { url: 'https://example.com/a', title: 'A' },
    ])
    // Every web_search_call counts, the page open too: max_tool_calls caps them all.
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 6, requests: 1, webSearches: 2 })
  })

  it('keeps what earlier requests used when a resumed Anthropic turn throws', async () => {
    let calls = 0
    const port = createAnthropicPort({
      apiKey: 'unused',
      client: anthropicClient(() => {
        calls += 1
        if (calls === 1) {
          return Promise.resolve(
            anthropicMessage({
              stop_reason: 'pause_turn',
              usage: { input_tokens: 40, output_tokens: 5, server_tool_use: { web_search_requests: 2 } },
              content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } }],
            }),
          )
        }
        return Promise.reject(
          new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers()),
        )
      }),
    })

    const result = await port.complete(searchRequest)

    expect(result.stopReason).toBe('failed')
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 5, requests: 1, webSearches: 2 })
  })
})
