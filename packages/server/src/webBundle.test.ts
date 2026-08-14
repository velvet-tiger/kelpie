import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AppBindings } from './app.ts'
import { AppError } from './lib/errors.ts'
import type { KelpieModule } from './runtime/module.ts'
import { createTestApp } from './testing/app.ts'
import type { TestApp } from './testing/app.ts'
import { WebBundleError, serveWebBundle } from './webBundle.ts'

/**
 * The API exclusion and the single-page fallback, which are the two rules an
 * assembly would otherwise each get subtly wrong on its own.
 *
 * A real directory rather than a mocked filesystem: `serveStatic` stats and
 * streams from disk, so stubbing `node:fs` would assert against the stub.
 */

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'
const ASSET_JS = 'export const built = true\n'

let bundleDirectory: string

beforeAll(() => {
  bundleDirectory = mkdtempSync(join(tmpdir(), 'kelpie-bundle-'))
  mkdirSync(join(bundleDirectory, 'assets'))
  writeFileSync(join(bundleDirectory, 'index.html'), INDEX_HTML)
  writeFileSync(join(bundleDirectory, 'assets', 'main-a1b2c3.js'), ASSET_JS)
})

afterAll(() => {
  rmSync(bundleDirectory, { recursive: true, force: true })
})

async function appServingBundle(): Promise<TestApp> {
  const built = await createTestApp()

  serveWebBundle(built.app, { directory: bundleDirectory })

  return built
}

describe('serveWebBundle', () => {
  it('refuses a directory with no build in it', () => {
    const empty = mkdtempSync(join(tmpdir(), 'kelpie-empty-'))

    try {
      expect(() => serveWebBundle(new Hono<AppBindings>(), { directory: empty })).toThrow(WebBundleError)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('serves index.html at the root', async () => {
    const { app } = await appServingBundle()
    const response = await app.request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toBe(INDEX_HTML)
  })

  it('serves a built asset with its own content type', async () => {
    const { app } = await appServingBundle()
    const response = await app.request('/assets/main-a1b2c3.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('javascript')
    expect(await response.text()).toBe(ASSET_JS)
  })

  it('answers a deep link with the app shell, because the app routes on the address', async () => {
    const { app } = await appServingBundle()
    const response = await app.request('/people/per_01JABCDEF')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(INDEX_HTML)
  })

  /**
   * The regression this file exists for. A bare catch-all would answer an
   * unknown API path with the shell and a 200, so a client that misspelled an
   * endpoint would receive a web page instead of being told.
   */
  it('leaves an unknown API path as the JSON 404', async () => {
    const { app } = await appServingBundle()

    for (const path of ['/v1/typo', '/v1/public/typo', '/mcp/typo']) {
      const response = await app.request(path)

      expect(response.status, path).toBe(404)
      expect(response.headers.get('Content-Type'), path).toContain('application/json')
      expect(await response.json(), path).toMatchObject({ error: { code: 'not_found' } })
    }
  })

  /**
   * The same rule with modules registered, which is the shape a real assembly
   * runs in and the one `createTestApp()` with no modules cannot show.
   *
   * A toggleable module's router carries a `/v1/*` gate that resolves the caller
   * before any of its own routes run, so an unauthenticated request to an
   * unknown `/v1` path is answered `401` by the gate and never reaches routing
   * at all. That predates this file. What matters here is that it stays a JSON
   * error rather than becoming the app shell.
   */
  it('does not override what the API chain already answered for /v1', async () => {
    const gated: KelpieModule = {
      id: 'gated',
      async register(context) {
        context.routes((router) => {
          router.get('/gated/thing', (routeContext) => routeContext.json({ ok: true }))
        })

        await Promise.resolve()
      },
    }

    const built = await createTestApp({
      modules: [gated],
      resolveActor: () => Promise.reject(AppError.unauthorized()),
    })

    serveWebBundle(built.app, { directory: bundleDirectory })

    const response = await built.app.request('/v1/no-such-endpoint')

    expect(response.status).toBe(401)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  /**
   * The operator API base is excluded like `/v1`; the rest of `/operator` is
   * pages. A stranger probing the API base gets the guard's JSON 401, never
   * the shell, and the operator UI's own deep links still resolve.
   */
  it('leaves /operator/api to the API and /operator to the pages', async () => {
    const { app } = await appServingBundle()

    const api = await app.request('/operator/api/anything')
    expect(api.status).toBe(401)
    expect(api.headers.get('Content-Type')).toContain('application/json')

    const page = await app.request('/operator/workspaces')
    expect(page.status).toBe(200)
    expect(await page.text()).toBe(INDEX_HTML)
  })

  it('leaves /healthz to the API', async () => {
    const { app } = await appServingBundle()
    const response = await app.request('/healthz')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', database: 'up' })
  })

  /** A wrong endpoint, not a page request. Answering it with a document hides the mistake. */
  it('does not answer a write to an unknown path with the shell', async () => {
    const { app } = await appServingBundle()
    const response = await app.request('/people/per_01JABCDEF', { method: 'POST' })

    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type')).toContain('application/json')
  })

  it('answers a HEAD for a deep link without a body', async () => {
    const { app } = await appServingBundle()
    const response = await app.request('/people/per_01JABCDEF', { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })
})
