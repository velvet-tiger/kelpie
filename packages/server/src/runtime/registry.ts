import { Hono } from 'hono'
import type { Context, Handler, MiddlewareHandler } from 'hono'

import type { Actor } from '../lib/actor.ts'
import { requireWorkspaceId } from '../lib/actor.ts'
import { requireApiKeyScope, routeScopeRuleFor } from '../lib/apiKeyScopes.ts'
import type { RouteScopeRule } from '../lib/apiKeyScopes.ts'
import { CAPTCHA_PROVIDER_VARIABLE } from '../lib/captcha.ts'
import type { CaptchaAccess, CaptchaProvider } from '../lib/captcha.ts'
import type { Environment, RuntimeMode } from '../lib/config.ts'
import { logEmailProviderWarning } from '../lib/deploymentChecks.ts'
import {
  createLogEmailSender,
  emailHeadersProblem,
  logEmailConfigSchema,
  logEmailWritesBody,
} from '../lib/email.ts'
import type { EmailMessage, EmailSender } from '../lib/email.ts'
import { AppError, describeThrown, describeValidationIssue, toErrorDetails } from '../lib/errors.ts'
import type { JobRegistry } from '../lib/jobs.ts'
import type { Logger } from '../lib/logger.ts'
import { createEntitlementRegistry, requireCapability } from './entitlements.ts'
import type { EntitlementRegistry } from './entitlements.ts'
import { createEventBus } from './events.ts'
import type { EventBus } from './events.ts'
import type {
  AgentDispatcher,
  CompletedSignIn,
  ExternalSignInHandler,
  KelpieModule,
  McpAuthorization,
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
  /**
   * The scopes modules declared for their own `/v1` routes. The scope
   * middleware reads them after core's rules.
   */
  readonly routeScopeRules: readonly RouteScopeRule[]
  /** In-process agent dispatchers, keyed by the `managed_by` value (the providing module's id). */
  readonly agentDispatchers: ReadonlyMap<string, AgentDispatcher>
  /** What the MCP endpoint's `401` advertises. Undefined when no module installed it. */
  readonly mcpAuthorization?: McpAuthorization | undefined
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

/**
 * A path segment that Hono reads as plain text. A list of what is allowed and
 * not of what is refused, so `*`, `:name`, `{regex}`, `?`, `%` and any pattern
 * syntax Hono adds later all fail it.
 */
const LITERAL_SEGMENT = /^[A-Za-z0-9._~-]+$/

/** `LITERAL_SEGMENT` in words, for a boot error. */
const LITERAL_SEGMENT_CHARACTERS = 'letters, digits, ".", "_", "~" or "-"'

/** The text between the optional leading `/` of a path and the next `/`. */
function firstSegment(path: string): string {
  const start = path.startsWith('/') ? 1 : 0
  const end = path.indexOf('/', start)

  return end === -1 ? path.slice(start) : path.slice(start, end)
}

/**
 * Refuses a path that `appRoute` or `appMiddleware` must not mount.
 *
 * The first segment must be literal, and is then compared with the reserved
 * names without regard to letter case. A compare of the text alone is not
 * enough: `/*`, `/:name/x` and `/v1*` are not under a reserved prefix as text,
 * and they match core's surface at request time. The app applies these
 * declarations after the `/v1` and `/mcp` routes and before `/healthz`, so such
 * a pattern would answer for `/healthz`, and for each path under `/v1` or
 * `/mcp` that no core route answers.
 *
 * Later segments may be patterns (`/operator/api/*`), because they can only
 * match below a first segment that this function has read.
 *
 * @throws ModuleBootError naming the module and the path.
 */
function assertMountablePath(moduleId: string, kind: string, path: string): void {
  if (!path.startsWith('/')) {
    throw new ModuleBootError([`module "${moduleId}" declares ${kind} "${path}", which must start with "/"`])
  }

  const segment = firstSegment(path)

  if (!LITERAL_SEGMENT.test(segment)) {
    throw new ModuleBootError([
      `module "${moduleId}" declares ${kind} "${path}", which must start with a literal segment: ${LITERAL_SEGMENT_CHARACTERS}. A pattern in the first segment can match core's surface.`,
    ])
  }

  const reserved = RESERVED_APP_PATHS.find((candidate) => candidate === `/${segment.toLowerCase()}`)

  if (reserved !== undefined) {
    throw new ModuleBootError([
      `module "${moduleId}" declares ${kind} "${path}" under "${reserved}", which is core's surface`,
    ])
  }
}

/**
 * The verb methods of a Hono router. `query` is the HTTP `QUERY` method. A
 * verb that a later Hono version adds is not here, and `gateRouter` refuses a
 * member that it does not know, so that verb fails at boot until it is added.
 */
const ROUTER_VERB_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'query', 'all'] as const
type RouterVerbMethod = (typeof ROUTER_VERB_METHODS)[number]

