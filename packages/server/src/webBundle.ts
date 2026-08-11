import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono, MiddlewareHandler } from 'hono'

import type { AppBindings } from './app.ts'
import { MCP_ROUTE_PREFIX } from './modules/mcp/index.ts'

/**
 * Serves a built web bundle from the same origin as the API.
 *
 * `createApp` answers data and nothing else. In development the Vite dev server
 * builds the pages and proxies `/v1` through to the API, so one address serves
 * both. That proxy is doing two jobs: rebuilding on edit, which is development
 * only, and putting the pages and the API on one origin, which is permanent.
 * Nothing did the second job in production, so a deployed assembly answered API
 * calls and served no pages at all.
 *
 * An assembly opts in by calling this after `createApp`, which is where the
 * three assemblies (`apps/kelpie`, a scaffolded project, and `kelpie-cloud`)
 * would otherwise each grow their own copy of the fallback rule below.
 */

export interface WebBundleOptions {
  /** Directory holding the built `index.html` and its assets. */
  readonly directory: string
}

/** The bundle directory does not hold a build. Thrown at boot, never per request. */
export class WebBundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebBundleError'
  }
}

/**
 * The prefixes `createApp` answers on.
 *
 * `/v1/public` needs no entry of its own: it sits under `/v1`. `MCP_ROUTE_PREFIX`
 * is imported rather than written out, so moving the endpoint moves this with it.
 */
const API_PREFIXES: readonly string[] = ['/v1', MCP_ROUTE_PREFIX, '/healthz']

function isApiRequest(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/**
 * Restricts a handler to requests for the web app.
 *
 * The API exclusion is the point of the whole file. `app.notFound` renders
 * `api.md`'s JSON 404, and it only fires when no route matched, so a bare
 * catch-all registered after `createApp` would answer `GET /v1/typo` with the
 * app shell and a 200. A client asking for data would get a web page and no
 * indication it had misspelled anything.
 *
 * Methods are filtered for the same reason: `POST /v1/typo` is a wrong endpoint,
 * not a page request, and only a `GET` or a `HEAD` can sensibly be answered with
 * a document.
 */
function webRequestsOnly(handler: MiddlewareHandler): MiddlewareHandler {
  return async (context, next) => {
    const isDocumentRequest = context.req.method === 'GET' || context.req.method === 'HEAD'

    if (!isDocumentRequest || isApiRequest(context.req.path)) {
      return next()
    }

    return handler(context, next)
  }
}

/**
 * Mounts the bundle on an app built by `createApp`.
 *
 * Call it after `createApp` and before serving. Hono composes a request's
 * handlers in registration order and stops at the first one that answers, so
 * mounting last leaves every API route matching ahead of these two.
 *
 * @throws WebBundleError if the directory holds no `index.html`. A deployment
 *   whose build did not run should stop at boot rather than serve an API with
 *   invisible pages, which is the failure this function exists to remove.
 */
export function serveWebBundle(app: Hono<AppBindings>, options: WebBundleOptions): void {
  const directory = resolve(options.directory)
  const indexHtml = join(directory, 'index.html')

  if (!existsSync(indexHtml)) {
    throw new WebBundleError(
      `No index.html in ${directory}. Point WEB_BUNDLE_DIR at a built web bundle, or run the web build first.`,
    )
  }

  // Two registrations rather than one: `serveStatic` calls `next()` when it
  // finds no file, which is exactly the signal the fallback needs. A request
  // for a real asset is answered by the first and never reaches the second.
  app.use('*', webRequestsOnly(serveStatic({ root: directory })))

  // The single-page fallback. The app decides what to draw from the address, so
  // a deep link to `/people/per_01J…` has to return the same `index.html` even
  // though no file sits at that path.
  //
  // A missing asset gets the shell too, which is what every static SPA server
  // does by default. Narrowing this by `Accept` would turn a stale asset
  // reference into a clean 404, and would also turn `curl /people/per_01J…`
  // into one, so it is left alone.
  app.use('*', webRequestsOnly(serveStatic({ path: indexHtml })))
}
