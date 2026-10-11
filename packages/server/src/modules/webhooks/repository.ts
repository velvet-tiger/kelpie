import type { WebhookDeliveryStatus, WebhookEvent, WebhookStatus } from '@kelpie/schemas'
import { and, arrayContains, count, desc, eq, inArray, lt, ne } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import type { Queryable, Transaction } from '../../runtime/transaction.ts'
import { workspaces } from '../workspace/schema.ts'
import { webhookDeliveries, webhooks } from './schema.ts'

export type WebhookRecord = typeof webhooks.$inferSelect
export type WebhookColumns = typeof webhooks.$inferInsert
export type DeliveryRecord = typeof webhookDeliveries.$inferSelect
export type DeliveryColumns = typeof webhookDeliveries.$inferInsert

export const WEBHOOK_SORTS: SortableFields<WebhookRecord> = {
  created_at: timestampSort(webhooks.createdAt, (webhook) => webhook.createdAt),
  updated_at: timestampSort(webhooks.updatedAt, (webhook) => webhook.updatedAt),
}

export const DEFAULT_WEBHOOK_SORT = '-created_at'

export const DELIVERY_SORTS: SortableFields<DeliveryRecord> = {
  created_at: timestampSort(webhookDeliveries.createdAt, (delivery) => delivery.createdAt),
}

/** Newest first: a delivery log is read to find out what just happened. */
export const DEFAULT_DELIVERY_SORT = '-created_at'

export interface WebhookFilters {
  readonly status?: WebhookStatus | undefined
}

export interface DeliveryFilters {
  readonly status?: WebhookDeliveryStatus | undefined
}

/** The last settled delivery for one webhook, as the list view reports it. */
export interface LastDelivery {
  readonly at: Date
  readonly status: WebhookDeliveryStatus
}

function conditionsFor(workspaceId: string, filters: WebhookFilters): (SQL | undefined)[] {
  return [
    eq(webhooks.workspaceId, workspaceId),
    filters.status === undefined ? undefined : eq(webhooks.status, filters.status),
  ]
}

export function listWebhooks(
  db: Queryable,
  workspaceId: string,
  filters: WebhookFilters,
  window: ListWindow<WebhookRecord>,
): Promise<WebhookRecord[]> {
  return db
    .select()
    .from(webhooks)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, webhooks.id)))
    .orderBy(...orderByWindow(window, webhooks.id))
    .limit(window.fetchLimit)
}

export async function findWebhook(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<WebhookRecord | undefined> {
  const [found] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.id, id)))
    .limit(1)

  return found
}

/**
 * The registrations one event should reach.
 *
 * `paused` is excluded and `failing` is not: pausing is the customer saying
 * stop, while failing is a report on the endpoint. A failing webhook keeps
 * being tried, which is the only way it can return to `active` by itself.
 */
export function listSubscribed(
  db: Queryable,
  workspaceId: string,
  event: WebhookEvent,
): Promise<WebhookRecord[]> {
  return db
    .select()
    .from(webhooks)
    .where(
      and(
        eq(webhooks.workspaceId, workspaceId),
        ne(webhooks.status, 'paused'),
        arrayContains(webhooks.events, [event]),
      ),
    )
}

/**
 * The most recent settled delivery per webhook, for the `last_delivery_*` fields.
 *
 * Derived rather than stored. The `webhooks` table has no delivery columns,
 * and a denormalised copy of the log's newest row is a second source of truth
 * that can only ever drift from it.
 *
 * @param webhookIds At most one page of ids, so the `in` list is bounded by the
 *   same ceiling `?limit=` is.
 */
export async function findLastDeliveries(
  db: Queryable,
  webhookIds: readonly string[],
): Promise<ReadonlyMap<string, LastDelivery>> {
  if (webhookIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .selectDistinctOn([webhookDeliveries.webhookId], {
      webhookId: webhookDeliveries.webhookId,
      createdAt: webhookDeliveries.createdAt,
      status: webhookDeliveries.status,
    })
    .from(webhookDeliveries)
    .where(inArray(webhookDeliveries.webhookId, [...webhookIds]))
    // The id breaks a tie: several deliveries of one event land in the same
    // millisecond, and ULIDs order by creation within one.
    .orderBy(webhookDeliveries.webhookId, desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))

  return new Map(rows.map((row) => [row.webhookId, { at: row.createdAt, status: row.status }]))
}

