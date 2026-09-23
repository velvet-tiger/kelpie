import { Hono } from 'hono'
import type { Context, Handler, MiddlewareHandler } from 'hono'

import type { Actor } from '../lib/actor.ts'
import { requireWorkspaceId } from '../lib/actor.ts'
import type { Environment } from '../lib/config.ts'
import { createLogEmailSender } from '../lib/email.ts'
import type { EmailMessage, EmailSender } from '../lib/email.ts'
import { AppError, describeThrown, describeValidationIssue, toErrorDetails } from '../lib/errors.ts'
import type { JobRegistry } from '../lib/jobs.ts'
import type { Logger } from '../lib/logger.ts'
import { createEntitlementRegistry, requireCapability } from './entitlements.ts'
import type { EntitlementRegistry } from './entitlements.ts'
import { createEventBus } from './events.ts'
import type { EventBus } from './events.ts'
import type {
  CompletedSignIn,
  ExternalSignInHandler,
  KelpieModule,
  McpTool,
  ModuleCatalogEntry,
  ModuleContext,
  ModuleServices,
  SchemaContribution,
  VerifiedIdentity,
} from './module.ts'
import { createModuleConfigProvider, moduleCapabilityName, validateModuleConfig } from './moduleConfig.ts'
import { ModuleBootError, orderModules } from './order.ts'

/**
 * Everything the modules contributed during the registration pass. The app mounts
 * the routers; the migration pipeline and the MCP endpoint consume the rest as
 * those land.
 */
export interface ModuleContributions {
  readonly routers: readonly ModuleRouter[]
  /** Routers for `/v1/public`: no credentials, CORS open. */
  readonly publicRouters: readonly ModuleRouter[]
  /** Middleware declared on the app itself. Applied before every `appRoutes` entry. */
  readonly appMiddleware: readonly AppMiddlewareContribution[]
  /** Routes declared at full paths on the app itself, outside `/v1`. */
  readonly appRoutes: readonly AppRouteContribution[]
  readonly schemas: readonly SchemaContribution[]
  readonly mcpTools: readonly McpTool[]
  /** The bus every module subscribed to. Services publish through it after commit. */
  readonly events: EventBus
  /** Everything the modules declared, and any provider they registered. */
  readonly entitlements: EntitlementRegistry
}

export interface ModuleRouter {
  readonly moduleId: string
  readonly router: Hono
}

export interface AppRouteContribution {
  readonly moduleId: string
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly handler: Handler
}

export interface AppMiddlewareContribution {
  readonly moduleId: string
  readonly pattern: string
  readonly handler: MiddlewareHandler
}

/**
 * Paths `appRoute`/`appMiddleware` may not touch. `/v1` because `routes` with
 * its gates is the only way there, the rest because they are core's own
 * surfaces. `/mcp` mirrors `MCP_ROUTE_PREFIX`, written out because `runtime/`
 * must not import a feature module.
 */
const RESERVED_APP_PATHS: readonly string[] = ['/v1', '/mcp', '/healthz']

function assertMountablePath(moduleId: string, kind: string, path: string): void {
  if (!path.startsWith('/')) {
    throw new ModuleBootError([`module "${moduleId}" declares ${kind} "${path}", which must start with "/"`])
  }

  for (const reserved of RESERVED_APP_PATHS) {
    if (path === reserved || path.startsWith(`${reserved}/`)) {
      throw new ModuleBootError([
        `module "${moduleId}" declares ${kind} "${path}" under "${reserved}", which is core's surface`,
      ])
    }
  }
}

/** Verb methods a module can call on the router — full Hono set. */
const ROUTER_VERB_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'all'] as const
type RouterVerbMethod = (typeof ROUTER_VERB_METHODS)[number]

function isRouterVerbMethod(name: string): name is RouterVerbMethod {
  return (ROUTER_VERB_METHODS as readonly string[]).includes(name)
}

