export { createApp } from './app.ts'
export type { AppDependencies, AppBindings } from './app.ts'

export { WebBundleError, serveWebBundle } from './webBundle.ts'
export type { WebBundleOptions } from './webBundle.ts'

export { ConfigurationError, loadConfig } from './lib/config.ts'
export type { Environment, KelpieConfig, LogLevel, RuntimeMode } from './lib/config.ts'

export { fromEnv, isFromEnvMarker, resolveMarker, resolveMarkers } from './lib/fromEnv.ts'
export type { ConfigValue, FromEnvMarker, FromEnvProblem, ResolveResult } from './lib/fromEnv.ts'

export { defineKelpieConfig, resolveKelpieConfig } from './lib/kelpieConfigFile.ts'
export type {
  EmailInput,
  KelpieConfigInput,
  RateLimitBudgetInput,
  RateLimitInput,
  SecretEncryptionInput,
} from './lib/kelpieConfigFile.ts'

export { appUrlConfigSchema } from './lib/appUrl.ts'
export type { AppUrlConfig } from './lib/appUrl.ts'

export { resolveClientIpFrom } from './lib/clientIp.ts'

export { ModuleConfigFileError, readModuleConfigFile } from './lib/moduleConfig.ts'

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
  SecretDecryptionError,
  createSecretCipher,
  secretEncryptionConfigSchema,
} from './lib/secrets.ts'
export type { SecretCipher, SecretEncryptionConfig } from './lib/secrets.ts'

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

export {
  createCaptureTransport,
  createLogger,
  createStdoutTransport,
  createTransportForDestination,
} from './lib/logger.ts'
export type { CreateLoggerOptions, LogFields, Logger, LoggingDestination } from './lib/logger.ts'

export type {
  KelpieModule,
  McpTool,
  McpToolDefinition,
  McpToolRegistry,
  ModuleCatalogEntry,
  ModuleContext,
  SchemaContribution,
} from './runtime/module.ts'

export { ModuleBootError, orderModules } from './runtime/order.ts'

export { createEntitlementRegistry, limitFor, requireCapability } from './runtime/entitlements.ts'
export type {
  Capability,
  Entitlement,
  EntitlementRegistry,
  FlagCapability,
  GrantProvider,
  LimitCapability,
} from './runtime/entitlements.ts'

export { SEATS_LIMIT } from './modules/workspace/capabilities.ts'

export {
  RECORD_OBJECT_TYPES,
  checkEventCycle,
  createEventBus,
  currentEventChain,
} from './runtime/events.ts'
export type {
  AnyEventHandler,
  CycleGuardOutcome,
  EventBus,
  EventBusOptions,
  EventCatalog,
  EventChainEntry,
  EventHandler,
  EventName,
  KelpieEventMap,
  RecordObjectType,
  SubscribeOptions,
} from './runtime/events.ts'
export type { ModuleEventCatalog } from './runtime/module.ts'

export { createTransactionScope } from './runtime/transaction.ts'
export type {
  BufferedEvents,
  Transaction,
  TransactionContext,
  TransactionOptions,
  TransactionScope,
  TransactionScopeDependencies,
} from './runtime/transaction.ts'

export { planMigrations, runMigrations } from './runtime/migrate.ts'
export type { MigrationPlanStep } from './runtime/migrate.ts'

export { coreMigrationsDirectory, coreModules } from './modules/core.ts'

export { resealStoredSecrets, runReseal } from './modules/reseal.ts'
export type { ResealColumnOutcome, ResealOutcome, ResealPass, RunResealOptions } from './modules/reseal.ts'

export { KEY_KINDS, kindOfSecret, mintKey, parseKeyKind, readBearerToken } from './modules/api-keys/keys.ts'
export type { KeyKind, MintedKey } from './modules/api-keys/keys.ts'

export { registerModules } from './runtime/registry.ts'
export type {
  AppMiddlewareContribution,
  AppRouteContribution,
  ModuleContributions,
  ModuleRouter,
  ModuleRuntimeOptions,
} from './runtime/registry.ts'
export type { ModuleServices } from './runtime/module.ts'

export type { Actor, ApiKeyActor, SessionActor } from './modules/auth/actor.ts'
export { actorUserId, actorWorkspaceId, requireSessionActor } from './modules/auth/actor.ts'
export { resolveActor, resolveActorFrom } from './modules/auth/credentials.ts'
export type { CredentialDependencies } from './modules/auth/credentials.ts'
export { MEMBER_ROLES, INVITABLE_ROLES, parseMemberRole, roleAllows } from './modules/workspace/roles.ts'
export type { InvitableRole, MemberRole } from './modules/workspace/roles.ts'
