export { createApp } from './app.ts'
export type { AppDependencies } from './app.ts'

export { ConfigurationError, loadConfig } from './lib/config.ts'
export type { Environment, KelpieConfig, LogLevel, RuntimeMode } from './lib/config.ts'

export {
  FOREIGN_KEY_VIOLATION,
  RESTRICT_VIOLATION,
  UNIQUE_VIOLATION,
  connectDatabase,
  isReferenceViolation,
  postgresErrorCode,
} from './lib/database.ts'
export type { Database, DatabaseConnection, DatabaseProbe } from './lib/database.ts'

export * as schema from './schema/index.ts'

export {
  AppError,
  describeThrown,
  describeValidationIssue,
  internalErrorBody,
  toErrorBody,
  toErrorDetails,
} from './lib/errors.ts'
export type { ErrorBody, ErrorCode, ErrorDetail, ErrorStatus, ValidationIssue } from './lib/errors.ts'

export { createIdFactory, idPrefixes } from './lib/ids.ts'
export type { IdFactory, ObjectKind } from './lib/ids.ts'

export { createLogger } from './lib/logger.ts'
export type { LogFields, Logger, LogSink } from './lib/logger.ts'

export type {
  KelpieModule,
  McpTool,
  McpToolDefinition,
  McpToolRegistry,
  ModuleContext,
  SchemaContribution,
} from './runtime/module.ts'

export { ModuleBootError, orderModules } from './runtime/order.ts'

export { planMigrations, runMigrations } from './runtime/migrate.ts'
export type { MigrationPlanStep } from './runtime/migrate.ts'

export { coreMigrationsDirectory, coreModules } from './modules/core.ts'

export { noContributions, registerModules } from './runtime/registry.ts'
export type { ModuleContributions, ModuleRouter, ModuleRuntimeOptions } from './runtime/registry.ts'
