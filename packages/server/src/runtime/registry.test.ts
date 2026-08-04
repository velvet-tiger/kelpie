import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { AppError } from '../lib/errors.ts'
import { createLogger } from '../lib/logger.ts'
import { createTestServices } from '../testing/services.ts'
import { createTestApp } from '../testing/app.ts'
import type { KelpieModule } from './module.ts'
import { ModuleBootError } from './order.ts'
import { registerModules } from './registry.ts'

/**
 * The module under test contributes one of each kind of thing a module can
 * contribute, so the assertions below cover the whole `ModuleContext` surface.
 */
const greetingSchema = z.object({ GREETING_WORD: z.string().min(1) })

const greetingModule: KelpieModule = {
  id: 'greeting',
  async register(context) {
    const config = context.config(greetingSchema)

    context.routes((router) => {
      router.get('/greetings/:name', (requestContext) =>
        requestContext.json({ greeting: `${config.GREETING_WORD}, ${requestContext.req.param('name')}` }),
      )
    })

    context.schema({ greetings: 'greetings-table' }, '/modules/greeting/migrations')

    context.mcp.tool({
      name: 'greeting.say',
      description: 'Returns a greeting for a name.',
      inputSchema: z.object({ name: z.string() }),
      invoke: (input) => Promise.resolve({ greeting: `${config.GREETING_WORD}, ${input.name}` }),
    })

    context.webhookEvents(['greeting.said'])

    return Promise.resolve()
  },
}

/**
 * A module contributing one endpoint of each kind.
 *
 * Both on the same module on purpose: what decides whether an endpoint is public
 * is which method registered it, not which module it came from. Whether a
 * credentialled endpoint answers 401 is the route's own business and is asserted
 * against real auth in the forms suite.
 */
const doorwayModule: KelpieModule = {
  id: 'doorway',
  register(context) {
    context.routes((router) => {
      router.get('/doorway/inside', (requestContext) => requestContext.json({ inside: true }))
    })

    context.publicRoutes((router) => {
      router.get('/doorway/open', (requestContext) => requestContext.json({ open: true }))
    })

    return Promise.resolve()
  },
}

function silentLogger(): ReturnType<typeof createLogger> {
  return createLogger('error', () => undefined)
}

describe('module routes', () => {
  it('serves a module route under /v1 through the assembled app', async () => {
    const { app } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
    })

    const response = await app.request('/v1/greetings/ada')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ greeting: 'Hello, ada' })
  })

  it('leaves unmatched paths under /v1 as 404 in the api.md shape', async () => {
    const { app } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
    })

    const response = await app.request('/v1/nothing-here')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } })
  })
})

describe('module public routes', () => {
  const openApp = (): ReturnType<typeof createTestApp> => createTestApp({ modules: [doorwayModule] })

  it('serves a public route under /v1/public', async () => {
    const { app } = await openApp()
    const response = await app.request('/v1/public/doorway/open')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ open: true })
  })

  /** One prefix answers "is this endpoint public?", so a public route is only there. */
  it('does not also serve the public route under /v1', async () => {
    const { app } = await openApp()

    expect((await app.request('/v1/doorway/open')).status).toBe(404)
  })

  it('leaves the module credentialled route where it was', async () => {
    const { app } = await openApp()
    const response = await app.request('/v1/doorway/inside')

    expect(response.status).toBe(200)
    expect((await app.request('/v1/public/doorway/inside')).status).toBe(404)
  })

  it('answers a CORS preflight on a public route', async () => {
    const { app } = await openApp()
    const response = await app.request('/v1/public/doorway/open', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  /**
   * No `Allow-Credentials` on the public prefix, so a browser never attaches a
   * reader's session cookie to a cross-origin call, and nothing under `/v1` is
   * reachable cross-origin at all.
   */
  it('opens up nothing beyond the public prefix', async () => {
    const { app } = await openApp()
    const open = await app.request('/v1/public/doorway/open', {
      headers: { Origin: 'https://example.com' },
    })
    const inside = await app.request('/v1/doorway/inside', {
      headers: { Origin: 'https://example.com' },
    })

    expect(open.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    expect(inside.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('collects public routers apart from the rest', async () => {
    const { contributions } = await openApp()

    expect(contributions.publicRouters.map((entry) => entry.moduleId)).toEqual(['doorway'])
    expect(contributions.routers.map((entry) => entry.moduleId)).toEqual(['doorway'])
  })
})

describe('module config', () => {
  it('gives the module its validated slice of the environment', async () => {
    const { app } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Gday', UNRELATED: 'ignored' },
    })

    expect(await (await app.request('/v1/greetings/grace')).json()).toEqual({ greeting: 'Gday, grace' })
  })

  it('fails boot naming the module when its config is invalid', async () => {
    await expect(
      registerModules({ modules: [greetingModule], environment: {}, logger: silentLogger(), services: createTestServices() }),
    ).rejects.toThrow(/module "greeting" config GREETING_WORD/)
  })
})

describe('module schema contributions', () => {
  it('collects tables and the migrations directory against the module id', async () => {
    const { contributions } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
    })

    expect(contributions.schemas).toEqual([
      {
        moduleId: 'greeting',
        tables: { greetings: 'greetings-table' },
        migrationsDir: '/modules/greeting/migrations',
      },
    ])
  })
})

describe('module MCP tools', () => {
  it('registers the tool and validates arguments before invoking it', async () => {
    const { contributions } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
    })

    const tool = contributions.mcpTools[0]
    expect(tool?.name).toBe('greeting.say')

    expect(await tool?.invoke({ name: 'ada' })).toEqual({ greeting: 'Hello, ada' })
  })

  it('rejects bad arguments with the same error a REST route would return', async () => {
    const { contributions } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
    })

    let thrown: unknown

    try {
      await contributions.mcpTools[0]?.invoke({ name: 42 })
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AppError)
    if (!(thrown instanceof AppError)) {
      throw thrown
    }

    expect(thrown.code).toBe('validation_failed')
    expect(thrown.status).toBe(422)
    expect(thrown.details).toEqual([{ field: 'name', message: 'Invalid input: expected string, received number' }])
  })

  it('rejects two tools with the same name', async () => {
    const doubleDeclaring: KelpieModule = {
      id: 'double',
      register(context) {
        const definition = {
          name: 'thing.do',
          description: 'Does the thing.',
          inputSchema: z.object({}),
          invoke: () => Promise.resolve(null),
        }
        context.mcp.tool(definition)
        context.mcp.tool(definition)

        return Promise.resolve()
      },
    }

    await expect(
      registerModules({ modules: [doubleDeclaring], environment: {}, logger: silentLogger(), services: createTestServices() }),
    ).rejects.toThrow(ModuleBootError)
  })
})

