import type { Hono } from 'hono'
import type { ZodType } from 'zod'

import type { Logger } from '../lib/logger.ts'

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

export interface ModuleContext {
  /** Registers routes. They mount under `/v1` and are public API like any other. */
  routes(mount: (router: Hono) => void): void
  schema(tables: Readonly<Record<string, unknown>>, migrationsDir: string): void
  readonly mcp: McpToolRegistry
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
