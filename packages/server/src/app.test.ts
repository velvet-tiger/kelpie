import { describe, expect, it } from 'vitest'

import { createApp } from './app.ts'
import type { AppDependencies } from './app.ts'
import type { DatabaseProbe } from './lib/database.ts'
import { AppError } from './lib/errors.ts'
import { createLogger } from './lib/logger.ts'

interface TestHarness {
  readonly app: ReturnType<typeof createApp>
  readonly logLines: string[]
}

function buildApp(probe: DatabaseProbe, overrides: Partial<AppDependencies> = {}): TestHarness {
  const logLines: string[] = []
  const app = createApp({
    logger: createLogger('debug', (line) => logLines.push(line)),
    probeDatabase: () => Promise.resolve(probe),
    generateRequestId: () => 'req-fixed',
    ...overrides,
  })

  return { app, logLines }
}

describe('GET /healthz', () => {
  it('reports ok when the database answers', async () => {
    const { app } = buildApp({ reachable: true })

    const response = await app.request('/healthz')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', database: 'up' })
  })

  it('reports 503 and logs the reason when the database does not answer', async () => {
    const { app, logLines } = buildApp({ reachable: false, reason: 'ECONNREFUSED' })

    const response = await app.request('/healthz')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'degraded', database: 'down' })
    expect(logLines.join('\n')).toContain('ECONNREFUSED')
  })
})

describe('request ids', () => {
  it('echoes a generated id when the request has none', async () => {
    const { app } = buildApp({ reachable: true })

    const response = await app.request('/healthz')

    expect(response.headers.get('X-Request-Id')).toBe('req-fixed')
  })

  it('keeps the caller id when one is supplied', async () => {
    const { app } = buildApp({ reachable: true })

    const response = await app.request('/healthz', { headers: { 'X-Request-Id': 'req-from-caller' } })

    expect(response.headers.get('X-Request-Id')).toBe('req-from-caller')
  })
})

describe('errors', () => {
  it('renders unknown routes in the api.md error shape', async () => {
    const { app } = buildApp({ reachable: true })

    const response = await app.request('/does-not-exist')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } })
  })

  it('renders a thrown AppError with its own status and code', async () => {
    const { app } = buildApp({ reachable: true })
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
    const { app, logLines } = buildApp({ reachable: true })
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
