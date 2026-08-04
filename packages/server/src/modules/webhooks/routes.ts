import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENTS,
  WEBHOOK_SETTABLE_STATUSES,
  WEBHOOK_STATUSES,
} from '@kelpie/schemas'
import type { WebhookDeliveryStatus, WebhookStatus } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { CreatedWebhookView, DeliveryView, WebhooksService, WebhookView } from './service.ts'
import { urlProblem } from './url.ts'

/**
 * Wire shapes for `/v1/webhooks`.
 *
 * Bodies are strict: `api.md` makes an unknown field a 422 rather than
 * something dropped in silence.
 */

const urlField = z.string().refine((value) => urlProblem(value) === undefined, {
  error: (issue) => urlProblem(String(issue.input))?.message ?? 'Invalid URL',
})

/**
 * At least one event, and no repeats.
 *
 * A registration subscribed to nothing is a row that can never fire, and a
 * repeated name would deliver the same event twice to the same endpoint. Both
 * are almost certainly a mistake in the caller rather than an intent.
 */
const eventsField = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1, { error: 'Subscribe to at least one event' })
  .refine((events) => new Set(events).size === events.length, {
    error: 'Each event may be listed once',
  })

const createBody = z.strictObject({
  url: urlField,
  events: eventsField,
})

/**
 * `status` takes `active` and `paused` only. `failing` is what the delivery
 * engine reports about the endpoint, so accepting it here would let a caller
 * assert something only a delivery attempt can establish.
 */
const updateBody = z
  .strictObject({
    url: urlField,
    events: eventsField,
    status: z.enum(WEBHOOK_SETTABLE_STATUSES),
  })
  .partial()

export interface WebhooksRoutesDependencies extends CredentialDependencies {
  readonly service: WebhooksService
}

export function webhookResponse(webhook: WebhookView): Record<string, unknown> {
  return {
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    secret_prefix: webhook.secretPrefix,
    status: webhook.status,
    last_delivery_at: webhook.lastDeliveryAt === null ? null : webhook.lastDeliveryAt.toISOString(),
    last_delivery_status: webhook.lastDeliveryStatus,
    created_at: webhook.createdAt.toISOString(),
    updated_at: webhook.updatedAt.toISOString(),
  }
}

function createdWebhookResponse(webhook: CreatedWebhookView): Record<string, unknown> {
  return { ...webhookResponse(webhook), secret: webhook.secret }
}

function deliveryResponse(delivery: DeliveryView): Record<string, unknown> {
  return {
    id: delivery.id,
    webhook_id: delivery.webhookId,
    event: delivery.event,
    payload: delivery.payload,
    status: delivery.status,
    attempts: delivery.attempts,
    delivered_at: delivery.deliveredAt === null ? null : delivery.deliveredAt.toISOString(),
    created_at: delivery.createdAt.toISOString(),
  }
}

/**
 * Reads a `?status=` filter against a fixed list.
 *
 * @throws AppError 422 for a value that is not a status. Answering it with an
 *   empty list would read as "none in that state" rather than "no such state".
 */
function readStatusFilter<Status extends string>(
  context: Context,
  statuses: readonly [Status, ...Status[]],
): Status | undefined {
  const raw = context.req.query('status')

  if (raw === undefined) {
    return undefined
  }

  const parsed = z.enum(statuses).safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed('That is not a status', [
      { field: 'status', message: `Use one of: ${statuses.join(', ')}` },
    ])
  }

  return parsed.data
}

export function mountWebhooksRoutes(router: Hono, dependencies: WebhooksRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/webhooks', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      { status: readStatusFilter<WebhookStatus>(context, WEBHOOK_STATUSES) },
      readListParameters(context),
    )

    return context.json(pageBody(page, webhookResponse))
  })

  /** The response carries `secret`. No later request can retrieve it. */
  router.post('/webhooks', async (context) => {
    const body = await readJsonBody(context, createBody)
    const webhook = await dependencies.service.create(await requireActor(context), {
      url: body.url,
      events: body.events,
    })

    return context.json(createdWebhookResponse(webhook), 201)
  })

  router.get('/webhooks/:id', async (context) => {
    const webhook = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(webhookResponse(webhook))
  })

  router.patch('/webhooks/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const webhook = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      body,
    )

    return context.json(webhookResponse(webhook))
  })

  router.delete('/webhooks/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  /**
   * The delivery log for one webhook. Nested, like a form's submissions: a
   * delivery only means anything against the registration that produced it.
   */
  router.get('/webhooks/:id/deliveries', async (context) => {
    const page = await dependencies.service.listDeliveries(
      await requireActor(context),
      context.req.param('id'),
      { status: readStatusFilter<WebhookDeliveryStatus>(context, WEBHOOK_DELIVERY_STATUSES) },
      readListParameters(context),
    )

    return context.json(pageBody(page, deliveryResponse))
  })
}
