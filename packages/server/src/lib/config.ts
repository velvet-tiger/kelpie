import { z } from 'zod'

import { emailConfigSchema } from './email.ts'
import type { EmailConfig } from './email.ts'
import { describeValidationIssue } from './errors.ts'

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

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().max(65535),
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, { message: 'must be a postgres:// or postgresql:// connection string' }),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']),
  ...emailConfigSchema.shape,
})

/**
 * Parses an environment into a validated config.
 *
 * @param environment Raw variables, normally `process.env`.
 * @throws ConfigurationError listing every invalid or missing variable.
 */
export function loadConfig(environment: Environment): KelpieConfig {
  const result = environmentSchema.safeParse(environment)

  if (!result.success) {
    throw new ConfigurationError(result.error.issues.map(describeValidationIssue))
  }

  return {
    runtimeMode: result.data.NODE_ENV,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    logLevel: result.data.LOG_LEVEL,
    email: { EMAIL_PROVIDER: result.data.EMAIL_PROVIDER, EMAIL_FROM: result.data.EMAIL_FROM },
  }
}
