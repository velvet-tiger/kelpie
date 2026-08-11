import { secureHeaders } from 'hono/secure-headers'
import type { MiddlewareHandler } from 'hono'

/**
 * `api.md`'s security headers, in two layers.
 *
 * `hono/secure-headers` (bundled with `hono` already; no new dependency)
 * covers `Strict-Transport-Security`, `X-Content-Type-Options` and
 * `Referrer-Policy`. Every other header it can add is turned off explicitly
 * rather than left at the library's default, so a future `hono` upgrade
 * cannot silently change what this API sends. `Cross-Origin-Resource-Policy`
 * in particular would break the very cross-origin iframe embedding
 * `forms/embed.ts` exists for, on any customer page that opts into
 * `Cross-Origin-Embedder-Policy` itself.
 *
 * `X-Frame-Options` cannot go through the library the same way: a mount's
 * value is fixed once, not computed per request, and the embed page is the
 * one response in this service that must not send it (`embed.ts:229`). The
 * wrapper below adds it everywhere else, driven by the one signal that tells
 * the embed page apart from every other route: it is the only handler that
 * sets its own `Content-Security-Policy`.
 */
const baseHeaders = secureHeaders({
  strictTransportSecurity: true,
  xContentTypeOptions: true,
  referrerPolicy: true,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  xDnsPrefetchControl: false,
  xDownloadOptions: false,
  xFrameOptions: false,
  xPermittedCrossDomainPolicies: false,
  xXssProtection: false,
})

export const securityHeadersMiddleware: MiddlewareHandler = async (context, next) => {
  await baseHeaders(context, next)

  if (context.res.headers.get('Content-Security-Policy') === null) {
    context.header('X-Frame-Options', 'DENY')
  }
}
