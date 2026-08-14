import { z } from 'zod'

import { emailConfigSchema } from './email.ts'
import type { EmailConfig } from './email.ts'
import { describeValidationIssue } from './errors.ts'
import { rateLimitConfigFrom, rateLimitConfigSchema } from './rateLimit.ts'
import type { RateLimitConfig } from './rateLimit.ts'

/**
 * The single place the service reads environment variables. Every other module
 * receives configuration as an argument. Nothing defaults silently: a missing or
 * malformed variable stops boot with the full list of problems.
 */

export type Environment = Readonly<Record<string, string | undefined>>

export type RuntimeMode = 'development' | 'test' | 'production'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface KelpieConfig {
  readonly runtimeMode: RuntimeMode
  readonly port: number
  readonly databaseUrl: string
  readonly logLevel: LogLevel
  /** Transactional mail only. Roadmap decision 4: configured, never hardcoded. */
  readonly email: EmailConfig
  /**
   * Path to the deploy-time module override file (`lib/moduleConfig.ts`).
   * Undefined is the ordinary case: no file, so each workspace's own module
   * settings decide.
   */
  readonly moduleConfigPath: string | undefined
  /**
   * Directory holding the built web bundle, served from the same origin as the
   * API (`webBundle.ts`). Undefined is the development case: the Vite dev server
   * builds the pages and proxies the API, so there is no bundle on disk to serve.
   */
  readonly webBundleDirectory: string | undefined
  readonly rateLimit: RateLimitConfig
  /**
   * Accounts allowed onto the operator surface (`operator.ts`), lower-cased.
   * Empty means nobody: the surface fails closed, and a deployment that never
   * sets `SUPERUSER_EMAILS` simply has no operators.
   */
  readonly superuserEmails: ReadonlySet<string>
}

/** Thrown at boot when the environment cannot produce a valid configuration. */
export class ConfigurationError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'ConfigurationError'
    this.problems = problems
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'postgres:' || protocol === 'postgresql:'
  } catch {
    return false
  }
}

/**
 * Comma-separated emails. Blank counts as absent, the
 * `SECRET_ENCRYPTION_KEY_PREVIOUS` rule: operators empty a line far more often
 * than they delete it. Each entry is checked as an email address so a typo
 * stops boot naming the entry, rather than silently locking the intended
 * operator out.
 */
const superuserEmailsSchema = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined || value.trim().length === 0
      ? []
      : value.split(',').map((entry) => entry.trim()),
  )
  .superRefine((entries, context) => {
    for (const entry of entries) {
      if (!z.email().safeParse(entry).success) {
        context.addIssue({ code: 'custom', message: `"${entry}" is not an email address` })
      }
    }
  })
  .transform((entries): ReadonlySet<string> => new Set(entries.map((entry) => entry.toLowerCase())))

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().max(65535),
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, { message: 'must be a postgres:// or postgresql:// connection string' }),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']),
  KELPIE_MODULE_CONFIG_PATH: z.string().min(1).optional(),
  WEB_BUNDLE_DIR: z.string().min(1).optional(),
  SUPERUSER_EMAILS: superuserEmailsSchema,
  ...rateLimitConfigSchema.shape,
})

/**
 * Parses an environment into a validated config.
 *
 * `emailConfigSchema` is a discriminated union, so it is parsed separately
 * from the rest: a union has no flat `.shape` to spread into `environmentSchema`,
 * only its own `EMAIL_PROVIDER`-keyed branches. Problems from both parses are
 * combined into one error, preserving the "every missing variable at once" rule.
 *
 * @param environment Raw variables, normally `process.env`.
 * @throws ConfigurationError listing every invalid or missing variable.
 */
export function loadConfig(environment: Environment): KelpieConfig {
  const environmentResult = environmentSchema.safeParse(environment)
  const emailResult = emailConfigSchema.safeParse(environment)

  if (!environmentResult.success || !emailResult.success) {
    const problems = [
      ...(environmentResult.success ? [] : environmentResult.error.issues.map(describeValidationIssue)),
      ...(emailResult.success ? [] : emailResult.error.issues.map(describeValidationIssue)),
    ]

    throw new ConfigurationError(problems)
  }

  return {
    runtimeMode: environmentResult.data.NODE_ENV,
    port: environmentResult.data.PORT,
    databaseUrl: environmentResult.data.DATABASE_URL,
    logLevel: environmentResult.data.LOG_LEVEL,
    email: emailResult.data,
    moduleConfigPath: environmentResult.data.KELPIE_MODULE_CONFIG_PATH,
    webBundleDirectory: environmentResult.data.WEB_BUNDLE_DIR,
    rateLimit: rateLimitConfigFrom(environmentResult.data),
    superuserEmails: environmentResult.data.SUPERUSER_EMAILS,
  }
}
