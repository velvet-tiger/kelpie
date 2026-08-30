import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defaultServerConditions } from 'vite'
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
  /*
   * Resolve sibling workspace packages to their TypeScript source rather than
   * the JavaScript they compile to, so a test run never asserts against a stale
   * or missing `dist`.
   *
   * These tests run in Node, so it is the `ssr` resolver that answers, and
   * `externalConditions` alongside it because a symlinked workspace package can
   * be externalised and resolved by Node itself rather than inlined.
   */
  resolve: {
    conditions: ['kelpie-source', ...defaultServerConditions],
  },
  ssr: {
    resolve: {
      conditions: ['kelpie-source', ...defaultServerConditions],
      externalConditions: ['kelpie-source', ...defaultServerConditions],
    },
  },
  test: {
    env: process.env,
    /*
     * Test files run in parallel, and integration tests still never share
     * tables: `testDatabaseUrl` gives every Vitest worker its own database by
     * suffixing the configured name with the worker's pool id. The first file
     * a worker runs creates and migrates that database; later files reuse it.
     */
    /**
     * Vitest defaults to 5s, which is calibrated for a unit test that touches
     * nothing. Almost every test here makes several HTTP round trips into a
     * Postgres running in Docker.
     *
     * Measured on this suite: a typical test is 150-200ms and the slowest is
     * about 1.2s, so the default left only a fourfold margin over the slowest
     * case. One `workspace.test.ts` case duly timed out at 5052ms once, having
     * run in 160-222ms across eight repeats before and after. Nothing was wrong
     * with it; a laptop with other work on it stalled for a moment.
     *
     * 20s is roughly sixteen times the slowest measured test, which absorbs
     * that without hiding anything: a deadlocked query or a request that never
     * answers still fails, just twenty seconds later. Re-derive the number if
     * the suite's slow end moves rather than raising it again by feel.
     */
    testTimeout: 20_000,
    // The same reasoning. Every `beforeEach` here empties every table and
    // rebuilds the app, and the first `beforeAll` in a worker creates and
    // migrates a fresh database, against the default 10s.
    hookTimeout: 30_000,
  },
})