function isRouterVerbMethod(name: string): name is RouterVerbMethod {
  return (ROUTER_VERB_METHODS as readonly string[]).includes(name)
}

/**
 * Refuses a route path on a gated module router that would match the routes
 * of other modules.
 *
 * Hono flattens the module router onto `/v1`, so `*` becomes `/v1/*` and
 * `/:name` becomes `/v1/:name`. The gate that the wrapper puts ahead of the
 * handler then runs for requests to other modules, and a workspace with this
 * module off can lose those routes too. A path that starts with a literal
 * segment can only match below that segment.
 *
 * `/` and the empty path are the one route at `/v1` itself, so they pass.
 *
 * @param call The router method the module called, for the message.
 * @throws ModuleBootError naming the module and the path.
 */
function assertModuleLocalPath(moduleId: string, call: string, path: string): void {
  if (isRootPath(path)) {
    return
  }

  if (!LITERAL_SEGMENT.test(firstSegment(path))) {
    throw new ModuleBootError([
      `module "${moduleId}" called router.${call}() with a path that does not start with a literal segment ("${path}"). Hono flattens the module router onto "/v1", so this would fire for other modules' routes. Start the path with a segment of ${LITERAL_SEGMENT_CHARACTERS} ("/things/:id").`,
    ])
  }
}

/** Whether a path on a module router is the router's own root, which Hono mounts at `/v1` itself. */
function isRootPath(path: string): boolean {
  return path === '/' || path === ''
}

/**
 * Reads the first argument of `router.use` as the pattern of the middleware.
 *
 * Three cases fail, each with its own message. No path, `*` and `/*` cover
 * every route of every module. The root covers `/v1` alone, so a guard there
 * guards no route of the module. Any other pattern must be local to the
 * module, as for a verb.
 *
 * @throws ModuleBootError naming the module and the pattern.
 */
function routerUsePattern(moduleId: string, first: unknown): string {
  if (typeof first !== 'string' || first === '*' || first === '/*') {
    throw new ModuleBootError([
      `module "${moduleId}" called router.use() with an app-wide pattern (${
        typeof first === 'string' ? `"${first}"` : 'no path'
      }). Hono flattens the module router onto "/v1", so this would fire for every module's routes. Name a specific path ("/things/*") or attach middleware per route.`,
    ])
  }

  if (isRootPath(first)) {
    throw new ModuleBootError([
      `module "${moduleId}" called router.use() with the path "${first}". Hono flattens the module router onto "/v1", so this middleware would run for "/v1" alone and for no route of the module. Name a specific path ("/things/*") or attach middleware per route.`,
    ])
  }

  assertModuleLocalPath(moduleId, 'use', first)

  return first
}

/**
 * Reads the first argument of `router.route` as the path a sub-router mounts on.
 *
 * `gateRouter` gates a sub-router with a middleware on `<path>/*`. At the root
 * that pattern is `/*`, and below a pattern segment (`/:name`) it matches the
 * routes of other modules, so both fail.
 *
 * @throws ModuleBootError naming the module and the path.
 */
