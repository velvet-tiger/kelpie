import { Hono } from 'hono'
import type { Context } from 'hono'

import type { Actor } from '../../lib/actor.ts'
import { AppError } from '../../lib/errors.ts'
import type { Logger } from '../../lib/logger.ts'
import type { McpTool } from '../../runtime/module.ts'
import { readBearerToken } from '../api-keys/keys.ts'
import { resolveActor, resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import {
  INVALID_REQUEST,
  PARSE_ERROR,
  SUPPORTED_PROTOCOL_VERSIONS,
  dispatch,
  failure,
  parseMessage,
  publishTool,
} from './protocol.ts'
import type {
  DispatchDependencies,
  JsonRpcResponse,
  McpServerInfo,
  PublishedTool,
} from './protocol.ts'

/**
 * The Streamable HTTP transport, mounted at `/mcp` (`architecture.md` boot step 6).
 *
 * Kelpie never initiates a message, so the transport is one `POST` and nothing
 * else: `GET` would open a server-to-client stream there is nothing to put on,
 * and `DELETE` would end a session that is never started. Both answer `405`,
 * which the transport spec allows and which tells a client to stop trying.
 *
 * **No session id, and no CORS.** Every request carries its own bearer key, so
 * two POSTs need nothing in common and any instance can answer either. Because
 * the endpoint sends no CORS headers and reads no cookie, a page on another
 * origin can neither read a reply nor borrow a signed-in reader's identity, which
 * is what the transport's DNS-rebinding warning is about.
 */

const PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version'

/** Answered by GET and DELETE, so a client learns the shape of the endpoint. */
const POST_ONLY = 'Send MCP messages as a POST to this endpoint'

export interface McpRouterDependencies extends CredentialDependencies {
  readonly tools: readonly McpTool[]
  readonly serverInfo: McpServerInfo
  readonly instructions: string
  readonly logger: Logger
}

/** True when the client will take a plain JSON reply. */
function acceptsJson(header: string | undefined): boolean {
  if (header === undefined || header.trim().length === 0) {
    return true
  }

  return header
    .split(',')
    .some((value) => {
      const type = value.split(';')[0]?.trim() ?? ''

      return type === 'application/json' || type === 'application/*' || type === '*/*'
    })
}

function acceptsEventStream(header: string | undefined): boolean {
  return (header ?? '')
    .split(',')
    .some((value) => (value.split(';')[0]?.trim() ?? '') === 'text/event-stream')
}

/**
 * Resolves the caller, bearer key only.
 *
 * A session cookie is deliberately not read here even though the REST surface
 * takes one. MCP clients are not browsers, and refusing the cookie is what makes
 * the missing CORS configuration a complete answer to cross-origin abuse rather
 * than a partial one.
 *
 * @throws AppError 401 when no key is presented, or it is not a live one.
 */
function resolveKeyActor(dependencies: McpRouterDependencies, context: Context): Promise<Actor> {
  return resolveActor(dependencies, { bearer: readBearerToken(context.req.header('Authorization')) })
}

/**
 * Refuses a header naming a revision Kelpie does not speak.
 *
 * Absent is fine: the transport spec has a server assume `2025-03-26` for a
 * client that omits it, and Kelpie answers that revision.
 *
 * @throws AppError 400 for an unsupported value.
 */
function checkProtocolVersion(context: Context): void {
  const requested = context.req.header(PROTOCOL_VERSION_HEADER)

  if (requested !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    throw new AppError(
      'bad_request',
      `Kelpie speaks MCP ${SUPPORTED_PROTOCOL_VERSIONS.join(' and ')}, not ${requested}`,
    )
  }
}

/**
 * Renders responses in whichever of the two content types the client will take.
 *
 * A `2025-03-26` client may send a batch, so the payload is an array when the
 * request was one, and a bare object otherwise.
 */
function renderResponses(
  context: Context,
  responses: readonly JsonRpcResponse[],
  batched: boolean,
): Response {
  // Nothing to answer: every message in the body was a notification. The spec
  // fixes this on 202, and the body must be empty.
  if (responses.length === 0) {
    return context.body(null, 202)
  }

  const payload: unknown = batched ? responses : responses[0]
  const accept = context.req.header('Accept')

  if (acceptsJson(accept)) {
    return context.json(payload)
  }

  if (acceptsEventStream(accept)) {
    return context.body(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, 200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
    })
  }

  throw new AppError('bad_request', 'Accept application/json or text/event-stream')
}

export interface McpEndpoint {
  /** Mounts at `/mcp`. Speaks JSON-RPC to MCP clients. */
  readonly transport: Hono
  /**
   * Mounts under `/v1`. One ordinary REST read of the same tool listing, for a
   * caller holding a session rather than a key: the admin page showing what this
   * deployment exposes, or anyone checking the surface without an MCP client.
   */
  readonly catalog: Hono
}

/** The `tools/list` entry, rendered in `api.md`'s `snake_case`. */
function catalogEntry(tool: PublishedTool): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema }
}

export function createMcpEndpoint(dependencies: McpRouterDependencies): McpEndpoint {
  const transport = new Hono()
  const catalog = new Hono()
  // Built once: a schema Zod cannot render as JSON Schema then fails boot, rather
  // than producing a tool listing no client can read.
  const published = dependencies.tools.map(publishTool)
  const dispatchDependencies: DispatchDependencies = {
    tools: dependencies.tools,
    published,
    serverInfo: dependencies.serverInfo,
    instructions: dependencies.instructions,
    logger: dependencies.logger,
  }

  catalog.get('/mcp/tools', async (context) => {
    // Credentials as anywhere under `/v1`, so a signed-in reader qualifies. The
    // listing describes the deployment rather than the workspace, but it is not
    // public: what an install exposes is not a stranger's business.
    await resolveActorFrom(dependencies, context)

    return context.json({ data: published.map(catalogEntry), next_cursor: null })
  })

  transport.post('/', async (context) => {
    checkProtocolVersion(context)

    const actor = await resolveKeyActor(dependencies, context).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'unauthorized') {
        // The header is what tells a client it may retry with a credential
        // rather than that the endpoint is gone.
        context.header('WWW-Authenticate', 'Bearer')
      }

      throw error
    })

    const raw: unknown = await context.req.json().catch(() => {
      throw new AppError('bad_request', 'Body must be valid JSON')
    })
    const batched = Array.isArray(raw)
    const incoming: readonly unknown[] = batched ? raw : [raw]

    if (incoming.length === 0) {
      return context.json(failure(null, INVALID_REQUEST, 'A batch must hold at least one message'), 400)
    }

    const responses: JsonRpcResponse[] = []

    for (const value of incoming) {
      const message = parseMessage(value)

      if (message === undefined) {
        responses.push(failure(null, PARSE_ERROR, 'Not a JSON-RPC 2.0 message'))
        continue
      }

      const response = await dispatch(dispatchDependencies, message, actor)

      if (response !== undefined) {
        responses.push(response)
      }
    }

    return renderResponses(context, responses, batched)
  })

  transport.get('/', () => {
    throw new AppError('method_not_allowed', POST_ONLY)
  })

  transport.delete('/', () => {
    throw new AppError('method_not_allowed', POST_ONLY)
  })

  return { transport, catalog }
}
