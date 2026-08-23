import { describe, expect, it } from 'vitest'

import { bootAssembly } from './boot.ts'
import type { KelpieConfigInput } from './lib/kelpieConfigFile.ts'
import { coreModules } from './modules/core.ts'
import { TEST_ENVIRONMENT } from './testing/environment.ts'

/**
 * Never opened. postgres.js connects lazily and registration issues no query,
 * so `bootAssembly` reaches its return without a live database. A test that
 * queried by accident would fail on connect rather than pass against nothing.
 */
const UNUSED_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused'

function testConfig(): KelpieConfigInput {
  return {
    runtimeMode: 'production',
    port: 0,
    databaseUrl: UNUSED_DATABASE_URL,
    logging: { level: 'error', destinations: [] },
    email: { provider: 'log', from: 'kelpie-test@example.com' },
    modules: coreModules,
  }
}

describe('bootAssembly', () => {
  it('registers the configured modules and collects every migrations directory', async () => {
    const boot = await bootAssembly(testConfig(), TEST_ENVIRONMENT)

    try {
      expect(boot.contributions.schemas.length).toBeGreaterThan(0)
      // Each contribution names a directory the migrate step will apply. An
      // empty one would make `runMigrations` skip a module's tables silently.
      for (const schema of boot.contributions.schemas) {
        expect(schema.migrationsDir.length).toBeGreaterThan(0)
      }
    } finally {
      await boot.database.close()
    }
  })

  it('returns the collaborators both entry points build on', async () => {
    const boot = await bootAssembly(testConfig(), TEST_ENVIRONMENT)

    try {
      expect(boot.config.port).toBe(0)
      expect(typeof boot.createId).toBe('function')
      expect(boot.credentials.db).toBe(boot.database.db)
    } finally {
      await boot.database.close()
    }
  })
})
