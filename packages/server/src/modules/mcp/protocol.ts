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
 *
 * **Two eras on one endpoint.** `2026-07-28` removed the `initialize` handshake
 * and moved the protocol version into every request, which the spec's own
 * vocabulary calls *modern*; everything before it is *legacy*. A dual-era server
 * is explicitly permitted to serve both, choosing from how the client opens, and
 * that is what this does. The eras differ in how a request arrives and how a
 * result is dressed; the tools underneath are the same objects either way.
 */

/** The two shapes of MCP. Fixed per request, never per connection: there is none. */
export type ProtocolEra = 'legacy' | 'modern'

/**
 * Revisions that carry version, identity and capabilities in each request's
 * `_meta` rather than establishing them with a handshake.
 */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28']

/**
 * Revisions that open with `initialize`.
 *
 * `2025-03-26` is kept because its clients are the ones that send JSON-RPC
 * batches, which `2025-06-18` removed. Answering both costs one array branch in
 * the transport and keeps older MCP clients working.
 */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26']

/** Everything Kelpie speaks, newest first. This is the list a `-32022` hands back. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...MODERN_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
]

/** Newest revision Kelpie speaks, which is also the newest that exists. */
export const LATEST_PROTOCOL_VERSION = '2026-07-28'

/**
 * Newest *legacy* revision, and the one an `initialize` naming something
 * unrecognised is answered with. Handing a legacy client `2026-07-28` would name
 * a revision in which the handshake it just completed does not exist.
 */
export const LATEST_LEGACY_PROTOCOL_VERSION = '2025-06-18'

/**
 * `_meta` keys the modern revision defines. Reverse-DNS prefixed, which is the
 * naming rule for anything outside a caller's own namespace.
 */
export const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion'
export const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo'
export const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities'
export const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'

/** JSON-RPC's own codes. Anything Kelpie refuses maps onto one of these. */
export const PARSE_ERROR = -32_700
export const INVALID_REQUEST = -32_600
export const METHOD_NOT_FOUND = -32_601
export const INVALID_PARAMS = -32_602
export const INTERNAL_ERROR = -32_603

/**
 * Codes MCP allocates for itself, from the `-32020` to `-32099` band the spec
 * reserves. Both were renumbered out of the implementation-defined range in
 * `2026-07-28`, so these values are the current ones and not the draft's.
 */
export const HEADER_MISMATCH = -32_020
export const UNSUPPORTED_PROTOCOL_VERSION = -32_022

/**
 * How long a client may hold the tool listing.
 *
 * The set is fixed at boot by the module list, so within one process it cannot
 * change at all; only a redeploy that adds a module can move it. An hour bounds
 * how long a client can be wrong about that, and matches the figure the spec's
 * own `server/discover` example uses.
 */
export const TOOL_LISTING_TTL_MS = 3_600_000

/**
 * Cacheable by anyone. The listing is derived from the module list, so it is
 * identical for every workspace and every key, and holds no workspace data — the
 * condition the spec sets for sharing a response across authorization contexts.
 */
const CACHE_HINTS = { ttlMs: TOOL_LISTING_TTL_MS, cacheScope: 'public' } as const

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

