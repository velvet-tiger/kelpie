import type { KelpieModule } from '../../runtime/module.ts'
import { CONSENT_PURPOSES_LIMIT } from './capabilities.ts'
import { consentPurposesEvents } from './events.ts'
import { mountConsentPurposesRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createConsentPurposesService } from './service.ts'
import { registerConsentPurposesTools } from './tools.ts'

/**
 * Consent purposes: the workspace catalog every capture site names.
 *
 * Structural because Person consent rows carry `purpose_id`, and forms /
 * forms / imports each reference one; a disabled module would leave those
 * references without a definition to resolve.
 *
 * Registers before people, forms, lists, and import-export so their `_fk`
 * targets are in the schema barrel when their own migrations reference them.
 */
export function createConsentPurposesModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'consent-purposes',
    requires: ['workspace'],
    structural: true,
    events: consentPurposesEvents,

    register(context) {
      context.entitlements.declare(CONSENT_PURPOSES_LIMIT)

      const service = createConsentPurposesService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        entitlements: context.entitlements,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountConsentPurposesRoutes(router, { db: context.db, now: context.now, service })
      })

      registerConsentPurposesTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}
