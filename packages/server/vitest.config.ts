import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Integration tests need `TEST_DATABASE_URL`. Locally it comes from the
 * repository `.env`, with the database port `make up` resolved layered over it
 * in `.env.local`; in CI it comes from the environment, where there is neither
 * file to read.
 *
 * `.env.local` is read first because `loadEnvFile` keeps the first value it
 * sees. A variable already in the environment beats both, which is what lets CI
 * point the suite at its own database.
 */
const environmentFile = fileURLToPath(new URL('../../.env', import.meta.url))
const localEnvironmentFile = fileURLToPath(new URL('../../.env.local', import.meta.url))

if (existsSync(localEnvironmentFile)) {
  process.loadEnvFile(localEnvironmentFile)
}

if (existsSync(environmentFile)) {
  process.loadEnvFile(environmentFile)
}

export default defineConfig({
  test: {
    env: process.env,
    // Integration tests share one Postgres database and truncate between cases,
    // so they cannot run in parallel with each other.
    fileParallelism: false,
  },
})
