import { MAX_IMPORT_FILE_BYTES } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { acceptedRequestId } from './app.ts'
import { MAX_BODY_BYTES, MAX_PUBLIC_BODY_BYTES, maxBodyBytesFor } from './lib/bodyLimit.ts'
import { AppError } from './lib/errors.ts'
import type { DatabaseProbe } from './lib/database.ts'
import { createTestApp } from './testing/app.ts'
import type { TestApp } from './testing/app.ts'

function buildApp(probe: DatabaseProbe): Promise<TestApp> {
  return createTestApp({
    probeDatabase: () => Promise.resolve(probe),
    generateRequestId: () => 'req-fixed',
  })
}

describe('GET /healthz', () => {
  it('reports ok when the database answers', async () => {
    const { app } = await buildApp({ reachable: true })

    const response = await app.request('/healthz')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', database: 'up' })
  })

  it('reports 503 and logs the reason when the database does not answer', async () => {
    const { app, logLines } = await buildApp({ reachable: false, reason: 'ECONNREFUSED' })

    const response = await app.request('/healthz')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'degraded', database: 'down' })
    expect(logLines.join('\n')).toContain('ECONNREFUSED')
  })
})

describe('request ids', () => {
  it('echoes a generated id when the request has none', async () => {
    const { app } = await buildApp({ reachable: true })

    const response = await app.request('/healthz')

    expect(response.headers.get('X-Request-Id')).toBe('req-fixed')
  })

  it('keeps the caller id when one is supplied', async () => {
    const { app } = await buildApp({ reachable: true })

    const response = await app.request('/healthz', { headers: { 'X-Request-Id': 'req-from-caller' } })

    expect(response.headers.get('X-Request-Id')).toBe('req-from-caller')
  })

  it('keeps a caller id made of letters, digits, dots, underscores and hyphens, up to 128 characters', async () => {
    const { app } = await buildApp({ reachable: true })

    for (const id of ['0f8fad5b-d9cb-469f-a165-70867728950e', 'trace_01.span-7', 'a', 'x'.repeat(128)]) {
      const response = await app.request('/healthz', { headers: { 'X-Request-Id': id } })

      expect(response.headers.get('X-Request-Id')).toBe(id)
    }
  })

  it('replaces a caller id that is empty, too long or holds another character, and still answers', async () => {
    const { app, logLines } = await buildApp({ reachable: true })
    const refused = [
      '',
      'x'.repeat(129),
      'x'.repeat(10_000),
      'two words',
      'tab\there',
      'slash/id',
      'semi;colon',
      '<script>',
      'caf\u00e9',
    ]

    for (const id of refused) {
      const response = await app.request('/healthz', { headers: { 'X-Request-Id': id } })

      expect(response.status, JSON.stringify(id)).toBe(200)
      expect(response.headers.get('X-Request-Id'), JSON.stringify(id)).toBe('req-fixed')
    }

    // The id goes in every log line of the request, so the refused value must not.
    expect(logLines.join('\n')).not.toContain('two words')
    expect(logLines.join('\n')).not.toContain('<script>')
    expect(logLines.join('\n')).toContain('req-fixed')
  })
})

describe('acceptedRequestId', () => {
  it('answers the id when it is safe to log and to echo', () => {
    expect(acceptedRequestId('req-from-caller')).toBe('req-from-caller')
    expect(acceptedRequestId('A.b_c-9')).toBe('A.b_c-9')
    expect(acceptedRequestId('x'.repeat(128))).toBe('x'.repeat(128))
  })

  it('answers undefined for a missing id, and for one the service must not log or echo', () => {
    for (const id of [undefined, '', 'x'.repeat(129), 'two words', 'line\nbreak', 'line\rbreak', 'nul\u0000', 'caf\u00e9', 'id\n']) {
      expect(acceptedRequestId(id), JSON.stringify(id)).toBeUndefined()
    }
  })
})