function routerRoutePath(moduleId: string, path: unknown): string {
  if (typeof path !== 'string') {
    throw new ModuleBootError([
      `module "${moduleId}" called router.route() with a path that is not a string. Name the path as a string ("/things").`,
    ])
  }

  // A path of slashes only is the root too: the gate pattern drops them.
  if (isRootPath(path.replace(/\/+$/, ''))) {
    throw new ModuleBootError([
      `module "${moduleId}" called router.route() with the path "${path}". The sub-router would mount on "/v1" itself, so the module gate would run for every module's routes. Mount it below a segment of the module ("/things").`,
    ])
  }

  assertModuleLocalPath(moduleId, 'route', path)

  return path
}

/**
 * Reads the path argument of `router.on` as the list of paths Hono registers.
 *
 * @throws ModuleBootError when an entry is not a string, or is not local to the module.
 */
function routerOnPaths(moduleId: string, path: unknown): readonly string[] {
  const entries: readonly unknown[] = Array.isArray(path) ? path : [path]
  const paths: string[] = []

  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new ModuleBootError([
        `module "${moduleId}" called router.on() with a path that is not a string. Name every path as a string ("/things").`,
      ])
    }

    assertModuleLocalPath(moduleId, 'on', entry)
    paths.push(entry)
  }

  return paths
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
 * - HTTP verbs (`ROUTER_VERB_METHODS`) and `on`: prepend `gate`, then the
 *   module's handlers.
 * - `use(pattern, ...)` at a specific path: prepend `gate`, then the mw.
 * - `route(subPath, subApp)`: attach `gate` as middleware on `subPath/*`,
 *   then mount `subApp`, so every route it contributes runs the gate first.
 *
 * And the calls that cannot be made module-local through wrapping fail at
 * boot with a message naming the module, rather than shipping a subtle leak:
 *
 * - A verb call with no path string (`router.get('/x', a).post(b)`): Hono
 *   reads it as "the path of the last call", or `*` when there was none. The
 *   wrapper cannot put the gate ahead of a handler that sits where the path
 *   goes, so the route would answer with no gate. Every call names its path.
 *   `on` with a path that is not a string fails the same way.
 * - A verb or `on` path that does not start with a literal segment (`*`,
 *   `/*`, `/:name`, `/:name/*`): see `assertModuleLocalPath`. `/` passes: it
 *   is the one route at `/v1` itself.
 * - `use()` with no path, `use('*')`, `use('/*')`: any of these register a
 *   middleware at `/v1/*` on the parent app once the router is mounted — the
 *   exact bug this wrapper prevents. A `use` pattern that does not start
 *   with a literal segment (`/:name/*`, `/:name{.+}`) matches the routes of
 *   other modules in the same way. A module that wants to share middleware
 *   across many of its routes must name a specific path (`/things/*`) or
 *   attach the middleware per route.
 * - `use('/')` and `use('')`: these register at `/v1` alone, so they are
 *   not a leak. They cover no route of the module, and an author who writes
 *   one expects that it covers all of them.
 * - `route('/')`, `route('')` and a `route` path that does not start with a
 *   literal segment (`/:name`): the gate pattern would be `/v1/*` or would
 *   match the routes of other modules.
 * - `notFound` / `onError`: fire for every unmatched or failing `/v1`
 *   request once the router is flattened, so a module's handler would run
 *   for other modules' traffic. Handle failures inside the module's own
 *   route handlers instead.
 * - Every other member whose value is a function or an object: `mount`,
 *   `basePath`, `fetch`, `request`, `fire`, `routes`, `router`, and a verb
 *   that a later Hono version adds. Each is a way to register that the gate
 *   does not cover, or is of no use to a module. The wrapper fails closed
 *   here. It hands over only a value that is not a function and not an
 *   object, and the members that every object has (`toString`).
 *
 * Only a read through the proxy is covered. An assignment to a member, or a
 * read of a property descriptor, still reaches the router. A module is
 * trusted code, and the wrapper guards against a mistake, not against intent.
 */
