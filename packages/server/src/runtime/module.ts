import type { Hono } from 'hono'
import type { ZodType } from 'zod'

import type { Actor } from '../lib/actor.ts'
import type { Database } from '../lib/database.ts'
import type { EmailSender } from '../lib/email.ts'
import type { IdFactory } from '../lib/ids.ts'
import type { Logger } from '../lib/logger.ts'
import type { EntitlementRegistry } from './entitlements.ts'
import type { EventBus } from './events.ts'
import type { TransactionScope } from './transaction.ts'

/**
 * The module contract from `modules.md`. Core features register through this
 * same runtime, so anything core can do, a module can do.
 *
 * Composition is build-time: an assembly lists its modules in `kelpie.config.ts`
 * and the runtime registers them. There is no runtime plugin loading.
 */

/** A module's Drizzle tables plus the directory holding its migrations. */
export interface SchemaContribution {
  readonly moduleId: string
  /** The module's schema namespace: table, relation, and enum exports. */
  readonly tables: Readonly<Record<string, unknown>>
  readonly migrationsDir: string
}

/**
 * A tool as a module declares it. The input schema is the same one the matching
 * REST route validates with, so the two surfaces cannot drift.
 *
 * `invoke` receives the caller for the same reason a route handler resolves one:
 * every service call is authorized against an actor and scoped to its workspace.
 * The MCP endpoint resolves it once per request from the bearer key and hands it
 * down, so a tool never reads identity from anywhere but its own arguments.
 */
export interface McpToolDefinition<Input> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodType<Input>
  readonly invoke: (input: Input, actor: Actor) => Promise<unknown>
}

/**
 * A tool as the registry holds it. Registration erases the input type behind a
 * parse, so every call is validated before the tool body sees it.
 */
export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodType
  readonly invoke: (rawInput: unknown, actor: Actor) => Promise<unknown>
}

export interface McpToolRegistry {
  tool<Input>(definition: McpToolDefinition<Input>): void
}

/**
 * What a module gets to build with, beyond its own contributions.
 *
 * `modules.md` does not list these. A module that contributes tables has no way
 * to query them without a handle, and every write needs the transaction scope so
 * its events publish after commit rather than during. Recorded here as the
 * builder decision the spec left open.
 */
export interface ModuleServices {
  readonly db: Database
  /** Runs work in one transaction and publishes its events after commit. */
  readonly transaction: TransactionScope
  /** Transactional mail only: invites and password resets. */
  readonly email: EmailSender
  /** Generates `<prefix>_<ulid>` ids. Injected so tests can pin them. */
  readonly createId: IdFactory
  /** The current time, injected so expiry logic is testable. */
  readonly now: () => Date
}

export interface ModuleContext extends ModuleServices {
  /** Registers routes. They mount under `/v1` and are public API like any other. */
  routes(mount: (router: Hono) => void): void
  /**
   * Registers routes that mount under `/v1/public`, take no credentials, and
   * answer cross-origin requests from any site.
   *
   * A second method rather than an argument to `routes`, because the auth
   * boundary is then visible at the call site: a reader of a module's `register`
   * can see which of its endpoints anyone on the internet may call.
   *
   * A handler here has no `Actor` and therefore no workspace. It must resolve one
   * from something in the request that identifies it — a form's `publicKey` — and
   * scope every query to that. There is no other way in.
   */
  publicRoutes(mount: (router: Hono) => void): void
  schema(tables: Readonly<Record<string, unknown>>, migrationsDir: string): void
  readonly mcp: McpToolRegistry
  /**
   * Subscribe to domain events. Handlers run after the emitting transaction
   * commits, and must be idempotent.
   */
  readonly events: EventBus
  /**
   * Declare capabilities and check grants. Every check is granted and unlimited
   * until a module registers a provider.
   */
  readonly entitlements: EntitlementRegistry
  /** Validates this module's slice of the environment. Fails boot when invalid. */
  config<T>(schema: ZodType<T>): T
  readonly log: Logger
  /**
   * Every module in the assembly, id and `structural` flag only. The workspace
   * module's settings screen is the one reader today: it needs the toggleable
   * id list and cannot import `modules/core.ts` itself without a cycle, since
   * that file is what constructs the workspace module in the first place.
   */
  readonly moduleCatalog: readonly ModuleCatalogEntry[]
  /**
   * The deploy-time module override (`lib/moduleConfig.ts`), unparsed into
   * grants. The workspace module reads this to answer whether a module's value
   * is locked, which `EntitlementRegistry.check`'s single merged answer cannot
   * tell a caller on its own.
   */
  readonly moduleConfig: Readonly<Record<string, boolean>> | undefined
}

export interface ModuleCatalogEntry {
  readonly id: string
  readonly structural: boolean
}

export interface KelpieModule {
  readonly id: string
  /** Ids of modules that must register first. Missing ones fail boot. */
  readonly requires?: readonly string[]
  /**
   * Marks a module as always enabled: no `module.<id>` capability is declared for
   * it, its routes and MCP tools are never gated, and a deploy-time module config
   * file or a workspace's own settings may not name it. True for the modules the
   * rest of the app cannot function without.
   *
   * Absent (or false) means toggleable, which is the default a new module gets
   * without its author having to opt in.
   */
  readonly structural?: boolean
  register(context: ModuleContext): Promise<void>
}
