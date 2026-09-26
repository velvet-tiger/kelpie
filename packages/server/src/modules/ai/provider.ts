/**
 * The narrow, provider-neutral seam the executor calls.
 *
 * A vendor SDK is not exposed across this boundary: the fake and the real
 * adapter both live behind {@link AiProviderPort.complete}. Adding a Claude
 * adapter later means one new file that returns the same shapes and a
 * one-line change in `index.ts`.
 *
 * One request, one reply. The model is asked to return JSON that matches
 * {@link AiCompletionRequest.responseFormat}, and the executor validates
 * the reply against its own Zod schema before applying anything. No tools
 * are passed to the model — this port has no notion of a tool.
 */

export interface AiResponseFormat {
  /** The `name` OpenAI attaches to a `text.format` of type `json_schema`. */
  readonly name: string
  /** The JSON schema the model's reply must conform to. */
  readonly schema: Record<string, unknown>
}

export interface AiUserMessage {
  readonly role: 'user'
  readonly text: string
}

export interface AiAssistantMessage {
  readonly role: 'assistant'
  readonly text: string
}

/**
 * A minimal chat history. `instructions` above the messages carries the
 * system-level framing; messages carry the task briefing and, on the
 * repair turn, the invalid JSON and the parse issues.
 */
export type AiMessage = AiUserMessage | AiAssistantMessage

export interface AiCompletionRequest {
  readonly model: string
  readonly maxTokens: number
  /** System-level framing. Sent as the Responses API `instructions` field. */
  readonly instructions: string
  readonly messages: readonly AiMessage[]
  readonly responseFormat: AiResponseFormat
}

export type AiStopReason =
  /** Model produced a final answer. `text` is that answer, expected to be JSON. */
  | 'end_turn'
  /** Output cap hit; `text` is whatever was produced and is likely unparseable. */
  | 'max_tokens'
  /** Provider safety layer refused; `failure` explains it if it can. */
  | 'refusal'
  /** Anything else the adapter did not classify. */
  | 'failed'

export interface AiTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface AiFailure {
  readonly code: string
  readonly message: string
}

export interface AiCompletionResult {
  readonly stopReason: AiStopReason
  /** The assistant text on `end_turn` / `max_tokens`, or the empty string. */
  readonly text: string
  readonly usage: AiTokenUsage
  /** Populated when `stopReason` is `refusal` or `failed`. */
  readonly failure?: AiFailure
}

export interface AiProviderPort {
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>
}
