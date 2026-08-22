import { smtpEmail } from '@kelpie/module-smtp-email'
import {
  appUrlConfigSchema,
  coreModules,
  defineKelpieConfig,
  fromEnv,
  secretEncryptionConfigSchema,
} from '@kelpie/server'
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
 * A handful of tuning keys (`WEBHOOK_DELIVERY_RETENTION_DAYS`,
 * `BLOCK_PRIVATE_EGRESS`) still reach their modules through
 * `context.config(schema)`, since the modules that read them are the only ones
 * that care. Lock them here through the `env` section if you need to.
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

  // Every log line writes to each entry in `destinations`. Stdout is the
  // default for this assembly. Add a destination by extending the
  // `LoggingDestination` union in `@kelpie/server` and placing an entry here.
  logging: {
    level: fromEnv('LOG_LEVEL', logLevel),
    destinations: [{ kind: 'stdout' }],
  },

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

  // The deployment's base URL, source of every emailed link (invite, password
  // reset, email verification). Reuses the same validator the workspace and
  // auth modules used before this field existed.
  appBaseUrl: fromEnv('APP_BASE_URL', appUrlConfigSchema.shape.APP_BASE_URL),

  // Keys that seal stored secrets (webhook signing keys, agent-task auth
  // headers). Rotate by moving the current key into `previousKey`, setting the
  // new key here, deploying, then running `npm run reseal`. See README.md.
  secretEncryption: {
    key: fromEnv('SECRET_ENCRYPTION_KEY', secretEncryptionConfigSchema.shape.SECRET_ENCRYPTION_KEY),
    previousKey: fromEnv<string | undefined>(
      'SECRET_ENCRYPTION_KEY_PREVIOUS',
      secretEncryptionConfigSchema.shape.SECRET_ENCRYPTION_KEY_PREVIOUS,
      undefined,
    ),
  },

  // `provider` picks a named sender from the runtime's registry: `'log'` is
  // built in, other names come from provider modules (`'smtp'` is registered
  // by `@kelpie/module-smtp-email`; `'resend'` or `'postmark'` would be
  // registered by their own modules). `from` is the address on every
  // outgoing message. Provider-specific config (SMTP host, an API key) lives
  // in the provider module and is read through `context.config(...)`.
  email: {
    provider: fromEnv('EMAIL_PROVIDER', z.string().min(1)),
    from: fromEnv('EMAIL_FROM', z.string().min(1)),
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
  //
  // `smtpEmail()` registers a provider named `'smtp'`. Set `EMAIL_PROVIDER=log`
  // to fall back to the built-in log sender (invites and password resets
  // write to the log instead of going out); the module can stay in the list
  // either way, since it only becomes the sender when `email.provider` picks
  // its name.
  modules: [...coreModules, smtpEmail()],
})
