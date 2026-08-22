import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { AppError } from '../lib/errors.ts'
import { createLogger } from '../lib/logger.ts'
import { TEST_EMAIL_FROM, TEST_EMAIL_PROVIDER, createTestServices } from '../testing/services.ts'
import { createTestApp } from '../testing/app.ts'
import { workspaceKeyActor } from '../testing/fixtures.ts'
import type { EmailSender } from '../lib/email.ts'
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
      invoke: (input, actor) =>
        Promise.resolve({
          greeting: `${config.GREETING_WORD}, ${input.name}`,
          workspaceId: actor.workspaceId,
        }),
    })

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
  return createLogger({ level: 'error', transports: [] })
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

/**
 * A module declaring routes and middleware on the app itself, outside /v1.
 * Two modules on purpose: the property that matters most is one module's
 * pattern covering another module's routes, which no single-module test can
 * show.
 */
const consoleModule: KelpieModule = {
  id: 'console',
  register(context) {
    context.appMiddleware('/console/api/*', async (requestContext, next) => {
      if (requestContext.req.header('X-Console-Key') !== 'sesame') {
        throw AppError.unauthorized()
      }

      await next()
    })

    context.appRoute('GET', '/console/api/ping', (requestContext) => requestContext.json({ pong: true }))

    return Promise.resolve()
  },
}

const gadgetModule: KelpieModule = {
  id: 'gadget',
  register(context) {
    context.appRoute('GET', '/console/api/gadget', (requestContext) =>
      requestContext.json({ gadget: true }),
    )

    return Promise.resolve()
  },
}

describe('module app routes and middleware', () => {
  const consoleApp = (): ReturnType<typeof createTestApp> =>
    createTestApp({ modules: [consoleModule, gadgetModule] })

  it('serves a declared route at its full path', async () => {
    const { app } = await consoleApp()
    const response = await app.request('/console/api/ping', { headers: { 'X-Console-Key': 'sesame' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pong: true })
  })

  it('runs declared middleware ahead of the route', async () => {
    const { app } = await consoleApp()
    const response = await app.request('/console/api/ping')

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  /** What makes a declared pattern a surface: it covers later modules' routes too. */
  it("covers another module's route with the declaring module's middleware", async () => {
    const { app } = await consoleApp()

    expect((await app.request('/console/api/gadget')).status).toBe(401)

    const allowed = await app.request('/console/api/gadget', { headers: { 'X-Console-Key': 'sesame' } })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ gadget: true })
  })

  it('does not also serve the declared route under /v1', async () => {
    const { app } = await consoleApp()

    expect((await app.request('/v1/console/api/ping')).status).toBe(404)
  })

  it('collects the declarations with their modules', async () => {
    const { contributions } = await consoleApp()

    expect(contributions.appMiddleware.map((entry) => [entry.moduleId, entry.pattern])).toEqual([
      ['console', '/console/api/*'],
    ])
    expect(contributions.appRoutes.map((entry) => [entry.moduleId, entry.method, entry.path])).toEqual([
      ['console', 'GET', '/console/api/ping'],
      ['gadget', 'GET', '/console/api/gadget'],
    ])
  })

  it.each([
    ['/v1/console', 'under "/v1"'],
    ['/mcp/console', 'under "/mcp"'],
    ['/healthz', 'under "/healthz"'],
  ])('refuses the reserved path %s at boot', async (path, reason) => {
    const trespasser: KelpieModule = {
      id: 'trespasser',
      register(context) {
        context.appRoute('GET', path, (requestContext) => requestContext.json({}))
        return Promise.resolve()
      },
    }

    await expect(
      registerModules({
        modules: [trespasser],
        environment: {},
        logger: silentLogger(),
        services: createTestServices(),
        email: { provider: 'log', from: TEST_EMAIL_FROM },
      }),
    ).rejects.toThrow(new RegExp(`module "trespasser".*${reason}`))
  })

  it('refuses a middleware pattern with no leading slash at boot', async () => {
    const crooked: KelpieModule = {
      id: 'crooked',
      register(context) {
        context.appMiddleware('console/*', async (_requestContext, next) => next())
        return Promise.resolve()
      },
    }

    await expect(
      registerModules({
        modules: [crooked],
        environment: {},
        logger: silentLogger(),
        services: createTestServices(),
        email: { provider: 'log', from: TEST_EMAIL_FROM },
      }),
    ).rejects.toThrow(/module "crooked".*must start with "\/"/)
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
      registerModules({ modules: [greetingModule], environment: {}, logger: silentLogger(), services: createTestServices(), email: { provider: 'log', from: TEST_EMAIL_FROM } }),
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
  it('registers the tool, validates arguments, and hands it the caller', async () => {
    const { contributions } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
    })

    const tool = contributions.mcpTools[0]
    expect(tool?.name).toBe('greeting.say')

    expect(await tool?.invoke({ name: 'ada' }, workspaceKeyActor('ws_greeting'))).toEqual({
      greeting: 'Hello, ada',
      workspaceId: 'ws_greeting',
    })
  })

  it('rejects bad arguments with the same error a REST route would return', async () => {
    const { contributions } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
    })

    let thrown: unknown

    try {
      await contributions.mcpTools[0]?.invoke({ name: 42 }, workspaceKeyActor('ws_greeting'))
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
      registerModules({ modules: [doubleDeclaring], environment: {}, logger: silentLogger(), services: createTestServices(), email: { provider: 'log', from: TEST_EMAIL_FROM } }),
    ).rejects.toThrow(ModuleBootError)
  })
})