describe('module event subscriptions', () => {
  it('delivers an event to a module that subscribed during registration', async () => {
    const received: string[] = []
    const listening: KelpieModule = {
      id: 'listener',
      register(context) {
        context.events.subscribe('workspace.created', async (payload) => {
          received.push(payload.slug)
        })

        return Promise.resolve()
      },
    }

    const { contributions } = await createTestApp({ modules: [listening] })
    await contributions.events.publish('workspace.created', { workspaceId: 'ws_1', slug: 'acme' })

    expect(received).toEqual(['acme'])
  })

  it('lets two modules subscribe to the same event without shadowing each other', async () => {
    const received: string[] = []
    const subscriber = (id: string): KelpieModule => ({
      id,
      register(context) {
        context.events.subscribe('member.joined', async (payload) => {
          received.push(`${id}:${payload.memberId}`)
        })

        return Promise.resolve()
      },
    })

    const { contributions } = await createTestApp({ modules: [subscriber('audit'), subscriber('billing')] })
    await contributions.events.publish('member.joined', {
      workspaceId: 'ws_1',
      memberId: 'mem_1',
      userId: 'usr_1',
    })

    expect(received.toSorted()).toEqual(['audit:mem_1', 'billing:mem_1'])
  })
})

describe('module webhook events', () => {
  it('collects declared names and drops duplicates', async () => {
    const alsoSaying: KelpieModule = {
      id: 'echo',
      register(context) {
        context.webhookEvents(['greeting.said', 'echo.repeated'])

        return Promise.resolve()
      },
    }

    const { contributions } = await createTestApp({
      modules: [greetingModule, alsoSaying],
      environment: { GREETING_WORD: 'Hello' },
    })

    expect(contributions.webhookEvents).toEqual(['greeting.said', 'echo.repeated'])
  })
})

describe('registration failures', () => {
  it('wraps a module that throws, naming it and keeping the cause', async () => {
    const broken: KelpieModule = {
      id: 'broken',
      register() {
        return Promise.reject(new Error('upstream unavailable'))
      },
    }

    let thrown: unknown

    try {
      await registerModules({ modules: [broken], environment: {}, logger: silentLogger(), services: createTestServices() })
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ModuleBootError)
    if (!(thrown instanceof ModuleBootError)) {
      throw thrown
    }

    expect(thrown.problems[0]).toContain('module "broken" failed to register')
    expect(thrown.problems[0]).toContain('upstream unavailable')
    expect(thrown.cause).toBeInstanceOf(Error)
  })

  it('registers each module exactly once', async () => {
    let registrations = 0
    const counting: KelpieModule = {
      id: 'counting',
      register() {
        registrations += 1

        return Promise.resolve()
      },
    }

    await registerModules({ modules: [counting], environment: {}, logger: silentLogger(), services: createTestServices() })

    expect(registrations).toBe(1)
  })
})

describe('an assembly with no modules', () => {
  it('still serves the app with empty contributions', async () => {
    const { app, contributions } = await createTestApp()

    expect(contributions.routers).toEqual([])
    expect(contributions.publicRouters).toEqual([])
    expect(contributions.schemas).toEqual([])
    expect(contributions.mcpTools).toEqual([])
    expect(contributions.webhookEvents).toEqual([])
    expect((await app.request('/healthz')).status).toBe(200)
  })
})
