import { defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Its own file so that Vitest does not pick up `vite.config.ts`, which roots the
 * project at `web/` for the browser build and would look for tests there. The
 * tests in this workspace cover the Node entry point and its launcher.
 */
export default defineConfig({
  /*
   * Resolve the `@kelpie/*` packages to their TypeScript source rather than the
   * JavaScript they compile to, so a test run never asserts against a stale or
   * missing `dist`. These tests run in Node, so it is the `ssr` resolver that
   * answers; `resolve` is set alongside it to keep the two in step.
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
    include: ['src/**/*.test.ts'],
  },
})
