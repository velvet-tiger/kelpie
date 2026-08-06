import { Hono } from 'hono'
import type { Context } from 'hono'

import type { Actor } from '../../lib/actor.ts'
import { AppError } from '../../lib/errors.ts'
import { requestOrigin } from '../../lib/http.ts'
import type { Logger } from '../../lib/logger.ts'
import type { McpTool } from '../../runtime/module.ts'
import { readBearerToken } from '../api-keys/keys.ts'
import { resolveActor, resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import {
  HEADER_MISMATCH,
  INVALID_REQUEST,
  LATEST_LEGACY_PROTOCOL_VERSION,
  LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  PROTOCOL_VERSION_META,
  dispatch,
  failure,
  isModernVersion,
  isSupportedVersion,
  parseMessage,
  publishTool,
  readMetaVersion,
  readParamsName,
  unsupportedVersion,
} from './protocol.ts'
import type {
  DispatchDependencies,
  JsonRpcMessage,
  JsonRpcResponse,
  McpServerInfo,
  ProtocolEra,
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
 * **No session id.** Every request carries its own bearer key, so two POSTs need
 * nothing in common and any instance can answer either.
 *
 * **Two eras, decided per POST.** `2026-07-28` removed the handshake, so a modern
 * client announces its revision in every request instead. `readEra` works out
 * which one is being asked for and, for a modern request, checks that the headers
 * the transport mirrors agree with the body before anything acts on either. A
 * batch can only have come from a legacy client, so the first message decides for
 * all of them.
 *
 * **No CORS, and an explicit `Origin` check.** The endpoint sends no CORS headers
 * and reads no cookie, so a page on another origin can neither read a reply nor
 * borrow a signed-in reader's identity. That reasoning is why the check below
 * looked unnecessary and it is still why the risk is small, but the transport
 * spec makes validating `Origin` a requirement rather than an argument, and a
 * rule that holds without depending on a chain of reasoning is worth five lines.
 */

/**
 * The body fields the transport mirrors into headers, so an intermediary can
 * route on them without parsing the body. Names compare case-insensitively,
 * which is what Hono's header lookup already does; values do not.
 */
const PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version'
const METHOD_HEADER = 'Mcp-Method'
const NAME_HEADER = 'Mcp-Name'

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
 * takes one. MCP clients are not browsers, and refusing the cookie means there is
 * no ambient credential for a cross-origin page to spend. That is one of three
 * defences, not the whole of it: `checkOrigin` refuses the page outright, and the
 * absent CORS headers stop it reading a reply.
 *
 * @throws AppError 401 when no key is presented, or it is not a live one.
 */
function resolveKeyActor(dependencies: McpRouterDependencies, context: Context): Promise<Actor> {
  return resolveActor(dependencies, { bearer: readBearerToken(context.req.header('Authorization')) })
}

/**
 * Refuses a browser calling from somewhere else.
 *
 * An MCP client is not a browser and sends no `Origin` at all, so an absent
 * header is the ordinary case and is allowed. A present one has to be this
 * deployment's own, which is the same `Host`-derived origin a form's embed URL
 * is built from.
 *
 * There is no allowlist and no configuration for one. A cross-origin browser has
 * no business here whatever its address: the endpoint takes a bearer key, and a
 * page that holds one can send it from a server instead.
 *
 * @throws AppError 403 for a browser on another origin.
 */
function checkOrigin(context: Context): void {
  const origin = context.req.header('Origin')

  if (origin !== undefined && origin !== requestOrigin(context)) {
    throw new AppError('forbidden', 'This endpoint does not answer requests from another origin')
  }
}

/**
 * Undoes the sentinel a client wraps a header value in when it will not survive
 * as plain ASCII: `=?base64?…?=`.
 *
 * A value that is not wrapped is returned as it arrived. The markers are
 * case-sensitive and must be exactly these, so a value that merely looks similar
 * is left alone — and a client with a real value shaped like the sentinel is
 * required to encode it for exactly that reason.
 */
const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/u

function decodeHeaderValue(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined
  }

  const encoded = BASE64_SENTINEL.exec(raw)

  return encoded === null ? raw : Buffer.from(encoded[1] ?? '', 'base64').toString('utf8')
}

/** Either which revision's rules to answer under, or the refusal to send instead. */
type EraDecision =
  | { readonly kind: 'era'; readonly era: ProtocolEra }
  | { readonly kind: 'refuse'; readonly response: JsonRpcResponse }

/**
 * Names the header and body values that disagree, or nothing when they agree.
 *
 * The point of mirroring body fields into headers is that an intermediary can
 * route on them without parsing the body. That only holds if the two cannot
 * differ, so the server that does parse the body is the one that has to check —
 * otherwise a load balancer and the server act on different values.
 */
function headerProblem(context: Context, message: JsonRpcMessage): string | undefined {
  const headerVersion = context.req.header(PROTOCOL_VERSION_HEADER)
  const bodyVersion = readMetaVersion(message.params)

  if (headerVersion === undefined) {
    return `${PROTOCOL_VERSION_HEADER} is required`
  }

  if (headerVersion !== bodyVersion) {
    return `${PROTOCOL_VERSION_HEADER} is "${headerVersion}" and ${PROTOCOL_VERSION_META} is ${bodyVersion === undefined ? 'absent' : `"${bodyVersion}"`}`
  }

  const methodHeader = context.req.header(METHOD_HEADER)

  if (methodHeader === undefined) {
    return `${METHOD_HEADER} is required`
  }

  if (methodHeader !== message.method) {
    return `${METHOD_HEADER} is "${methodHeader}" and the body's method is "${message.method}"`
  }

  // `Mcp-Name` mirrors `params.name`, which only these methods carry. Of the
  // three the spec names, `tools/call` is the only one Kelpie implements.
  if (message.method !== 'tools/call') {
    return undefined
  }

  const nameHeader = decodeHeaderValue(context.req.header(NAME_HEADER))
  const bodyName = readParamsName(message.params)

  if (nameHeader === undefined) {
    return `${NAME_HEADER} is required on tools/call`
  }

  if (nameHeader !== bodyName) {
    return `${NAME_HEADER} is "${nameHeader}" and the body names ${bodyName === undefined ? 'no tool' : `"${bodyName}"`}`
  }

  return undefined
}

/**
 * Works out which revision a request is asking for.
 *
 * A modern request says so in its `_meta`, and `server/discover` is a modern
 * method whatever else it carries. Everything else is legacy, including a request
 * that names no version at all: the transport spec has a server read that as
 * `2025-03-26`, from before the header existed.
 *
 * A version Kelpie does not speak is refused with `-32022` carrying the list it
 * does, which is what lets a client pick another and retry. `initialize` is the
 * exception, because negotiating down is what that handshake is for.
 */
function readEra(context: Context, message: JsonRpcMessage): EraDecision {
  const id = message.id ?? null
  const claimed = readMetaVersion(message.params) ?? context.req.header(PROTOCOL_VERSION_HEADER)

  if (claimed !== undefined && !isSupportedVersion(claimed) && message.method !== 'initialize') {
    return { kind: 'refuse', response: unsupportedVersion(id, claimed) }
  }

  const modern =
    message.method === 'server/discover' || (claimed !== undefined && isModernVersion(claimed))

  if (!modern) {
    return { kind: 'era', era: 'legacy' }
  }

  const problem = headerProblem(context, message)

  return problem === undefined
    ? { kind: 'era', era: 'modern' }
    : { kind: 'refuse', response: failure(id, HEADER_MISMATCH, `Header mismatch: ${problem}`) }
}

/**
 * The status a set of responses is sent with.
 *
 * `200` almost always: a JSON-RPC error is a normal HTTP response. The exception
 * is a modern method-not-found, which the transport spec puts on `404` so a
 * client can tell a modern server that lacks the method from a legacy server that
 * does not host the endpoint at all. Legacy revisions never said that, so they
 * keep the `200`.
 */
function statusFor(responses: readonly JsonRpcResponse[], era: ProtocolEra): 200 | 404 {
  if (era === 'legacy' || responses.length !== 1) {
    return 200
  }

  return responses[0]?.error?.code === METHOD_NOT_FOUND ? 404 : 200
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
  era: ProtocolEra,
): Response {
  // Nothing to answer: every message in the body was a notification. The spec
  // fixes this on 202, and the body must be empty.
  if (responses.length === 0) {
    return context.body(null, 202)
  }

  const payload: unknown = batched ? responses : responses[0]
  const accept = context.req.header('Accept')
  const status = statusFor(responses, era)

  if (acceptsJson(accept)) {
    return context.json(payload, status)
  }

  if (acceptsEventStream(accept)) {
    return context.body(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, status, {
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
    checkOrigin(context)

    // Credentials before anything protocol-level, including `server/discover`.
    // A client may call that one before it knows anything about the server, but
    // it always has the key already: it is in the same config as the URL.
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

    const parsed = incoming.map(parseMessage)
    // The era belongs to the POST, not to each message in it: a modern request
    // is one message, and a batch can only have come from a legacy client.
    const first = parsed.find((message) => message !== undefined)

    if (first === undefined) {
      return context.json(failure(null, PARSE_ERROR, 'Not a JSON-RPC 2.0 message'), 400)
    }

    const decision = readEra(context, first)

    if (decision.kind === 'refuse') {
      return context.json(decision.response, 400)
    }

    const { era } = decision

    if (era === 'modern' && batched) {
      return context.json(
        failure(
          first.id ?? null,
          INVALID_REQUEST,
          `MCP ${LATEST_PROTOCOL_VERSION} takes one message per request; batches ended with ${LATEST_LEGACY_PROTOCOL_VERSION}`,
        ),
        400,
      )
    }

    const responses: JsonRpcResponse[] = []

    for (const message of parsed) {
      if (message === undefined) {
        responses.push(failure(null, PARSE_ERROR, 'Not a JSON-RPC 2.0 message'))
        continue
      }

      const response = await dispatch(dispatchDependencies, message, era, actor)

      if (response !== undefined) {
        responses.push(response)
      }
    }

    return renderResponses(context, responses, batched, era)
  })

  transport.get('/', () => {
    throw new AppError('method_not_allowed', POST_ONLY)
  })

  transport.delete('/', () => {
    throw new AppError('method_not_allowed', POST_ONLY)
  })

  return { transport, catalog }
}
