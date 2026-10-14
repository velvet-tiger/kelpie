import { createEgressGuard, egressConfigSchema } from '../../lib/egress.ts'
import { createSecretCipher, secretEncryptionConfigSchema } from '../../lib/secrets.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import {
  createDeliveryFanOut,
  createHttpSender,
  defineDeliveryJob,
  deliveryRetentionConfigSchema,
} from './delivery.ts'
import type { SendDelivery } from './delivery.ts'
import { webhookLimitsConfigSchema } from './limits.ts'
import { subscribeDeliverableEvents } from './payloads.ts'
import { mountWebhooksRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createWebhooksService } from './service.ts'
import { registerWebhooksTools } from './tools.ts'

/**
 * Webhooks: registration, and delivery, which bridges the internal event bus
 * to outbound HTTP through the `webhooks.deliver` job (`delivery.ts`).
 *
 * `requires` is `workspace` alone. The engine consumes events by name and never
 * reads the tables behind them, so it does not depend on the modules that emit
 * them — a payload carries the record's type and id and nothing else, which is
 * what keeps this module from growing a dependency on every CRM module in turn.
 *
 * Subscription happens during `register`, and this module sits near the end
 * of the core order, so every emitting module is already in
 * place. Nothing depends on that: the bus resolves handlers at publication.
 */
export interface WebhooksModuleOptions {
  /** Injected by tests so no suite makes a network call. */
  readonly send?: SendDelivery
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
      // should stop boot, not prune by the wrong window. The registration
      // limit too: a bad value should stop boot, not run with no limit.
      //
      // Prefer the top-level `secretEncryption` from the assembly's
      // kelpie.config.ts; fall back to the schema read for older assemblies
      // that don't declare it.
      const cipher = createSecretCipher(context.secretEncryption ?? context.config(secretEncryptionConfigSchema))
      const retention = context.config(deliveryRetentionConfigSchema)
      const limits = context.config(webhookLimitsConfigSchema)
      const egress = createEgressGuard(context.config(egressConfigSchema))

      const service = createWebhooksService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        cipher,
        maxPerWorkspace: limits.WEBHOOK_MAX_PER_WORKSPACE,
      })

      const deliveryJob = context.jobs.define(
        defineDeliveryJob({
          db: context.db,
          transaction: context.transaction,
          now: context.now,
          cipher,
          send: options.send ?? createHttpSender(egress),
          retentionDays: retention.WEBHOOK_DELIVERY_RETENTION_DAYS,
          log: context.log,
        }),
      )
      const fanOut = createDeliveryFanOut({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        deliveryJob,
      })

      context.schema(schema, migrationsDirectory)
      subscribeDeliverableEvents(context.events, (payload) => fanOut.enqueue(payload))

      context.routes((router) => {
        mountWebhooksRoutes(router, { db: context.db, now: context.now, service })
      })

      registerWebhooksTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}