/**
 * Wraps a Hono router so every route the module registers runs `gate` first,
 * and only that module's own routes. The straightforward alternative —
 * `router.use('*', gate)` — attaches at `/v1/*` on the app once the router is
 * mounted (Hono flattens sub-routers onto the parent prefix), so the gate
 * fires for every module's routes, not just this module's. Prepending the gate
 * to each declared route keeps the check local.
 *
 * The full router surface is covered so a future contributor cannot silently
 * reintroduce the leak by reaching for a method that was not wrapped:
 *
 * - HTTP verbs and `on`: prepend `gate`, then the module's handlers.
 * - `use(pattern, ...)` at a specific path: prepend `gate`, then the mw.
 * - `route(subPath, subApp)`: recursively wrap `subApp` before mounting, so
 *   every route it contributes still runs the gate first.
 *
 * And the calls that cannot be made module-local through wrapping fail at
 * boot with a message naming the module, rather than shipping a subtle leak:
 *
 * - `use()` with no path, `use('*')`, `use('/*')`, `use('/')`: any of these
 *   register a middleware at `/v1/*` on the parent app once the router is
 *   mounted — the exact bug this wrapper prevents. A module that wants to
 *   share middleware across many of its routes must name a specific path
 *   (`/things/*`) or attach the middleware per route.
 * - `notFound` / `onError`: fire for every unmatched or failing `/v1`
 *   request once the router is flattened, so a module's handler would run
 *   for other modules' traffic. Handle failures inside the module's own
 *   route handlers instead.
 */
function gateRouter(router: Hono, moduleId: string, gate: MiddlewareHandler): Hono {
  const proxy: Hono = new Proxy(router, {
    get(target, property, receiver) {
      if (typeof property !== 'string') {
        return Reflect.get(target, property, receiver)
      }

      if (isRouterVerbMethod(property)) {
        return (path: string, ...handlers: Handler[]): Hono => {
          const method = target[property] as (path: string, ...handlers: Handler[]) => Hono
          method.call(target, path, gate, ...handlers)
          return proxy
        }
      }

      if (property === 'on') {
        return (
          method: string | string[],
          path: string | string[],
          ...handlers: Handler[]
        ): Hono => {
          target.on(method as never, path as never, gate, ...handlers)
          return proxy
        }
      }

      if (property === 'use') {
        return (...args: unknown[]): Hono => {
          const first = args[0]
          const isAppWide =
            typeof first !== 'string' || first === '*' || first === '/*' || first === '/'

          if (isAppWide) {
            throw new ModuleBootError([
              `module "${moduleId}" called router.use() with an app-wide pattern (${
                typeof first === 'string' ? `"${first}"` : 'no path'
              }). Hono flattens the module router onto "/v1", so this would fire for every module's routes. Name a specific path ("/things/*") or attach middleware per route.`,
            ])
          }

          const [pattern, ...handlers] = args as [string, ...MiddlewareHandler[]]
          target.use(pattern, gate, ...handlers)
          return proxy
        }
      }

      if (property === 'route') {
        return (path: string, subApp: Hono): Hono => {
          // The sub-app's routes were registered on it before this call, so a
          // proxy over `subApp` cannot retroactively prepend the gate to them.
          // Instead attach the gate as middleware scoped to the sub-router's
          // mount prefix on this router — once flattened onto `/v1`, the
          // middleware covers exactly `/v1${path}/*`, which is the module's
          // own routes. `use` must land before `route` so composition order
          // runs the gate first.
          target.use(`${path.replace(/\/+$/, '')}/*`, gate)
          target.route(path, subApp)
          return proxy
        }
      }

      if (property === 'notFound' || property === 'onError') {
        throw new ModuleBootError([
          `module "${moduleId}" called router.${property}(). A module router's ${property} fires for every unmatched or failing "/v1" request once the router is mounted; handle failures inside the module's own route handlers instead.`,
        ])
      }

      return Reflect.get(target, property, receiver)
    },
  }) as Hono

  return proxy
}

