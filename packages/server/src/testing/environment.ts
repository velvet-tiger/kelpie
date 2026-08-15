import type { Environment } from '../lib/config.ts'

/**
 * The environment a test app boots with.
 *
 * Core modules validate their own slice of configuration during `register`, so
 * a suite that registers `coreModules` needs every variable they require. It
 * lives here rather than in each suite because a module adding a variable
 * should not mean editing twenty test files.
 */

/**
 * A fixed key, so a sealed value is reproducible across runs. It protects
 * nothing: every test database is truncated between cases, and no production
 * secret is ever sealed with it.
 */
export const TEST_SECRET_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

/** The base URL every emailed link is built from in tests. */
export const TEST_APP_BASE_URL = 'https://kelpie.test'

export const TEST_ENVIRONMENT: Environment = {
  NODE_ENV: 'test',
  SECRET_ENCRYPTION_KEY: TEST_SECRET_ENCRYPTION_KEY,
  APP_BASE_URL: TEST_APP_BASE_URL,
}
