import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/** Outbound HTTP deliveries driven by the internal event bus. */
export const webhooks = pgTable(
  'webhooks',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    events: text('events').array().notNull().default([]),
    secretHash: text('secret_hash').notNull(),
    secretPrefix: text('secret_prefix').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('webhooks_workspace_idx').on(table.workspaceId),
    check('webhooks_status_check', sql`${table.status} in ('active', 'failing', 'paused')`),
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
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: moment('delivered_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('webhook_deliveries_webhook_idx').on(table.webhookId),
    check('webhook_deliveries_status_check', sql`${table.status} in ('success', 'failed')`),
  ],
)