/**
 * What `registerModules` needs.
 *
 * Every optional field spells out `| undefined`, which is not noise. Under
 * `exactOptionalPropertyTypes` an omitted key and a key holding `undefined` are
 * different types, and an assembly building these options has the second:
 * `readModuleConfigFile` returns `undefined` when no override file is
 * configured. Without it, core hands a caller a value its own runtime refuses.
 * None of the four fields tells the two cases apart.
 */
export interface ModuleRuntimeOptions {
  readonly modules: readonly KelpieModule[]
  /** Raw variables. Each module validates the slice it needs via `context.config`. */
  readonly environment: Environment
  readonly logger: Logger
  /** Injected so a test can watch what core modules subscribe to. Defaults to a fresh bus. */
  readonly events?: EventBus | undefined
  /** Injected so a test can grant or deny before core modules register. */
  readonly entitlements?: EntitlementRegistry | undefined
  /** The database, transaction scope, and collaborators every module builds on. */
  readonly services: ModuleServices
  /**
   * Picks the transactional-mail provider. `provider` is a name a module
   * registered via `context.provideEmailSender(name, sender)`. `'log'` is a
   * built-in the runtime always registers using its own logger and `from`, so
   * a bare install boots without a provider module.
   *
   * `from` is the address on every outgoing message. The log provider uses it
   * verbatim; other providers may read the same value through their own
   * `context.config` if they need to.
   */
  readonly email: {
    readonly provider: string
    readonly from: string
  }
  /**
   * Extra named providers seeded into the registry before any module runs.
   * Modules still register through `context.provideEmailSender`; these are for
   * tests that want to inspect what was sent without building a whole module.
   * A name collision with a module (or with `'log'`) fails boot exactly as if
   * two modules had registered it.
   */
  readonly additionalEmailProviders?: ReadonlyMap<string, EmailSender> | undefined
  /**
   * The job registry modules bind to at register time. Bound to the pg-boss
   * runtime in production (`runtime/jobs.ts`) and to a stub in unit tests
   * that never define a job. A module that calls `context.jobs.define` when
   * this is absent gets a boot-time error naming the module.
   */
  readonly jobs?: JobRegistry | undefined
  /**
   * The deploy-time module override (`lib/moduleConfig.ts`), parsed. A locked
   * module id wins over whatever a workspace's own settings say.
   */
  readonly moduleConfig?: Readonly<Record<string, boolean>> | undefined
  /**
   * Resolves the caller of a REST request, the same way every route already
   * does (`modules/auth/credentials.ts`), so a non-structural module's router
   * can be gated by `module.<id>` before any of its own routes run.
   *
   * Optional, and not part of `ModuleServices`: `runtime/` must not import a
   * feature module, so this arrives as a function rather than a dependency on
   * auth directly. Omitted, REST gating is skipped entirely, which is what
   * every test that does not exercise module toggling wants without having to
   * say so.
   */
  readonly resolveActor?: ((context: Context) => Promise<Actor>) | undefined
}

/** Contributions accumulate here, one mutable set per registration pass. */
interface Accumulator {
  readonly routers: ModuleRouter[]
  readonly publicRouters: ModuleRouter[]
  readonly appMiddleware: AppMiddlewareContribution[]
  readonly appRoutes: AppRouteContribution[]
  readonly schemas: SchemaContribution[]
  readonly mcpTools: McpTool[]
}

/**
 * The email sender every module writes through. `target` is set once, after
 * all modules have registered, from the provider `email.provider` picked. Until
 * then a `.send()` throws: consumer modules capture the proxy at register time
 * but only reach it at request time, so this is unreachable in normal flow.
 */
class EmailSenderProxy implements EmailSender {
  private target: EmailSender | undefined = undefined

  setTarget(sender: EmailSender): void {
    this.target = sender
  }

  send(message: EmailMessage): Promise<void> {
    if (this.target === undefined) {
      return Promise.reject(
        new Error('email sender used before boot resolved a provider. Set email.provider in kelpie.config.ts.'),
      )
    }

    return this.target.send(message)
  }
}

