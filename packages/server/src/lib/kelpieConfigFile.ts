import type { KelpieModule } from '../runtime/module.ts'
import { ConfigurationError, type Environment, type KelpieConfig, type LogLevel, type RuntimeMode } from './config.ts'
import type { EmailConfig } from './email.ts'
import { type ConfigValue, resolveMarkers } from './fromEnv.ts'
import type { RateLimitConfig } from './rateLimit.ts'

/**
 * The shape a `kelpie.config.ts` file declares.
 *
 * Every leaf is either a literal value the assembly commits to git, or a
 * `fromEnv(...)` marker the deployment fills in. The resolver walks this
 * object, replaces markers with parsed values, and returns a fully-populated
 * `KelpieConfig`.
 *
 * The file is the map. `fromEnv(...)` marks the leaves a deployment overrides.
 * Nothing in the app reads `process.env` for these fields after boot.
 */

export interface KelpieConfigInput {
  readonly runtimeMode: ConfigValue<RuntimeMode>
  readonly port: ConfigValue<number>
  readonly databaseUrl: ConfigValue<string>
  readonly logLevel: ConfigValue<LogLevel>
  /** Optional; unset in development, set to the built web bundle in a deployment. */
  readonly webBundleDirectory?: ConfigValue<string | undefined>
  /** Optional; unset in development, set to the deploy-time module override file. */
  readonly moduleConfigPath?: ConfigValue<string | undefined>
  /** Optional; defaults to 0 (no proxy in front). */
  readonly trustedProxyHopCount?: ConfigValue<number>
  readonly email: EmailInput
  /** Optional; each unset field falls back to the same defaults `loadConfig` used. */
  readonly rateLimit?: RateLimitInput
  /** The module list the assembly composes. Same shape it had before. */
  readonly modules: readonly KelpieModule[]
}

export interface EmailInput {
  readonly provider: ConfigValue<'log' | 'smtp'>
  readonly from: ConfigValue<string>
  /**
   * Required when provider is `smtp`; ignored when `log`. Every leaf permits
   * `undefined` so a `fromEnv(..., undefined)` marker can leave it unfilled and
   * `resolveKelpieConfig` can report which specific SMTP field is missing.
   */
  readonly smtp?: {
    readonly host?: ConfigValue<string | undefined>
    readonly port?: ConfigValue<number | undefined>
    readonly secure?: ConfigValue<boolean | undefined>
    readonly user?: ConfigValue<string | undefined>
    readonly password?: ConfigValue<string | undefined>
  }
}

export interface RateLimitBudgetInput {
  readonly limit?: ConfigValue<number>
  readonly windowSeconds?: ConfigValue<number>
}

export interface RateLimitInput {
  readonly forms?: RateLimitBudgetInput
  readonly auth?: RateLimitBudgetInput
  readonly loginAccount?: RateLimitBudgetInput
  readonly api?: RateLimitBudgetInput
}

/**
 * The defaults for each rate-limit budget, from `lib/rateLimit.ts`. Kept in
 * this file so the assembly can leave `rateLimit` unset and still get the same
 * numbers `loadConfig` produced.
 */
const RATE_LIMIT_DEFAULTS = {
  forms: { limit: 20, windowSeconds: 60 },
  auth: { limit: 10, windowSeconds: 60 },
  loginAccount: { limit: 10, windowSeconds: 900 },
  api: { limit: 600, windowSeconds: 60 },
} as const

/**
 * Identity helper for the assembly's config file. It exists for the type-check
 * only: `defineKelpieConfig({...})` makes TypeScript check the object against
 * `KelpieConfigInput` at the call site, so a wrong-shape field is caught in
 * the assembly rather than at boot.
 */
export function defineKelpieConfig(input: KelpieConfigInput): KelpieConfigInput {
  return input
}

/**
 * Resolves an assembly's config against an environment.
 *
 * Every `fromEnv` marker is resolved. Missing required variables and parse
 * failures are collected together, so a self-hoster fixes them in one pass.
 *
 * @throws ConfigurationError listing every problem.
 */
