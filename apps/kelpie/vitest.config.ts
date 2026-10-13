import { defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Vite's server conditions without `module`. Vitest passes
 * `ssr.resolve.conditions` to each Node worker as `--conditions`, and Node
 * never resolves with `module` when it runs the service, so a dependency's
 * `module` build can be one that Node cannot load.
 */
const nodeConditions = defaultServerConditions.filter((condition: string): boolean => condition !== 'module')

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
    conditions: ['kelpie-source', ...nodeConditions],
  },
  ssr: {
    resolve: {
      conditions: ['kelpie-source', ...nodeConditions],
      externalConditions: ['kelpie-source', ...nodeConditions],
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
