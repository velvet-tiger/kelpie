import { defineConfig } from 'vitest/config'

/**
 * Its own file so that Vitest does not pick up `vite.config.ts`, which roots the
 * project at `web/` for the browser build and would look for tests there. The
 * tests in this workspace cover the Node entry point and its launcher.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