/**
 * Completes a sign-in for an identity a module verified elsewhere.
 *
 * Same shape as `EmailSenderProxy`, and for the same reason: one module owns
 * the implementation, every module reaches it through this object, and a
 * consumer captures the proxy at register time but only calls it at request
 * time, so registration order does not matter.
 *
 * Exactly one installer, unlike email's named registry: there is one `users`
 * table and one session cookie, so "which implementation" is never a question
 * an assembly should have to answer.
 */
class ExternalSignInProxy {
  private target: ExternalSignInHandler | undefined = undefined
  private installedBy: string | undefined = undefined

  install(moduleId: string, handler: ExternalSignInHandler): void {
    if (this.installedBy !== undefined) {
      throw new ModuleBootError([
        `module "${moduleId}" provides external sign-in, but module "${this.installedBy}" already did`,
      ])
    }

    this.target = handler
    this.installedBy = moduleId
  }

  complete(context: Context, identity: VerifiedIdentity): Promise<CompletedSignIn> {
    if (this.target === undefined) {
      return Promise.reject(
        new Error(
          'external sign-in used before a module installed it. Is the auth module in the assembly?',
        ),
      )
    }

    return this.target(context, identity)
  }
}

/**
 * The name the runtime uses for its built-in log sender. Reserved: a module
 * that tries to register under this name fails boot.
 */
const LOG_PROVIDER_NAME = 'log'

/**
 * Records which module registered a given provider name, so a collision error
 * can name both parties. `build` is invoked once, only for the chosen provider.
 */
interface RegisteredProvider {
  readonly build: () => EmailSender
  readonly registeredBy: string
}

/**
 * Refuses `define` for a module that reached `context.jobs` when the runtime
 * booted without a jobs registry. Named so a boot log points at the module
 * whose declaration cannot be honoured, rather than a bare stack trace.
 */
function createMissingJobsRegistry(moduleId: string): JobRegistry {
  return {
    define() {
      throw new ModuleBootError([
        `module "${moduleId}" defines a job but the assembly booted without a jobs runtime`,
      ])
    },
  }
}