describe('module event subscriptions', () => {
  function envelope(name: string, target: { type: string; id: string }, data: unknown = {}) {
    return {
      id: `ev_${name}_${target.id}`,
      name,
      workspaceId: 'ws_1',
      actor: { kind: 'system' as const },
      occurredAt: '2026-08-21T00:00:00.000Z',
      target,
      data,
    }
  }

  it('delivers an event to a module that subscribed during registration', async () => {
    const received: string[] = []
    const listening: KelpieModule = {
      id: 'listener',
      register(context) {
        context.events.subscribe('workspace.workspace.created' as never, (event) => {
          received.push(event.target.id)
        })

        return Promise.resolve()
      },
    }

    const { contributions } = await createTestApp({ modules: [listening] })
    await contributions.events.publish(
      envelope('workspace.workspace.created', { type: 'workspace', id: 'ws_acme' }) as never,
    )

    expect(received).toEqual(['ws_acme'])
  })

  it('lets two modules subscribe to the same event without shadowing each other', async () => {
    const received: string[] = []
    const subscriber = (id: string): KelpieModule => ({
      id,
      register(context) {
        context.events.subscribe('workspace.member.joined' as never, (event) => {
          received.push(`${id}:${event.target.id}`)
        })

        return Promise.resolve()
      },
    })

    const { contributions } = await createTestApp({
      modules: [subscriber('audit'), subscriber('billing')],
    })
    await contributions.events.publish(
      envelope('workspace.member.joined', { type: 'member', id: 'mem_1' }, {
        userId: 'usr_1',
      }) as never,
    )

    expect(received.toSorted()).toEqual(['audit:mem_1', 'billing:mem_1'])
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
      await registerModules({ modules: [broken], environment: {}, logger: silentLogger(), services: createTestServices(), email: { provider: 'log', from: TEST_EMAIL_FROM } })
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

  describe('email provider registry', () => {
    it("resolves the 'log' provider from the runtime without any module", async () => {
      // 'log' is always registered, so a bare install with no provider module
      // still boots. This proves it: no modules, no additionalEmailProviders,
      // just email.provider = 'log'.
      await registerModules({
        modules: [],
        environment: {},
        logger: silentLogger(),
        services: createTestServices(),
        email: { provider: 'log', from: TEST_EMAIL_FROM },
      })
    })

    it('routes sends through the module registered under the picked name', async () => {
      const services = createTestServices()
      const providerSent: string[] = []
      let capturedProxy: EmailSender | undefined

      const consumer: KelpieModule = {
        id: 'consumer',
        register(context) {
          capturedProxy = context.email
          return Promise.resolve()
        },
      }

      const smtpLikeProvider: KelpieModule = {
        id: 'smtp-like',
        register(context) {
          context.provideEmailSender('smtp', () => ({
            send(message) {
              providerSent.push(message.to)
              return Promise.resolve()
            },
          }))
          return Promise.resolve()
        },
      }

      await registerModules({
        modules: [consumer, smtpLikeProvider],
        environment: {},
        logger: silentLogger(),
        services,
        email: { provider: 'smtp', from: TEST_EMAIL_FROM },
      })

      await capturedProxy?.send({ to: 'a@example.com', subject: 's', body: 'b' })

      // The proxy captured before the provider ran now delegates to the
      // provider the config picked, not the log fallback.
      expect(providerSent).toEqual(['a@example.com'])
      expect(services.sentEmails).toHaveLength(0)
    })

    it('lets several provider modules register different names side by side', async () => {
      let smtpBuilt = 0
      let resendBuilt = 0

      // Both modules register at once and boot succeeds. Only the chosen
      // provider's factory runs: the unpicked one never asks for its env.
      await registerModules({
        modules: [
          {
            id: 'smtp-mod',
            register(context) {
              context.provideEmailSender('smtp', () => {
                smtpBuilt += 1
                return { send: () => Promise.resolve() }
              })
              return Promise.resolve()
            },
          },
          {
            id: 'resend-mod',
            register(context) {
              context.provideEmailSender('resend', () => {
                resendBuilt += 1
                return { send: () => Promise.resolve() }
              })
              return Promise.resolve()
            },
          },
        ],
        environment: {},
        logger: silentLogger(),
        services: createTestServices(),
        email: { provider: 'resend', from: TEST_EMAIL_FROM },
      })

      expect(resendBuilt).toBe(1)
      expect(smtpBuilt).toBe(0)
    })

    it('fails boot when two modules register the same name', async () => {
      const first: KelpieModule = {
        id: 'first',
        register(context) {
          context.provideEmailSender('smtp', () => ({ send: () => Promise.resolve() }))
          return Promise.resolve()
        },
      }
      const second: KelpieModule = {
        id: 'second',
        requires: ['first'],
        register(context) {
          context.provideEmailSender('smtp', () => ({ send: () => Promise.resolve() }))
          return Promise.resolve()
        },
      }

      await expect(
        registerModules({
          modules: [first, second],
          environment: {},
          logger: silentLogger(),
          services: createTestServices(),
          email: { provider: 'smtp', from: TEST_EMAIL_FROM },
        }),
      ).rejects.toThrow(/module "second" registers email provider "smtp", but module "first" already did/)
    })

    it("refuses a module that tries to shadow the built-in 'log' provider", async () => {
      const impostor: KelpieModule = {
        id: 'impostor',
        register(context) {
          context.provideEmailSender('log', () => ({ send: () => Promise.resolve() }))
          return Promise.resolve()
        },
      }

      await expect(
        registerModules({
          modules: [impostor],
          environment: {},
          logger: silentLogger(),
          services: createTestServices(),
          email: { provider: 'log', from: TEST_EMAIL_FROM },
        }),
      ).rejects.toThrow(/module "impostor" registers email provider "log", which is reserved by the runtime/)
    })

    it('fails boot when email.provider names something nothing registered', async () => {
      await expect(
        registerModules({
          modules: [],
          environment: {},
          logger: silentLogger(),
          services: createTestServices(),
          email: { provider: 'postmark', from: TEST_EMAIL_FROM },
        }),
      ).rejects.toThrow(/email.provider is "postmark", which no module registered. Available: log/)
    })

    it('wraps a chosen provider factory that throws with the module id', async () => {
      const broken: KelpieModule = {
        id: 'broken',
        register(context) {
          context.provideEmailSender('resend', () => {
            throw new Error('RESEND_API_KEY is required')
          })
          return Promise.resolve()
        },
      }

      await expect(
        registerModules({
          modules: [broken],
          environment: {},
          logger: silentLogger(),
          services: createTestServices(),
          email: { provider: 'resend', from: TEST_EMAIL_FROM },
        }),
      ).rejects.toThrow(/email provider "resend" \(broken\) failed to build: Error: RESEND_API_KEY is required/)
    })

    it('seeds a test provider through additionalEmailProviders', async () => {
      // The path createTestApp uses: give registerModules a preseeded sender
      // under a name, then point email.provider at it. `services.sentEmails`
      // sees every send that reaches through the proxy.
      const services = createTestServices()
      let capturedProxy: EmailSender | undefined

      await registerModules({
        modules: [
          {
            id: 'capturing',
            register(context) {
              capturedProxy = context.email
              return Promise.resolve()
            },
          },
        ],
        environment: {},
        logger: silentLogger(),
        services,
        email: { provider: TEST_EMAIL_PROVIDER, from: TEST_EMAIL_FROM },
        additionalEmailProviders: new Map([[TEST_EMAIL_PROVIDER, services.emailSender]]),
      })

      await capturedProxy?.send({ to: 'a@example.com', subject: 's', body: 'b' })

      expect(services.sentEmails).toHaveLength(1)
      expect(services.sentEmails[0]).toMatchObject({ to: 'a@example.com' })
    })
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

    await registerModules({ modules: [counting], environment: {}, logger: silentLogger(), services: createTestServices(), email: { provider: 'log', from: TEST_EMAIL_FROM } })

    expect(registrations).toBe(1)
  })
})

describe('module toggling', () => {
  const structuralModule: KelpieModule = {
    id: 'structural-thing',
    structural: true,
    register(context) {
      context.routes((router) => {
        router.get('/structural-thing', (requestContext) => requestContext.json({ ok: true }))
      })

      return Promise.resolve()
    },
  }

  it('declares a module.<id> capability for a non-structural module', async () => {
    const { contributions } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
    })

    expect(contributions.entitlements.capabilities().map((capability) => capability.name)).toContain(
      'module.greeting',
    )
  })

  it('declares no capability for a structural module, so it can never be locked', async () => {
    const { contributions } = await createTestApp({ modules: [structuralModule] })

    expect(contributions.entitlements.capabilities().map((capability) => capability.name)).not.toContain(
      'module.structural-thing',
    )
  })

  it('rejects a REST request for a module a deploy-time config file disabled', async () => {
    const { app } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
      moduleConfig: { greeting: false },
      resolveActor: () => Promise.resolve(workspaceKeyActor('ws_1')),
    })

    const response = await app.request('/v1/greetings/ada')

    expect(response.status).toBe(403)
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'entitlement_required' },
    })
  })

  it('allows a REST request for a module with no override', async () => {
    const { app } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
      resolveActor: () => Promise.resolve(workspaceKeyActor('ws_1')),
    })

    expect((await app.request('/v1/greetings/ada')).status).toBe(200)
  })

  it('never gates a structural module route, even when resolveActor is supplied', async () => {
    const { app } = await createTestApp({
      modules: [structuralModule],
      resolveActor: () => Promise.reject(new Error('a structural route must not resolve an actor')),
    })

    expect((await app.request('/v1/structural-thing')).status).toBe(200)
  })

  it('rejects an MCP tool call for a module a deploy-time config file disabled', async () => {
    const { contributions } = await createTestApp({
      modules: [greetingModule],
      environment: { GREETING_WORD: 'Hello' },
      moduleConfig: { greeting: false },
    })

    let thrown: unknown

    try {
      await contributions.mcpTools[0]?.invoke({ name: 'ada' }, workspaceKeyActor('ws_1'))
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AppError)
    if (!(thrown instanceof AppError)) {
      throw thrown
    }

    expect(thrown.code).toBe('entitlement_required')
  })

  it('fails boot when a module config names an id outside the module list', async () => {
    await expect(
      registerModules({
        modules: [greetingModule],
        environment: { GREETING_WORD: 'Hello' },
        logger: silentLogger(),
        services: createTestServices(),
        email: { provider: 'log', from: TEST_EMAIL_FROM },
        moduleConfig: { nonexistent: false },
      }),
    ).rejects.toThrow(/module config names "nonexistent", which is not in the module list/)
  })

  it('fails boot when a module config names a structural module', async () => {
    await expect(
      registerModules({
        modules: [structuralModule],
        environment: {},
        logger: silentLogger(),
        services: createTestServices(),
        email: { provider: 'log', from: TEST_EMAIL_FROM },
        moduleConfig: { 'structural-thing': false },
      }),
    ).rejects.toThrow(/module config names "structural-thing", which is structural and cannot be disabled/)
  })
})

describe('an assembly with no modules', () => {
  it('still serves the app with empty contributions', async () => {
    const { app, contributions } = await createTestApp()

    expect(contributions.routers).toEqual([])
    expect(contributions.publicRouters).toEqual([])
    expect(contributions.schemas).toEqual([])
    expect(contributions.mcpTools).toEqual([])
    expect((await app.request('/healthz')).status).toBe(200)
  })
})
