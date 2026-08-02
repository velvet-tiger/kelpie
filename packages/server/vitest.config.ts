import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Integration tests need `TEST_DATABASE_URL`. Locally it comes from the
 * repository `.env`; in CI it comes from the environment, where there is no
 * `.env` file to read.
 */
const environmentFile = fileURLToPath(new URL('../../.env', import.meta.url))

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