/**
 * Makes the caller's transaction the only one that registers a webhook in this
 * workspace, until it ends.
 *
 * A registration is refused from a count, and two that count at the same time
 * both see room for one more. Count after this returns; a count from before it
 * may be out of date.
 *
 * The lock is on the workspace row, at `NO KEY UPDATE` strength, the same lock
 * a membership change takes. A stronger lock would also stop every insert of a
 * row that refers to the workspace, which is each write to it. A lock on the
 * workspace's webhook rows would not do: a workspace with none has no row to
 * lock.
 */
export async function lockRegistrations(tx: Transaction, workspaceId: string): Promise<void> {
  await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('no key update')
}

/** How many webhooks the workspace has, in every status. A paused one still holds its place. */
export async function countWebhooks(db: Queryable, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(webhooks)
    .where(eq(webhooks.workspaceId, workspaceId))

  if (row === undefined) {
    throw new Error(`Counting the webhooks of workspace ${workspaceId} returned no row`)
  }

  return row.total
}

export async function insertWebhook(db: Queryable, values: WebhookColumns): Promise<WebhookRecord> {
  const [created] = await db.insert(webhooks).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting webhook ${values.id} returned no row`)
  }

  return created
}

export async function updateWebhook(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<WebhookColumns>,
): Promise<WebhookRecord | undefined> {
  const [updated] = await db
    .update(webhooks)
    .set(changes)
    .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.id, id)))
    .returning()

  return updated
}

/**
 * Moves a webhook between `active` and `failing` after a delivery settles.
 *
 * Never out of `paused`. Pausing is the admin's, and a delivery that began
 * before the pause can settle after it. The condition is in the statement and
 * not in a read before it, so no pause can land between the two. A status
 * that is already right is left alone as well, which keeps a healthy endpoint
 * from being rewritten on every event.
 *
 * Deliberately does not touch `updated_at`. That column answers "when did
 * somebody last change this registration", and a customer compares it against
 * `last_delivery_at` to see whether their fix took effect. The engine moving it
 * would destroy that comparison.
 */
export async function setWebhookStatus(
  db: Queryable,
  id: string,
  status: Exclude<WebhookStatus, 'paused'>,
): Promise<void> {
  await db
    .update(webhooks)
    .set({ status })
    .where(and(eq(webhooks.id, id), ne(webhooks.status, 'paused'), ne(webhooks.status, status)))
}

/**
 * Keeps a webhook from being deleted until the caller's transaction ends.
 *
 * A delivery row refers to its webhook, and the webhook can be deleted while
 * the delivery retries. The engine holds the row first, so it knows
 * whether there is still a log to write to before it writes.
 *
 * `KEY SHARE` is the lock the foreign key takes for the insert that follows.
 * It stops a delete and nothing else: a pause or a rotation goes ahead.
 *
 * @returns False when the webhook is gone.
 */
export async function holdWebhook(tx: Transaction, workspaceId: string, id: string): Promise<boolean> {
  const held = await tx
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.id, id)))
    .for('key share')

  return held.length > 0
}

export async function deleteWebhook(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(webhooks)
    .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.id, id)))
    .returning({ id: webhooks.id })

  return deleted.length
}

export async function insertDelivery(
  db: Queryable,
  values: DeliveryColumns,
): Promise<DeliveryRecord> {
  const [created] = await db.insert(webhookDeliveries).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting webhook delivery ${values.id} returned no row`)
  }

  return created
}

/**
 * Deletes this webhook's log rows older than the cutoff.
 *
 * Scoped to one webhook rather than the workspace so the delete walks
 * `webhook_deliveries_webhook_idx` — the workspace column has no index here,
 * and the engine calls this on every recorded delivery.
 *
 * @returns How many rows went, for the engine's log line.
 */
export async function deleteExpiredDeliveries(
  db: Queryable,
  webhookId: string,
  before: Date,
): Promise<number> {
  const deleted = await db
    .delete(webhookDeliveries)
    .where(and(eq(webhookDeliveries.webhookId, webhookId), lt(webhookDeliveries.createdAt, before)))
    .returning({ id: webhookDeliveries.id })

  return deleted.length
}

export function listDeliveries(
  db: Queryable,
  workspaceId: string,
  webhookId: string,
  filters: DeliveryFilters,
  window: ListWindow<DeliveryRecord>,
): Promise<DeliveryRecord[]> {
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.workspaceId, workspaceId),
        eq(webhookDeliveries.webhookId, webhookId),
        filters.status === undefined ? undefined : eq(webhookDeliveries.status, filters.status),
        keysetCondition(window, webhookDeliveries.id),
      ),
    )
    .orderBy(...orderByWindow(window, webhookDeliveries.id))
    .limit(window.fetchLimit)
}
