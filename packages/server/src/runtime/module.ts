import type { Hono } from 'hono'
import type { ZodType } from 'zod'

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
 */
export interface McpToolDefinition<Input> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodType<Input>
  readonly invoke: (input: Input) => Promise<unknown>
}

/**
 * A tool as the registry holds it. Registration erases the input type behind a
 * parse, so every call is validated before the tool body sees it.
 */
export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodType
  readonly invoke: (rawInput: unknown) => Promise<unknown>
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
  /** Adds names to the list of events webhooks can subscribe to. */
  webhookEvents(names: readonly string[]): void
  /** Validates this module's slice of the environment. Fails boot when invalid. */
  config<T>(schema: ZodType<T>): T
  readonly log: Logger
}

export interface KelpieModule {
  readonly id: string
  /** Ids of modules that must register first. Missing ones fail boot. */
  readonly requires?: readonly string[]
  register(context: ModuleContext): Promise<void>
}