describe('GET /v1/public/config', () => {
  it('reports the runtime mode and site name', async () => {
    const { app } = await createTestApp({ runtimeMode: 'development', siteName: 'dev' })

    const response = await app.request('/v1/public/config')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      runtime_mode: 'development',
      site_name: 'dev',
      signups_enabled: true,
      regions: [],
    })
  })

  it('defaults to production, a null site name, and open signups when nothing was passed', async () => {
    const { app } = await createTestApp()

    const response = await app.request('/v1/public/config')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      runtime_mode: 'production',
      site_name: null,
      signups_enabled: true,
      regions: [],
    })
  })

  it('reports signups as closed when the assembly closed them', async () => {
    const { app } = await createTestApp({ signupsEnabled: false })

    const response = await app.request('/v1/public/config')

    expect(await response.json()).toEqual({
      runtime_mode: 'production',
      site_name: null,
      signups_enabled: false,
      regions: [],
    })
  })

  it('reports the configured regions', async () => {
    const regions = [
      { id: 'us', label: 'United States', origin: 'https://us.kelpie.example' },
      { id: 'uk', label: 'United Kingdom', origin: 'https://uk.kelpie.example' },
    ]
    const { app } = await createTestApp({ regions })

    const response = await app.request('/v1/public/config')

    expect(await response.json()).toEqual({
      runtime_mode: 'production',
      site_name: null,
      signups_enabled: true,
      regions,
    })
  })
})

describe('errors', () => {
  it('renders unknown routes in the API error shape', async () => {
    const { app } = await buildApp({ reachable: true })

    const response = await app.request('/does-not-exist')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } })
  })

  it('renders a thrown AppError with its own status and code', async () => {
    const { app } = await buildApp({ reachable: true })
    app.get('/boom', () => {
      throw AppError.validationFailed('email is required', [
        { field: 'email', message: 'Missing required field' },
      ])
    })

    const response = await app.request('/boom')

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: {
        code: 'validation_failed',
        message: 'email is required',
        details: [{ field: 'email', message: 'Missing required field' }],
      },
    })
  })

  it('hides unexpected failures behind a 500 and logs the stack', async () => {
    const { app, logLines } = await buildApp({ reachable: true })
    app.get('/explode', () => {
      throw new Error('column "nope" does not exist')
    })

    const response = await app.request('/explode')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    })
    expect(logLines.join('\n')).toContain('column')
  })
})

describe('request body limit', () => {
  function post(app: TestApp['app'], path: string, bytes: number, declareLength: boolean): Promise<Response> {
    const body = 'x'.repeat(bytes)

    return Promise.resolve(
      app.request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(declareLength ? { 'Content-Length': String(bytes) } : {}),
        },
        body,
      }),
    )
  }

  it('answers 413 for a body over the limit, on the declared length alone', async () => {
    const { app } = await buildApp({ reachable: true })

    const response = await post(app, '/v1/auth/login', MAX_BODY_BYTES + 1, true)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: { code: 'payload_too_large', message: 'The request body may be at most 1 MB' },
    })
  })

  it('answers 413 for a body over the limit that does not declare its length', async () => {
    const { app } = await buildApp({ reachable: true })

    expect((await post(app, '/v1/people', MAX_BODY_BYTES + 1, false)).status).toBe(413)
  })

  it('gives a public route the smaller limit', async () => {
    const { app } = await buildApp({ reachable: true })

    const response = await post(app, '/v1/public/ws_1/forms/contact/submit', MAX_PUBLIC_BODY_BYTES + 1, true)

    expect(response.status).toBe(413)
  })

  it('gives the import upload, the import commit and /mcp room for a full file', () => {
    expect(maxBodyBytesFor('/v1/import/jobs', '/mcp')).toBeGreaterThan(MAX_IMPORT_FILE_BYTES)
    expect(maxBodyBytesFor('/v1/import/jobs/imp_1/commit', '/mcp')).toBeGreaterThan(MAX_IMPORT_FILE_BYTES)
    expect(maxBodyBytesFor('/mcp', '/mcp')).toBeGreaterThan(MAX_IMPORT_FILE_BYTES)
    expect(maxBodyBytesFor('/v1/import/jobs/imp_1', '/mcp')).toBe(MAX_BODY_BYTES)
    expect(maxBodyBytesFor('/v1/import/jobs/imp_1/commit/more', '/mcp')).toBe(MAX_BODY_BYTES)
    expect(maxBodyBytesFor('/v1/people', '/mcp')).toBe(MAX_BODY_BYTES)
    expect(maxBodyBytesFor('/v1/public/ws_1/forms/contact/submit', '/mcp')).toBe(MAX_PUBLIC_BODY_BYTES)
  })
})
