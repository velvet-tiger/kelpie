import { z } from 'zod'

import type { Actor } from '../../lib/actor.ts'
import { AppError, describeThrown, internalErrorBody, toErrorBody } from '../../lib/errors.ts'
import type { Logger } from '../../lib/logger.ts'
import type { McpTool } from '../../runtime/module.ts'

/**
 * JSON-RPC 2.0 and the MCP methods Kelpie answers, as pure functions over parsed
 * messages. The transport around them lives in `router.ts`.
 *
 * Kelpie is a tool server and nothing else: it declares the `tools` capability,
 * never initiates a message, and holds no per-client state. That is what makes it
 * safe to answer every POST from any instance without a session id.
 */

/** Newest revision Kelpie speaks. Returned to a client that asks for anything unknown. */
export const LATEST_PROTOCOL_VERSION = '2025-06-18'

/**
 * Revisions Kelpie speaks, newest first.
 *
 * `2025-03-26` is kept because its clients are the ones that send JSON-RPC
 * batches, which `2025-06-18` removed. Answering both costs one array branch in
 * the transport and keeps older MCP clients working.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26']

/** JSON-RPC's own codes. Anything Kelpie refuses maps onto one of these. */
export const PARSE_ERROR = -32_700
export const INVALID_REQUEST = -32_600
export const METHOD_NOT_FOUND = -32_601
export const INVALID_PARAMS = -32_602
export const INTERNAL_ERROR = -32_603

export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/**
 * Null only ever appears on an error response whose request could not be read far
 * enough to find an id. JSON-RPC requires it there; MCP forbids it on a request.
 */
export type JsonRpcId = string | number | null

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly result?: unknown
  readonly error?: JsonRpcError
}

/**
 * An incoming message. `id` present means a request that must be answered; absent
 * means a notification, which must not be.
 *
 * Loose about `params` on purpose: each method validates its own, so a bad shape
 * is that method's `-32602` rather than a blanket parse failure that says nothing
 * about which field was wrong.
 */
const messageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export type JsonRpcMessage = z.infer<typeof messageSchema>

const initializeParams = z.object({
  protocolVersion: z.string().min(1),
  capabilities: z.unknown().optional(),
  clientInfo: z.unknown().optional(),
})

const callToolParams = z.object({
  name: z.string().min(1),
  arguments: z.unknown().optional(),
})

export interface McpServerInfo {
  readonly name: string
  readonly title: string
  readonly version: string
}

/** A tool as `tools/list` publishes it: the description plus a JSON Schema. */
export interface PublishedTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface DispatchDependencies {
  readonly tools: readonly McpTool[]
  /** The `tools/list` payload, built once at mount. */
  readonly published: readonly PublishedTool[]
  readonly serverInfo: McpServerInfo
  /** Sent on `initialize`, to tell an agent what this workspace's data is for. */
  readonly instructions: string
  readonly logger: Logger
}

/**
 * Converts a tool's Zod input schema to the JSON Schema `tools/list` publishes.
 *
 * `io: 'input'` matters: a field with a `.default()` is optional to the caller and
 * required to the tool body, and only the input view says so.
 *
 * @throws When a schema has no JSON Schema equivalent. Called at mount, so that
 *   is a boot failure rather than a broken tool listing.
 */
export function publishTool(tool: McpTool): PublishedTool {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' })

  // `$schema` is valid and useless here: MCP already fixes the dialect, and the
  // key repeats on every one of a hundred tools in every listing.
  delete schema.$schema

  return { name: tool.name, description: tool.description, inputSchema: schema }
}

/** Parses one incoming message. */
export function parseMessage(value: unknown): JsonRpcMessage | undefined {
  const parsed = messageSchema.safeParse(value)

  return parsed.success ? parsed.data : undefined
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

/**
 * The version to answer `initialize` with.
 *
 * A client asking for one Kelpie speaks gets that one back, which is what lets a
 * `2025-03-26` client keep its batches. Anything else gets the newest, and the
 * client decides whether it can live with it.
 */
export function negotiateVersion(requested: string): string {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION
}

/**
 * Renders what a tool threw as a tool result rather than a JSON-RPC error.
 *
 * MCP draws that line deliberately: a protocol error means the call never
 * happened, while a tool that ran and refused is an answer the model should see
 * and can act on. The body is the same `api.md` error shape the REST route would
 * have returned, so a 404 reads identically on both surfaces.
 */
function toolFailure(logger: Logger, toolName: string, error: unknown): unknown {
  if (error instanceof AppError) {
    return {
      content: [{ type: 'text', text: JSON.stringify(toErrorBody(error)) }],
      isError: true,
    }
  }

  logger.error('mcp tool failed', { tool: toolName, error: describeThrown(error) })

  return {
    content: [{ type: 'text', text: JSON.stringify(internalErrorBody()) }],
    isError: true,
  }
}

async function callTool(
  dependencies: DispatchDependencies,
  id: JsonRpcId,
  params: unknown,
  actor: Actor,
): Promise<JsonRpcResponse> {
  const parsed = callToolParams.safeParse(params)

  if (!parsed.success) {
    return failure(id, INVALID_PARAMS, 'tools/call needs a tool "name"')
  }

  const tool = dependencies.tools.find((candidate) => candidate.name === parsed.data.name)

  if (tool === undefined) {
    return failure(id, INVALID_PARAMS, `Unknown tool "${parsed.data.name}"`)
  }

  try {
    // `arguments` is optional on the wire and every tool schema is an object, so
    // an absent one is an empty object rather than a validation failure the
    // caller cannot act on.
    const value = await tool.invoke(parsed.data.arguments ?? {}, actor)

    return success(id, {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      isError: false,
    })
  } catch (error: unknown) {
    return success(id, toolFailure(dependencies.logger, tool.name, error))
  }
}

/**
 * Answers one message.
 *
 * @returns The response, or undefined for a notification, which JSON-RPC forbids
 *   answering.
 */
export async function dispatch(
  dependencies: DispatchDependencies,
  message: JsonRpcMessage,
  actor: Actor,
): Promise<JsonRpcResponse | undefined> {
  const { id } = message

  if (id === undefined) {
    // Kelpie subscribes to no client notifications. `notifications/initialized`
    // and the cancellations are acknowledged by the transport's 202 and dropped.
    return undefined
  }

  switch (message.method) {
    case 'initialize': {
      const parsed = initializeParams.safeParse(message.params)

      if (!parsed.success) {
        return failure(id, INVALID_PARAMS, 'initialize needs a "protocolVersion"')
      }

      return success(id, {
        protocolVersion: negotiateVersion(parsed.data.protocolVersion),
        // `listChanged: false`: the tool set is fixed at boot by the module list,
        // so there is never a change to notify.
        capabilities: { tools: { listChanged: false } },
        serverInfo: dependencies.serverInfo,
        instructions: dependencies.instructions,
      })
    }

    case 'ping':
      return success(id, {})

    case 'tools/list':
      // No pagination: the whole set is known at boot and is a few hundred
      // kilobytes at most, so a cursor would only add a round trip.
      return success(id, { tools: dependencies.published })

    case 'tools/call':
      return callTool(dependencies, id, message.params, actor)

    default:
      return failure(id, METHOD_NOT_FOUND, `Kelpie does not implement "${message.method}"`)
  }
}
