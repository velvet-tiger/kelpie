import { defineConfig } from 'drizzle-kit'

/**
 * Generates migrations for the optional `ai` module.
 *
 * The module is not in `coreModules`, so its tables cannot join core's shared
 * pipeline: an assembly that does not list the module must not get them. It
 * has its own directory and, at boot, its own `__drizzle_migrations_ai` table.
 *
 * The first four migrations began in the cloud assembly and keep their journal
 * timestamps, so a database that already applied them there skips them here.
 *
 *     npm run db:generate:ai
 */
const databaseUrl = process.env.DATABASE_URL

if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL is not set. Run drizzle-kit through `npm run db:generate:ai` from the repository root.')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/ai/schema.ts',
  out: './module-migrations/ai',
  dbCredentials: { url: databaseUrl },
  casing: 'snake_case',
  verbose: true,
  strict: true,
})
