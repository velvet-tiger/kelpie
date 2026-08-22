import {
  appUrlConfigSchema,
  coreModules,
  defineKelpieConfig,
  fromEnv,
  secretEncryptionConfigSchema,
} from '@kelpie/server'
import { z } from 'zod'

/**
 * Your Kelpie service's configuration, and the only place it is declared.
 *
 * Every leaf is either a literal, committed to git and locked in for this
 * deployment, or `fromEnv(...)`, marking a leaf the environment fills in. Edit
 * this file for anything that should not change per deploy, and set environment
 * variables (in `.env`, `.env.local`, or your process manager) for anything
 * that does (secrets, per-tier limits, per-environment URLs).
 *
 * `resolveKelpieConfig(config, process.env)` at boot walks this object,
 * resolves markers, validates, and produces the typed `KelpieConfig` the app
 * runs on. Nothing in the app reads `process.env` for these fields after boot.
 *
 * Add a module by installing it and putting it in the `modules` array below.
 * `coreModules` already includes the built-in `smtp-email` module; set
 * `EMAIL_PROVIDER=log` to fall back to the log sender.
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
  // default. Add a destination by extending the `LoggingDestination` union in
  // `@kelpie/server` and placing an entry here.
  logging: {
    level: fromEnv('LOG_LEVEL', logLevel),
    destinations: [{ kind: 'stdout' }],
  },

  webBundleDirectory: fromEnv<string | undefined>('WEB_BUNDLE_DIR', z.string().min(1).optional(), undefined),
  moduleConfigPath: fromEnv<string | undefined>('KELPIE_MODULE_CONFIG_PATH', z.string().min(1).optional(), undefined),
  trustedProxyHopCount: fromEnv('TRUSTED_PROXY_HOP_COUNT', nonNegativeInt, 0),

  // The deployment's base URL. Every emailed link (invite, password reset,
  // email verification) is built from it.
  appBaseUrl: fromEnv('APP_BASE_URL', appUrlConfigSchema.shape.APP_BASE_URL),

  // Keys that seal stored secrets. Generate one with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  // To rotate, set the current key as `previousKey`, put the new key here,
  // deploy, then run `npm run reseal`.
  secretEncryption: {
    key: fromEnv('SECRET_ENCRYPTION_KEY', secretEncryptionConfigSchema.shape.SECRET_ENCRYPTION_KEY),
    previousKey: fromEnv<string | undefined>(
      'SECRET_ENCRYPTION_KEY_PREVIOUS',
      secretEncryptionConfigSchema.shape.SECRET_ENCRYPTION_KEY_PREVIOUS,
      undefined,
    ),
  },

  // `provider` picks a named sender from the runtime's registry: `'log'` is
  // built in and writes the message to the log instead of sending it. `'smtp'`
  // is registered by the built-in `smtp-email` core module and reads the
  // `SMTP_*` variables at boot when it is picked. Other names come from
  // third-party provider modules (Resend, Postmark) added to `modules` below.
  // `from` is the address on every outgoing message.
  email: {
    provider: fromEnv('EMAIL_PROVIDER', z.string().min(1)),
    from: fromEnv('EMAIL_FROM', z.string().min(1)),
  },

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

  // `coreModules` already includes the built-in `smtp-email` module, which
  // registers a `'smtp'` provider. Set `EMAIL_PROVIDER=log` to fall back to
  // the built-in log sender; the `smtp-email` module only reads the SMTP
  // environment when `email.provider` picks its name.
  modules: [...coreModules],
})
