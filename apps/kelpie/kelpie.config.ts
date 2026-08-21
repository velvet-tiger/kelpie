import { coreModules, defineKelpieConfig, fromEnv } from '@kelpie/server'
import { z } from 'zod'

/**
 * The open-source assembly's configuration, and the only place it is declared.
 *
 * Every leaf is either a literal, committed to git and locked in for this
 * deployment, or `fromEnv(...)`, marking a leaf the environment fills in. A
 * self-hoster edits this file for anything that should not change per deploy,
 * and sets environment variables for anything that does (secrets, per-tier
 * limits, per-environment URLs).
 *
 * `resolveKelpieConfig(config, process.env)` at boot walks this object,
 * resolves markers, validates, and produces the typed `KelpieConfig` the app
 * runs on. Nothing in the app reads `process.env` for these fields after boot.
 *
 * Module configuration (auth, webhooks, secrets, egress) still reads its own
 * env keys through `context.config(schema)`. Migrating those into this file
 * is a separate pass.
 */

const runtimeMode = z.enum(['development', 'test', 'production'])
const logLevel = z.enum(['debug', 'info', 'warn', 'error'])
const positiveInt = z.coerce.number().int().positive()
const nonNegativeInt = z.coerce.number().int().nonnegative()
const port = positiveInt.max(65535)
const postgresUrl = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value)
      return protocol === 'postgres:' || protocol === 'postgresql:'
    } catch {
      return false
    }
  },
  { message: 'must be a postgres:// or postgresql:// connection string' },
)

export default defineKelpieConfig({
  runtimeMode: fromEnv('NODE_ENV', runtimeMode),
  port: fromEnv('PORT', port),
  databaseUrl: fromEnv('DATABASE_URL', postgresUrl),
  logLevel: fromEnv('LOG_LEVEL', logLevel),

  // Unset in development, where Vite serves the pages and proxies `/v1` here.
  // Set in a deployment, where nothing else would serve the built bundle.
  webBundleDirectory: fromEnv<string | undefined>('WEB_BUNDLE_DIR', z.string().min(1).optional(), undefined),

  // Path to the deploy-time module override file. Unset in the ordinary case,
  // where each workspace's own settings decide.
  moduleConfigPath: fromEnv<string | undefined>('KELPIE_MODULE_CONFIG_PATH', z.string().min(1).optional(), undefined),

  // How many trusted proxies stand in front of the service. Zero (the default)
  // means the socket address is the client. Positive reads the client IP from
  // `X-Forwarded-For`, trusting the header for that many hops.
  trustedProxyHopCount: fromEnv('TRUSTED_PROXY_HOP_COUNT', nonNegativeInt, 0),

  email: {
    provider: fromEnv('EMAIL_PROVIDER', z.enum(['log', 'smtp'])),
    from: fromEnv('EMAIL_FROM', z.string().min(1)),
    smtp: {
      host: fromEnv<string | undefined>('SMTP_HOST', z.string().min(1).optional(), undefined),
      port: fromEnv<number | undefined>('SMTP_PORT', port.optional(), undefined),
      secure: fromEnv<boolean | undefined>(
        'SMTP_SECURE',
        z
          .enum(['true', 'false'])
          .transform((value) => value === 'true')
          .optional(),
        undefined,
      ),
      user: fromEnv<string | undefined>('SMTP_USER', z.string().min(1).optional(), undefined),
      password: fromEnv<string | undefined>('SMTP_PASSWORD', z.string().min(1).optional(), undefined),
    },
  },

  // Budgets applied per `api.md`. Every leaf has a default in `lib/rateLimit.ts`;
  // override in code here, or with the env vars below.
  rateLimit: {
    forms: {
      limit: fromEnv('RATE_LIMIT_FORMS_LIMIT', positiveInt, 20),
      windowSeconds: fromEnv('RATE_LIMIT_FORMS_WINDOW_SECONDS', positiveInt, 60),
    },
    auth: {
      limit: fromEnv('RATE_LIMIT_AUTH_LIMIT', positiveInt, 10),
      windowSeconds: fromEnv('RATE_LIMIT_AUTH_WINDOW_SECONDS', positiveInt, 60),
    },
    loginAccount: {
      limit: fromEnv('RATE_LIMIT_LOGIN_ACCOUNT_LIMIT', positiveInt, 10),
      windowSeconds: fromEnv('RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS', positiveInt, 900),
    },
    api: {
      limit: fromEnv('RATE_LIMIT_API_LIMIT', positiveInt, 600),
      windowSeconds: fromEnv('RATE_LIMIT_API_WINDOW_SECONDS', positiveInt, 60),
    },
  },

  // Boot registers these in order, after resolving `requires`. An unknown id,
  // an unmet dependency, or invalid module config stops boot. The cloud
  // assembly keeps its own list in its own repo.
  modules: [...coreModules],
})