function createModuleContext(
  module: KelpieModule,
  accumulator: Accumulator,
  options: ModuleRuntimeOptions,
  events: EventBus,
  entitlements: EntitlementRegistry,
  moduleCatalog: readonly ModuleCatalogEntry[],
  emailProxy: EmailSenderProxy,
  providers: Map<string, RegisteredProvider>,
  externalSignIn: ExternalSignInProxy,
): ModuleContext {
  return {
    ...options.services,
    email: emailProxy,
    jobs: options.jobs ?? createMissingJobsRegistry(module.id),

    provideExternalSignIn(handler) {
      externalSignIn.install(module.id, handler)
    },

    completeExternalSignIn(context, identity) {
      return externalSignIn.complete(context, identity)
    },

    provideEmailSender(name, build) {
      if (name === LOG_PROVIDER_NAME) {
        throw new ModuleBootError([
          `module "${module.id}" registers email provider "${name}", which is reserved by the runtime`,
        ])
      }

      const existing = providers.get(name)

      if (existing !== undefined) {
        throw new ModuleBootError([
          `module "${module.id}" registers email provider "${name}", but module "${existing.registeredBy}" already did`,
        ])
      }

      providers.set(name, { build, registeredBy: module.id })
    },

    routes(mount) {
      const router = new Hono()

      // Gate must run before anything `mount` adds. A `router.use('*', gate)`
      // here would attach at `/v1/*` on the app after mounting (Hono flattens
      // the sub-router onto the parent prefix), which would fire the gate for
      // every module's routes, not just this one's. So the gate is prepended
      // to each individual route through `gateRouter` instead.
      if (module.structural !== true && options.resolveActor !== undefined) {
        const { resolveActor } = options
        const gate: MiddlewareHandler = async (context, next) => {
          const actor = await resolveActor(context)

          await requireCapability(entitlements, requireWorkspaceId(actor), moduleCapabilityName(module.id))
          await next()
        }

        mount(gateRouter(router, module.id, gate))
      } else {
        mount(router)
      }

      accumulator.routers.push({ moduleId: module.id, router })
    },

    publicRoutes(mount) {
      const router = new Hono()
      mount(router)
      accumulator.publicRouters.push({ moduleId: module.id, router })
    },

    // No gate on either, unlike `routes`: a surface declared here owns its
    // own access rules, and a per-module `module.<id>` check would hand
    // workspaces a switch over deployment tooling they do not own.
    appRoute(method, path, handler) {
      assertMountablePath(module.id, 'app route', path)
      accumulator.appRoutes.push({ moduleId: module.id, method, path, handler })
    },

    appMiddleware(pattern, handler) {
      assertMountablePath(module.id, 'app middleware', pattern)
      accumulator.appMiddleware.push({ moduleId: module.id, pattern, handler })
    },

    schema(tables, migrationsDir) {
      accumulator.schemas.push({ moduleId: module.id, tables, migrationsDir })
    },

    mcp: {
      tool(definition) {
        if (accumulator.mcpTools.some((existing) => existing.name === definition.name)) {
          throw new ModuleBootError([`module "${module.id}" declares MCP tool "${definition.name}" twice`])
        }

        accumulator.mcpTools.push({
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
          // Parsing here is what keeps MCP and REST from drifting: both surfaces
          // validate with the module's schema and fail with the same API error.
          invoke: async (rawInput, actor) => {
            const parsed = definition.inputSchema.safeParse(rawInput)

            if (!parsed.success) {
              throw AppError.validationFailed(
                `Invalid arguments for tool "${definition.name}"`,
                toErrorDetails(parsed.error.issues),
              )
            }

            // The MCP endpoint already resolved `actor` once, from the bearer
            // key, before dispatch reached here (`modules/mcp/router.ts`), so
            // gating needs no resolution step of its own the way the REST
            // gate above does.
            if (module.structural !== true) {
              await requireCapability(entitlements, requireWorkspaceId(actor), moduleCapabilityName(module.id))
            }

            return definition.invoke(parsed.data, actor)
          },
        })
      },
    },

    config(schema) {
      const result = schema.safeParse(options.environment)

      if (!result.success) {
        throw new ModuleBootError(
          result.error.issues.map((issue) => `module "${module.id}" config ${describeValidationIssue(issue)}`),
        )
      }

      return result.data
    },

    events,
    entitlements,

    log: options.logger.child({ module: module.id }),

    moduleCatalog,
    moduleConfig: options.moduleConfig,
  }
}

/**
 * Runs the registration pass: validate the module list, then call each module's
 * `register` once, in dependency order.
 *
 * @returns The accumulated contributions.
 * @throws ModuleBootError when the list is invalid or a module fails to register.
 */
