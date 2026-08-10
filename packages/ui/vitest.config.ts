import { defaultClientConditions } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Component tests need a DOM. happy-dom rather than jsdom: it starts in a
 * fraction of the time and the registry tests exercise React, not browser
 * quirks.
 */
export default defineConfig({
  // Resolve sibling workspace packages to their TypeScript source rather than
  // the JavaScript they compile to, so a test run never asserts against a stale
  // or missing `dist`.
  resolve: {
    conditions: ['kelpie-source', ...defaultClientConditions],
  },
  test: {
    environment: 'happy-dom',
  },
})
