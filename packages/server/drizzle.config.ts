import { defineConfig } from 'drizzle-kit'

/**
 * Generates the core migration pipeline from the schema barrel.
 *
 * `DATABASE_URL` is only used by `drizzle-kit push` and `studio`. Generating
 * migrations reads the schema, not the database, and the service applies them at
 * boot rather than through drizzle-kit.
 */
const databaseUrl = process.env.DATABASE_URL

if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL is not set. Run drizzle-kit through `npm run db:generate` from the repository root.')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: databaseUrl },
  casing: 'snake_case',
  verbose: true,
  strict: true,
})
