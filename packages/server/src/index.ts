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

export { createEmailSender, createLogEmailSender, emailConfigSchema } from './lib/email.ts'
export type { EmailConfig, EmailMessage, EmailSender } from './lib/email.ts'

export { MINIMUM_PASSWORD_LENGTH, hashPassword, isPasswordStrongEnough, verifyPassword } from './lib/passwords.ts'
export { generateToken, hashToken, tokenHashesMatch } from './lib/tokens.ts'

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

export { DOMAIN_EVENT_NAMES, RECORD_OBJECT_TYPES, createEventBus } from './runtime/events.ts'
export type {
  DomainEventName,
  DomainEvents,
  EventBus,
  EventHandler,
  RecordObjectType,
  StagedObjectType,
} from './runtime/events.ts'

export { createTransactionScope } from './runtime/transaction.ts'
export type {
  BufferedEvents,
  Transaction,
  TransactionContext,
  TransactionScope,
  TransactionScopeDependencies,
} from './runtime/transaction.ts'

export { planMigrations, runMigrations } from './runtime/migrate.ts'
export type { MigrationPlanStep } from './runtime/migrate.ts'

export { coreMigrationsDirectory, coreModules } from './modules/core.ts'

export { KEY_KINDS, kindOfSecret, mintKey, parseKeyKind, readBearerToken } from './modules/api-keys/keys.ts'
export type { KeyKind, MintedKey } from './modules/api-keys/keys.ts'

export { registerModules } from './runtime/registry.ts'
export type { ModuleContributions, ModuleRouter, ModuleRuntimeOptions } from './runtime/registry.ts'
export type { ModuleServices } from './runtime/module.ts'

export type { Actor, ApiKeyActor, SessionActor } from './modules/auth/actor.ts'
export { actorUserId, actorWorkspaceId, requireSessionActor } from './modules/auth/actor.ts'
export { resolveActor, resolveActorFrom } from './modules/auth/credentials.ts'
export type { CredentialDependencies } from './modules/auth/credentials.ts'
export { MEMBER_ROLES, INVITABLE_ROLES, parseMemberRole, roleAllows } from './modules/workspace/roles.ts'
export type { InvitableRole, MemberRole } from './modules/workspace/roles.ts'
