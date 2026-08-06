import { createSecretCipher, secretEncryptionConfigSchema } from '../../lib/secrets.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import {
  createDeliveryEngine,
  createHttpSender,
  deliveryRetentionConfigSchema,
  sleepFor,
} from './delivery.ts'
import type { SendDelivery, Sleep } from './delivery.ts'
import { subscribeDeliverableEvents } from './payloads.ts'
import { mountWebhooksRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createWebhooksService } from './service.ts'
import { registerWebhooksTools } from './tools.ts'

/**
 * Webhooks: registration, and the engine that bridges the internal event bus to
 * outbound HTTP.
 *
 * `requires` is `workspace` alone. The engine consumes events by name and never
 * reads the tables behind them, so it does not depend on the modules that emit
 * them — a payload carries the record's type and id and nothing else, which is
 * what keeps this module from growing a dependency on every CRM module in turn.
 *
 * Subscription happens during `register`, and `architecture.md` fixes this
 * module near the end of the core order, so every emitting module is already in
 * place. Nothing depends on that: the bus resolves handlers at publication.
 */
export interface WebhooksModuleOptions {
  /** Injected by tests so no suite makes a network call. */
  readonly send?: SendDelivery
  /** Injected by tests so no suite spends the retry budget in real time. */
  readonly sleep?: Sleep
}

export function createWebhooksModule(
  migrationsDirectory: string,
  options: WebhooksModuleOptions = {},
): KelpieModule {
  return {
    id: 'webhooks',
    requires: ['workspace'],

    register(context) {
      // Validated at boot rather than on the first delivery: a missing or
      // malformed key means no webhook can ever be signed, and finding that out
      // when a customer's endpoint goes quiet is far too late. The retention
      // window is validated the same way for the same reason — a bad value
      // should stop boot, not prune by the wrong window.
      const cipher = createSecretCipher(context.config(secretEncryptionConfigSchema))
      const retention = context.config(deliveryRetentionConfigSchema)

      const service = createWebhooksService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        cipher,
      })

      const engine = createDeliveryEngine({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        cipher,
        send: options.send ?? createHttpSender(),
        sleep: options.sleep ?? sleepFor,
        retentionDays: retention.WEBHOOK_DELIVERY_RETENTION_DAYS,
        log: context.log,
      })

      context.schema(schema, migrationsDirectory)
      subscribeDeliverableEvents(context.events, (payload) => engine.deliver(payload))

      context.routes((router) => {
        mountWebhooksRoutes(router, { db: context.db, now: context.now, service })
      })

      registerWebhooksTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}
