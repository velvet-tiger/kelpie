import type { Context, MiddlewareHandler } from 'hono'

import { readBearerToken } from '../modules/api-keys/keys.ts'

import { isImportFilePath } from './bodyLimit.ts'
import { AppError } from './errors.ts'
import { PUBLIC_ROUTE_PREFIX, requestOrigin } from './http.ts'

/**
 * Refuses a request that another website made a browser send.
 *
 * The session cookie is `SameSite=Lax`, which stops a page on another site. It
 * does not stop a page on a sibling subdomain, which is the same site, and it
 * does nothing for a request that needs no session at all: a forged login signs
 * the reader in to the attacker's account. So a request that changes something
 * and carries no bearer credential has two more rules to pass.
 *
 * **The origin is this deployment's own.** A browser states where a request
 * came from in `Origin`, and in `Sec-Fetch-Site` when it sends no `Origin`. A
 * client that is not a browser sends neither, and is allowed: it has no ambient
 * cookie for anybody to borrow.
 *
 * **A body is JSON.** A page can send `text/plain`, a form encoding, or a body
 * with no type to another origin without asking first. It cannot send
 * `application/json` that way: the browser asks with a preflight, and `/v1`
 * answers no preflight. The two import routes that take the file are the only
 * multipart ones.
 *
 * A request with a bearer credential is left alone. The server never falls back
 * from a bearer credential to the cookie (`resolveActor`), and a page cannot
 * make a browser attach an `Authorization` header to another origin.
 */

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** `none` is a request the reader started: a typed address, a bookmark. */
const SAME_ORIGIN_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none'])

/**
 * The origins a page of this deployment can have.
 *
 * The first is the origin the request arrived on. The second is the same host
 * on `https`. A proxy that ends TLS and does not forward the scheme makes an
 * `https` page arrive as plain `http`, and to refuse that would stop every
 * write from the browser app. To accept it is safe: nobody else can get a page
 * on `https` at this host. The other direction stays refused, because an `http`
 * page at the host of an `https` deployment is one a network attacker can make.
 */
function isOwnOrigin(context: Context): boolean {
  const origin = context.req.header('Origin')

  if (origin !== undefined) {
    const own = requestOrigin(context)

    return origin === own || origin === own.replace(/^http:/u, 'https:')
  }

  const fetchSite = context.req.header('Sec-Fetch-Site')

  return fetchSite === undefined || SAME_ORIGIN_FETCH_SITES.has(fetchSite.trim().toLowerCase())
}

/** The media type alone, without parameters such as `charset`. */
function mediaTypeOf(context: Context): string | undefined {
  return context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase()
}

/**
 * True when the headers say a body follows. Every HTTP/1.1 request with a body
 * carries one of these two headers.
 */
function declaresBody(context: Context): boolean {
  const length = context.req.header('Content-Length')

  if (length !== undefined) {
    return length.trim() !== '0'
  }

  return context.req.header('Transfer-Encoding') !== undefined
}

function isAllowedMediaType(context: Context): boolean {
  const mediaType = mediaTypeOf(context)

  if (mediaType === undefined) {
    return !declaresBody(context)
  }

  if (mediaType === 'application/json') {
    return true
  }

  return mediaType === 'multipart/form-data' && isImportFilePath(context.req.path)
}

/**
 * The guard for `/v1/*`. Exported so that a module with cookie-authenticated
 * routes outside `/v1` can put the same check in front of them.
 *
 * @throws AppError 403 for another origin, 415 for a body that is not JSON.
 */
export function createCrossSiteGuardMiddleware(): MiddlewareHandler {
  return async (context, next) => {
    const exempt =
      SAFE_METHODS.has(context.req.method) ||
      context.req.path.startsWith(`${PUBLIC_ROUTE_PREFIX}/`) ||
      readBearerToken(context.req.header('Authorization')) !== undefined

    if (!exempt) {
      if (!isOwnOrigin(context)) {
        throw new AppError('forbidden', 'This endpoint does not answer requests from another origin')
      }

      if (!isAllowedMediaType(context)) {
        throw new AppError('unsupported_media_type', 'Send the body as application/json')
      }
    }

    await next()
  }
}
