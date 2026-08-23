import { describe, expect, it } from 'vitest'

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
})

describe('GET /v1/public/config', () => {
  it('reports the runtime mode and site name', async () => {
    const { app } = await createTestApp({ runtimeMode: 'development', siteName: 'dev' })

    const response = await app.request('/v1/public/config')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ runtime_mode: 'development', site_name: 'dev' })
  })

  it('defaults to production and a null site name when nothing was passed', async () => {
    const { app } = await createTestApp()

    const response = await app.request('/v1/public/config')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ runtime_mode: 'production', site_name: null })
  })
})

describe('errors', () => {
  it('renders unknown routes in the api.md error shape', async () => {
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