/** Reads the two body fields the transport mirrors into headers, and the `_meta` version. */
const requestEnvelope = z.object({
  name: z.string().optional(),
  _meta: z.object({ [PROTOCOL_VERSION_META]: z.string().min(1).optional() }).optional(),
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
  /** What this workspace's data is for. Sent on `initialize` and on `server/discover`. */
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

/** The protocol version a modern client puts in every request's `_meta`. */
export function readMetaVersion(params: unknown): string | undefined {
  const parsed = requestEnvelope.safeParse(params)

  return parsed.success ? parsed.data._meta?.[PROTOCOL_VERSION_META] : undefined
}

/** `params.name`, which the transport mirrors into `Mcp-Name`. */
export function readParamsName(params: unknown): string | undefined {
  const parsed = requestEnvelope.safeParse(params)

  return parsed.success ? parsed.data.name : undefined
}

export function isModernVersion(version: string): boolean {
  return MODERN_PROTOCOL_VERSIONS.includes(version)
}

export function isSupportedVersion(version: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version)
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

/** The `-32022` a client reads to pick a version it and Kelpie both speak. */
export function unsupportedVersion(id: JsonRpcId, requested: string): JsonRpcResponse {
  return failure(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
    supported: SUPPORTED_PROTOCOL_VERSIONS,
    requested,
  })
}

/**
 * The version to answer a legacy `initialize` with.
 *
 * A client asking for a legacy revision gets that one back, which is what lets a
 * `2025-03-26` client keep its batches. Anything else gets the newest legacy
 * revision, and the client decides whether it can live with it.
 */
export function negotiateLegacyVersion(requested: string): string {
  return LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_LEGACY_PROTOCOL_VERSION
}

/**
 * Dresses a payload as a finished result.
 *
 * Modern results carry `resultType` and identify the server in `_meta`; legacy
 * results carry neither, and adding them would put fields in front of a client
 * whose revision never defined them.
 */
function completeResult(
  dependencies: DispatchDependencies,
  era: ProtocolEra,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (era === 'legacy') {
    return payload
  }

  return {
    ...payload,
    resultType: 'complete',
    _meta: { [SERVER_INFO_META]: dependencies.serverInfo },
  }
}

/**
 * Renders what a tool threw as a tool result rather than a JSON-RPC error.
 *
 * MCP draws that line deliberately: a protocol error means the call never
 * happened, while a tool that ran and refused is an answer the model should see
 * and can act on. The body is the same `api.md` error shape the REST route would
 * have returned, so a 404 reads identically on both surfaces.
 */
function toolFailure(logger: Logger, toolName: string, error: unknown): Record<string, unknown> {
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
  era: ProtocolEra,
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

    return success(
      id,
      completeResult(dependencies, era, {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        isError: false,
      }),
    )
  } catch (error: unknown) {
    return success(
      id,
      completeResult(dependencies, era, toolFailure(dependencies.logger, tool.name, error)),
    )
  }
}

/**
 * Answers one message.
 *
 * @param era Which revision's rules to answer under. The transport decides it
 *   from how the request arrived, and every method here that exists in only one
 *   era is method-not-found in the other.
 * @returns The response, or undefined for a notification, which JSON-RPC forbids
 *   answering.
 */
export async function dispatch(
  dependencies: DispatchDependencies,
  message: JsonRpcMessage,
  era: ProtocolEra,
  actor: Actor,
): Promise<JsonRpcResponse | undefined> {
  const { id } = message

  if (id === undefined) {
    // Kelpie subscribes to no client notifications. `notifications/initialized`
    // and the cancellations are acknowledged by the transport's 202 and dropped.
    return undefined
  }

  switch (message.method) {
    /** Legacy only: the modern revision removed the handshake outright. */
    case 'initialize': {
      if (era === 'modern') {
        break
      }

      const parsed = initializeParams.safeParse(message.params)

      if (!parsed.success) {
        return failure(id, INVALID_PARAMS, 'initialize needs a "protocolVersion"')
      }

      return success(id, {
        protocolVersion: negotiateLegacyVersion(parsed.data.protocolVersion),
        // `listChanged: false`: the tool set is fixed at boot by the module list,
        // so there is never a change to notify.
        capabilities: { tools: { listChanged: false } },
        serverInfo: dependencies.serverInfo,
        instructions: dependencies.instructions,
      })
    }

    /**
     * Modern only, and mandatory there. It is the one request a client may send
     * before it knows anything about the server, so it names every revision this
     * deployment speaks — legacy ones included, which is how a dual-era client
     * discovers it can fall back.
     */
    case 'server/discover': {
      if (era === 'legacy') {
        break
      }

      return success(
        id,
        completeResult(dependencies, era, {
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: { tools: {} },
          instructions: dependencies.instructions,
          ...CACHE_HINTS,
        }),
      )
    }

    /** Legacy only: `2026-07-28` removed it. */
    case 'ping': {
      if (era === 'modern') {
        break
      }

      return success(id, {})
    }

    case 'tools/list':
      // No pagination: the whole set is known at boot and is a few hundred
      // kilobytes at most, so a cursor would only add a round trip. The order is
      // module registration order, which is fixed, so a client may cache it.
      return success(
        id,
        completeResult(dependencies, era, {
          tools: dependencies.published,
          ...(era === 'modern' ? CACHE_HINTS : {}),
        }),
      )

    case 'tools/call':
      return callTool(dependencies, era, id, message.params, actor)

    default:
      break
  }

  return failure(
    id,
    METHOD_NOT_FOUND,
    `Kelpie does not implement "${message.method}" under MCP ${era === 'modern' ? LATEST_PROTOCOL_VERSION : 'the initialize-based revisions'}`,
  )
}
