/**
 * Every core table, in one namespace.
 *
 * Tables are defined in the module that owns them; this barrel is what Drizzle
 * and drizzle-kit read. Modules outside core bring their own schema and their own
 * migrations directory through `context.schema()`.
 */

export * from '../modules/auth/schema.ts'
export * from '../modules/workspace/schema.ts'
export * from '../modules/api-keys/schema.ts'
export * from '../modules/people/schema.ts'
export * from '../modules/companies/schema.ts'
export * from '../modules/positions/schema.ts'
export * from '../modules/pipelines/schema.ts'
export * from '../modules/deals/schema.ts'
export * from '../modules/opportunities/schema.ts'
export * from '../modules/partnerships/schema.ts'
export * from '../modules/raises/schema.ts'
export * from '../modules/hiring/schema.ts'
export * from '../modules/plans/schema.ts'
export * from '../modules/decisions/schema.ts'
export * from '../modules/notes/schema.ts'
export * from '../modules/activities/schema.ts'
export * from '../modules/handbook/schema.ts'
export * from '../modules/forms/schema.ts'
export * from '../modules/import-export/schema.ts'
export * from '../modules/agent-tasks/schema.ts'
export * from '../modules/webhooks/schema.ts'
export * from '../modules/integrations/schema.ts'
