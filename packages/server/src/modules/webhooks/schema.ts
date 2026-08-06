import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENTS,
  WEBHOOK_STATUSES,
} from '@kelpie/schemas'
import type { WebhookDeliveryStatus, WebhookEvent, WebhookStatus } from '@kelpie/schemas'
import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

export { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENTS, WEBHOOK_STATUSES }
export type { WebhookDeliveryStatus, WebhookEvent, WebhookStatus }

/** Outbound HTTP deliveries driven by the internal event bus. */
export const webhooks = pgTable(
  'webhooks',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    events: text('events').array().$type<WebhookEvent[]>().notNull().default([]),
    /**
     * The signing secret, sealed by `lib/secrets.ts`.
     *
     * Not a hash, unlike every other secret in the schema, because `api.md`
     * signs each delivery *with* this secret and the receiver holds the
     * plaintext we showed them once. A hash could never produce a signature
     * anything off the shelf can verify.
     */
    secretEncrypted: text('secret_encrypted').notNull(),
    secretPrefix: text('secret_prefix').notNull(),
    /**
     * The secret this one replaced, kept only while a rotation overlaps.
     *
     * Set when a customer rotates and asks for an overlap window, so a delivery
     * carries a signature under both secrets and an endpoint that has not been
     * redeployed yet still verifies. Null the rest of the time, which is every
     * webhook that has never rotated and every rotation taken immediately.
     */
    previousSecretEncrypted: text('previous_secret_encrypted'),
    /** When the value above stops being signed with. Null together with it. */
    previousSecretExpiresAt: moment('previous_secret_expires_at'),
    status: text('status').$type<WebhookStatus>().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('webhooks_workspace_idx').on(table.workspaceId),
    checkOneOf('webhooks_status_check', table.status, WEBHOOK_STATUSES),
  ],
)

/** Append-only delivery log, pruned by retention rather than updated. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').$type<WebhookEvent>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<WebhookDeliveryStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: moment('delivered_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('webhook_deliveries_webhook_idx').on(table.webhookId),
    checkOneOf('webhook_deliveries_status_check', table.status, WEBHOOK_DELIVERY_STATUSES),
  ],
)