export function resolveKelpieConfig(input: KelpieConfigInput, environment: Environment): KelpieConfig {
  const walked = resolveMarkers(input, environment)
  const problems = [...walked.problems.map((problem) => (problem.path.length > 0 ? `${problem.path}: ${problem.message}` : problem.message))]

  // Even when problems exist, the walk still produced a partial object. Reshape
  // it now: any field a problem covered will be undefined, which is fine, since
  // we throw before returning.
  const resolved = walked.value as ResolvedInput

  const email = buildEmailConfig(resolved.email, problems)
  const rateLimit = buildRateLimitConfig(resolved.rateLimit)

  if (problems.length > 0) {
    throw new ConfigurationError(problems)
  }

  return {
    runtimeMode: resolved.runtimeMode,
    port: resolved.port,
    databaseUrl: resolved.databaseUrl,
    logLevel: resolved.logLevel,
    email,
    moduleConfigPath: resolved.moduleConfigPath,
    webBundleDirectory: resolved.webBundleDirectory,
    rateLimit,
    trustedProxyHopCount: resolved.trustedProxyHopCount ?? 0,
  }
}

interface ResolvedInput {
  readonly runtimeMode: RuntimeMode
  readonly port: number
  readonly databaseUrl: string
  readonly logLevel: LogLevel
  readonly webBundleDirectory?: string | undefined
  readonly moduleConfigPath?: string | undefined
  readonly trustedProxyHopCount?: number
  readonly email: ResolvedEmail
  readonly rateLimit?: ResolvedRateLimit
  readonly modules: readonly KelpieModule[]
}

interface ResolvedEmail {
  readonly provider: 'log' | 'smtp'
  readonly from: string
  readonly smtp?: {
    readonly host?: string
    readonly port?: number
    readonly secure?: boolean
    readonly user?: string
    readonly password?: string
  }
}

interface ResolvedRateLimit {
  readonly forms?: { readonly limit?: number; readonly windowSeconds?: number }
  readonly auth?: { readonly limit?: number; readonly windowSeconds?: number }
  readonly loginAccount?: { readonly limit?: number; readonly windowSeconds?: number }
  readonly api?: { readonly limit?: number; readonly windowSeconds?: number }
}

function buildEmailConfig(resolved: ResolvedEmail | undefined, problems: string[]): EmailConfig {
  // A missing `email.provider` is already recorded as a problem by the walker;
  // return a placeholder so `resolveKelpieConfig` reaches the throw below.
  if (resolved === undefined || resolved.provider === undefined) {
    return { EMAIL_PROVIDER: 'log', EMAIL_FROM: resolved?.from ?? '' }
  }

  if (resolved.provider === 'log') {
    return { EMAIL_PROVIDER: 'log', EMAIL_FROM: resolved.from }
  }

  const smtp = resolved.smtp ?? {}
  const host = smtp.host
  const port = smtp.port
  const secure = smtp.secure
  const user = smtp.user
  const password = smtp.password

  if (
    host === undefined ||
    port === undefined ||
    secure === undefined ||
    user === undefined ||
    password === undefined
  ) {
    if (host === undefined) {
      problems.push('email.smtp.host is required when email.provider is "smtp"')
    }
    if (port === undefined) {
      problems.push('email.smtp.port is required when email.provider is "smtp"')
    }
    if (secure === undefined) {
      problems.push('email.smtp.secure is required when email.provider is "smtp"')
    }
    if (user === undefined) {
      problems.push('email.smtp.user is required when email.provider is "smtp"')
    }
    if (password === undefined) {
      problems.push('email.smtp.password is required when email.provider is "smtp"')
    }

    return { EMAIL_PROVIDER: 'log', EMAIL_FROM: resolved.from }
  }

  return {
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: resolved.from,
    SMTP_HOST: host,
    SMTP_PORT: port,
    SMTP_SECURE: secure,
    SMTP_USER: user,
    SMTP_PASSWORD: password,
  }
}

function buildRateLimitConfig(resolved: ResolvedRateLimit | undefined): RateLimitConfig {
  return {
    forms: budget('forms', resolved?.forms),
    auth: budget('auth', resolved?.auth),
    loginAccount: budget('loginAccount', resolved?.loginAccount),
    api: budget('api', resolved?.api),
  }
}

function budget(
  key: keyof typeof RATE_LIMIT_DEFAULTS,
  input: { readonly limit?: number; readonly windowSeconds?: number } | undefined,
): { readonly limit: number; readonly windowMs: number } {
  const defaults = RATE_LIMIT_DEFAULTS[key]

  return {
    limit: input?.limit ?? defaults.limit,
    windowMs: (input?.windowSeconds ?? defaults.windowSeconds) * 1000,
  }
}