function gateRouter(router: Hono, moduleId: string, gate: MiddlewareHandler): Hono {
  const proxy: Hono = new Proxy(router, {
    get(target, property, receiver) {
      if (typeof property !== 'string') {
        return Reflect.get(target, property, receiver)
      }

      if (isRouterVerbMethod(property)) {
        // `path` is `unknown` because Hono also takes a handler there, and
        // that is the call this wrapper has to refuse.
        return (path: unknown, ...handlers: Handler[]): Hono => {
          if (typeof path !== 'string') {
            throw new ModuleBootError([
              `module "${moduleId}" called router.${property}() without a path. Hono then reuses the path of the previous call, or "*", and runs the handler ahead of the module gate. Name the path on every call ("/things").`,
            ])
          }

          assertModuleLocalPath(moduleId, property, path)

          const method = target[property] as (path: string, ...handlers: Handler[]) => Hono
          method.call(target, path, gate, ...handlers)
          return proxy
        }
      }

      if (property === 'on') {
        return (method: string | string[], path: unknown, ...handlers: Handler[]): Hono => {
          const paths = routerOnPaths(moduleId, path)

          target.on(method as never, paths as never, gate, ...handlers)
          return proxy
        }
      }

      if (property === 'use') {
        return (first: unknown, ...handlers: MiddlewareHandler[]): Hono => {
          target.use(routerUsePattern(moduleId, first), gate, ...handlers)
          return proxy
        }
      }

      if (property === 'route') {
        return (path: unknown, subApp: Hono): Hono => {
          const mountPath = routerRoutePath(moduleId, path)

          // The sub-app's routes were registered on it before this call, so a
          // proxy over `subApp` cannot retroactively prepend the gate to them.
          // Instead attach the gate as middleware scoped to the sub-router's
          // mount prefix on this router — once flattened onto `/v1`, the
          // middleware covers exactly `/v1${path}/*`, which is the module's
          // own routes. `use` must land before `route` so composition order
          // runs the gate first.
          target.use(`${mountPath.replace(/\/+$/, '')}/*`, gate)
          target.route(mountPath, subApp)
          return proxy
        }
      }

      if (property === 'notFound' || property === 'onError') {
        throw new ModuleBootError([
          `module "${moduleId}" called router.${property}(). A module router's ${property} fires for every unmatched or failing "/v1" request once the router is mounted; handle failures inside the module's own route handlers instead.`,
        ])
      }

      const value: unknown = Reflect.get(target, property, receiver)
      const isPlainValue = typeof value !== 'function' && (typeof value !== 'object' || value === null)

      if (isPlainValue || property in Object.prototype) {
        return value
      }

      // Fail closed. Each member the wrapper can gate is handled above, so
      // this one registers with no gate (`mount`, `basePath`, `routes`), or
      // is a verb that this code does not know yet.
      throw new ModuleBootError([
        `module "${moduleId}" used router.${property}, which the module gate does not cover. A module router provides ${[...ROUTER_VERB_METHODS, 'on', 'use', 'route'].join(', ')}.`,
      ])
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
   *
   * `runtimeMode` is the mode the deployment runs in. In `production` the log
   * provider writes no message body, unless `EMAIL_LOG_BODY=true`, and the
   * runtime warns when that provider is the one picked. An assembly that
   * omits the field gets the production rule, which is the safe one.
   */
  readonly email: {
    readonly provider: string
    readonly from: string
    readonly runtimeMode?: RuntimeMode | undefined
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
  readonly routeScopeRules: RouteScopeRule[]
  readonly agentDispatchers: Map<string, AgentDispatcher>
  mcpAuthorization?: { readonly value: McpAuthorization; readonly installedBy: string }
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

    // Checked here, so every provider gets headers that are safe to write,
    // and a provider that does no check of its own cannot be used to inject.
    const problem = emailHeadersProblem(message.headers)

    if (problem !== undefined) {
      return Promise.reject(new Error(problem))
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
 * Whether the built-in log sender writes message bodies, from the mode and
 * `EMAIL_LOG_BODY`.
 *
 * @throws ModuleBootError when `EMAIL_LOG_BODY` is set and is not `true` or `false`.
 */
function resolveLogEmailBody(runtimeMode: RuntimeMode, environment: Environment): boolean {
  const result = logEmailConfigSchema.safeParse(environment)

  if (!result.success) {
    throw new ModuleBootError(result.error.issues.map((issue) => `email ${describeValidationIssue(issue)}`))
  }

  return logEmailWritesBody(runtimeMode, result.data.EMAIL_LOG_BODY)
}

/**
 * Records which module registered a given provider name, so a collision error
 * can name both parties. `build` is invoked once, only for the chosen provider.
 */
interface RegisteredProvider {
  readonly build: () => EmailSender
  readonly registeredBy: string
}

/**
 * The CAPTCHA provider every module reads through. `target` is set once, after
 * all modules have registered, and stays undefined when the deployment picked
 * no provider. Unlike `EmailSenderProxy` there is nothing to throw about: no
 * CAPTCHA is a valid deployment.
 */
class CaptchaProxy implements CaptchaAccess {
  private target: CaptchaProvider | undefined = undefined

  setTarget(provider: CaptchaProvider): void {
    this.target = provider
  }

  current(): CaptchaProvider | undefined {
    return this.target
  }
}

/** The CAPTCHA counterpart of `RegisteredProvider`. */
interface RegisteredCaptcha {
  readonly build: () => CaptchaProvider
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
  captchaProxy: CaptchaProxy,
  captchaProviders: Map<string, RegisteredCaptcha>,
): ModuleContext {
  return {
    ...options.services,
    email: emailProxy,
    captcha: captchaProxy,

    provideCaptcha(name, build) {
      const existing = captchaProviders.get(name)

      if (existing !== undefined) {
        throw new ModuleBootError([
          `module "${module.id}" registers CAPTCHA provider "${name}", but module "${existing.registeredBy}" already did`,
        ])
      }

      captchaProviders.set(name, { build, registeredBy: module.id })
    },
    jobs: options.jobs ?? createMissingJobsRegistry(module.id),

    provideExternalSignIn(handler) {
      externalSignIn.install(module.id, handler)
    },

    completeExternalSignIn(context, identity) {
      return externalSignIn.complete(context, identity)
    },

    provideMcpAuthorization(authorization) {
      if (accumulator.mcpAuthorization !== undefined) {
        throw new ModuleBootError([
          `module "${module.id}" provides MCP authorization, but module "${accumulator.mcpAuthorization.installedBy}" already did`,
        ])
      }

      accumulator.mcpAuthorization = { value: authorization, installedBy: module.id }
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

    routeScopes(declarations) {
      for (const declaration of declarations) {
        try {
          accumulator.routeScopeRules.push(
            routeScopeRuleFor(declaration.methods, declaration.path, declaration.scope),
          )
        } catch (error: unknown) {
          // `routeScopeRuleFor` throws a plain Error for a path it cannot
          // read, and nothing else. Boot names the module that declared it.
          if (!(error instanceof Error)) {
            throw error
          }

          throw new ModuleBootError([`module "${module.id}": ${error.message}`])
        }
      }
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

    agentDispatch: {
      provide(dispatcher) {
        if (accumulator.agentDispatchers.has(module.id)) {
          throw new ModuleBootError([`module "${module.id}" provides an agent dispatcher twice`])
        }

        accumulator.agentDispatchers.set(module.id, dispatcher)
      },
      // Read at run time, so a module registered later than the caller is found.
      find: (managedBy) => accumulator.agentDispatchers.get(managedBy),
    },

    mcp: {
      // The accumulator's own array: `contributions.mcpTools` is this same
      // array, so a caller at run time sees every module's tools.
      list: () => accumulator.mcpTools,

      tool(definition) {
        if (accumulator.mcpTools.some((existing) => existing.name === definition.name)) {
          throw new ModuleBootError([`module "${module.id}" declares MCP tool "${definition.name}" twice`])
        }

        accumulator.mcpTools.push({
          name: definition.name,
          description: definition.description,
          scope: definition.scope,
          inputSchema: definition.inputSchema,
          // Parsing here is what keeps MCP and REST from drifting: both surfaces
          // validate with the module's schema and fail with the same API error.
          invoke: async (rawInput, actor) => {
            // Here and not only at the MCP endpoint, so a module that calls
            // tools in-process with the caller's actor (`ai` person intake)
            // cannot do more than that caller's key allows.
            requireApiKeyScope(actor, definition.scope)

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
  const captchaProxy = new CaptchaProxy()
  const captchaProviders = new Map<string, RegisteredCaptcha>()

  // The built-in log provider is always available, no module required. Named
  // 'log' in kelpie.config.ts's email.provider picks this one. Built eagerly
  // because it never fails once its one optional variable is read.
  //
  // An assembly that gives no mode is treated as production, so a caller that
  // was written before the field existed puts no sign-in link in its log.
  const emailRuntimeMode = options.email.runtimeMode ?? 'production'
  const logEmailBody = resolveLogEmailBody(emailRuntimeMode, options.environment)
  const logSender = createLogEmailSender(options.logger, options.email.from, { writeBody: logEmailBody })

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
    routeScopeRules: [],
    agentDispatchers: new Map(),
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
      captchaProxy,
      captchaProviders,
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

  const logProviderWarning = logEmailProviderWarning(
    emailRuntimeMode,
    options.email.provider === LOG_PROVIDER_NAME,
    logEmailBody,
  )

  if (logProviderWarning !== undefined) {
    options.logger.warn(logProviderWarning)
  }

  // The CAPTCHA provider resolves the same way, with one difference: no name
  // is a valid choice, and leaves `context.captcha.current()` undefined.
  const captchaName = (options.environment[CAPTCHA_PROVIDER_VARIABLE] ?? '').trim()

  if (captchaName.length > 0) {
    const chosenCaptcha = captchaProviders.get(captchaName)

    if (chosenCaptcha === undefined) {
      const available = [...captchaProviders.keys()].sort()

      throw new ModuleBootError([
        `${CAPTCHA_PROVIDER_VARIABLE} is "${captchaName}", which no module registered. Available: ${available.length === 0 ? '(none)' : available.join(', ')}`,
      ])
    }

    try {
      captchaProxy.setTarget(chosenCaptcha.build())
    } catch (error: unknown) {
      if (error instanceof ModuleBootError) {
        throw error
      }

      throw new ModuleBootError(
        [`CAPTCHA provider "${captchaName}" (${chosenCaptcha.registeredBy}) failed to build: ${describeThrown(error)}`],
        { cause: error },
      )
    }
  }

  options.logger.info('modules registered', {
    count: ordered.length,
    ids: ordered.map((module) => module.id),
    emailProvider: options.email.provider,
    captchaProvider: captchaName.length > 0 ? captchaName : null,
  })

  return {
    routers: accumulator.routers,
    publicRouters: accumulator.publicRouters,
    appMiddleware: accumulator.appMiddleware,
    appRoutes: accumulator.appRoutes,
    schemas: accumulator.schemas,
    mcpTools: accumulator.mcpTools,
    routeScopeRules: accumulator.routeScopeRules,
    agentDispatchers: accumulator.agentDispatchers,
    mcpAuthorization: accumulator.mcpAuthorization?.value,
    events,
    entitlements,
  }
}