export async function registerModules(options: ModuleRuntimeOptions): Promise<ModuleContributions> {
  const ordered = orderModules(options.modules)

  if (options.moduleConfig !== undefined) {
    validateModuleConfig(options.moduleConfig, options.modules)
  }

  const events = options.events ?? createEventBus(options.logger)
  const entitlements = options.entitlements ?? createEntitlementRegistry()
  const emailProxy = new EmailSenderProxy()
  const emailProviders = new Map<string, RegisteredProvider>()
  const externalSignIn = new ExternalSignInProxy()

  // The built-in log provider is always available, no module required. Named
  // 'log' in kelpie.config.ts's email.provider picks this one. Built eagerly
  // because it has no env to parse and never fails.
  const logSender = createLogEmailSender(options.logger, options.email.from)

  emailProviders.set(LOG_PROVIDER_NAME, {
    build: () => logSender,
    registeredBy: '<runtime>',
  })

  // Seed test-supplied providers before any module registers, so a module
  // collision with one of them fails boot the same way two modules would.
  if (options.additionalEmailProviders !== undefined) {
    for (const [name, sender] of options.additionalEmailProviders) {
      if (emailProviders.has(name)) {
        throw new ModuleBootError([
          `additionalEmailProviders names "${name}", which is already registered by the runtime`,
        ])
      }

      emailProviders.set(name, { build: () => sender, registeredBy: '<additionalEmailProviders>' })
    }
  }

  const accumulator: Accumulator = {
    routers: [],
    publicRouters: [],
    appMiddleware: [],
    appRoutes: [],
    schemas: [],
    mcpTools: [],
  }
  const moduleCatalog: readonly ModuleCatalogEntry[] = ordered.map((module) => ({
    id: module.id,
    structural: module.structural === true,
  }))

  // Declared once, centrally, rather than by each module's own `register`: a
  // module author does nothing to become toggleable, which is the point of
  // `structural` defaulting to false.
  for (const module of ordered) {
    if (module.structural !== true) {
      entitlements.declare({
        name: moduleCapabilityName(module.id),
        kind: 'flag',
        description: `Whether the "${module.id}" module is enabled for a workspace.`,
      })
    }
  }

  // Ahead of the registration loop, so it precedes any provider a module adds
  // during its own `register` and therefore wins `EntitlementRegistry.check`'s
  // first-answer-wins walk over providers.
  if (options.moduleConfig !== undefined) {
    entitlements.provide(createModuleConfigProvider(options.moduleConfig))
  }

  // Register every module's event catalog before any `register` runs, so a
  // module that subscribes to another module's event during its own registration
  // finds a validated name.
  for (const module of ordered) {
    if (module.events !== undefined) {
      try {
        events.registerCatalog({ moduleId: module.id, events: module.events })
      } catch (error: unknown) {
        throw new ModuleBootError([describeThrown(error)], { cause: error })
      }
    }
  }

  for (const module of ordered) {
    const context = createModuleContext(
      module,
      accumulator,
      options,
      events,
      entitlements,
      moduleCatalog,
      emailProxy,
      emailProviders,
      externalSignIn,
    )

    try {
      await module.register(context)
    } catch (error: unknown) {
      if (error instanceof ModuleBootError) {
        throw error
      }

      throw new ModuleBootError([`module "${module.id}" failed to register: ${describeThrown(error)}`], {
        cause: error,
      })
    }

    context.log.debug('module registered')
  }

  // Resolve the configured provider. The lookup happens after every module has
  // registered, so a module registering a provider late in the list still wins
  // if the config names it. An unknown name is a boot error whose message lists
  // every registered name, so a self-hoster sees what they had to pick from.
  const chosen = emailProviders.get(options.email.provider)

  if (chosen === undefined) {
    const available = [...emailProviders.keys()].sort()

    throw new ModuleBootError([
      `email.provider is "${options.email.provider}", which no module registered. Available: ${available.join(', ')}`,
    ])
  }

  // Only the chosen provider is built. A registered-but-unused provider never
  // runs its factory, so a self-hoster who leaves a module in `modules:` but
  // picks a different provider is not asked for the unused module's env.
  let chosenSender: EmailSender

  try {
    chosenSender = chosen.build()
  } catch (error: unknown) {
    if (error instanceof ModuleBootError) {
      throw error
    }

    throw new ModuleBootError(
      [`email provider "${options.email.provider}" (${chosen.registeredBy}) failed to build: ${describeThrown(error)}`],
      { cause: error },
    )
  }

  emailProxy.setTarget(chosenSender)

  options.logger.info('modules registered', {
    count: ordered.length,
    ids: ordered.map((module) => module.id),
    emailProvider: options.email.provider,
  })

  return {
    routers: accumulator.routers,
    publicRouters: accumulator.publicRouters,
    appMiddleware: accumulator.appMiddleware,
    appRoutes: accumulator.appRoutes,
    schemas: accumulator.schemas,
    mcpTools: accumulator.mcpTools,
    events,
    entitlements,
  }
}
