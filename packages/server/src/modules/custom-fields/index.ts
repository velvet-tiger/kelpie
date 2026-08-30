import type { KelpieModule } from '../../runtime/module.ts'
import { CUSTOM_FIELDS_LIMIT } from './capabilities.ts'
import { customFieldsEvents } from './events.ts'
import { mountCustomFieldsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createCustomFieldDefinitionsService } from './service.ts'
import { registerCustomFieldsTools } from './tools.ts'

/**
 * Custom fields: workspace-defined attributes for the six taggable record
 * types. Structural because records carry values keyed by definition key, so a
 * disabled module would leave the values on records with no way to read them.
 *
 * Requires the six object modules only for schema visibility: the strip-on-
 * delete pass reads their tables through `stripKeyFromRecords`, and drizzle-kit
 * needs the barrel to see them registered before this module's schema loads.
 * Runtime dependency runs the other way — the six modules `requires` this one
 * so the validator is present when they register.
 *
 * Exports the values factory so the six object modules can inject it into
 * their services (`createCustomFieldValues` is the cross-module seam here).
 */
export {
  createCustomFieldValues,
} from './values.ts'
export type {
  CustomFieldValuesValidator,
  CustomFieldsMerge,
  StoredCustomFieldValue,
} from './values.ts'

export function createCustomFieldsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'custom-fields',
    requires: ['workspace'],
    structural: true,
    events: customFieldsEvents,

    register(context) {
      context.entitlements.declare(CUSTOM_FIELDS_LIMIT)

      const service = createCustomFieldDefinitionsService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        entitlements: context.entitlements,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountCustomFieldsRoutes(router, { db: context.db, now: context.now, service })
      })

      registerCustomFieldsTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}
