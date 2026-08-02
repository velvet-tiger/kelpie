import { defineConfig } from 'vitest/config'

/**
 * Component tests need a DOM. happy-dom rather than jsdom: it starts in a
 * fraction of the time and the registry tests exercise React, not browser
 * quirks.
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
  },
})
