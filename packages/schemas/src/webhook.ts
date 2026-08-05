import { z } from 'zod'

import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENTS, WEBHOOK_STATUSES } from './values.ts'
import type {
  WebhookDeliveryStatus,
  WebhookEvent,
  WebhookSettableStatus,
  WebhookStatus,
} from './values.ts'
import { definedFields, idSchema, nullableTimestampSchema, timestampSchema } from './wire.ts'

/**
 * Wire and write shapes for `/v1/webhooks`.
 *
 * The signing secret appears exactly once, in the `201` that creates the
 * webhook, and never again — the same contract API keys have. Every later read
 * carries only `secret_prefix`, which is enough to tell two registrations
 * apart in a list and useless to anyone who intercepts it.
 */

export interface Webhook {
  readonly id: string
  readonly url: string
  readonly events: readonly WebhookEvent[]
  /** The leading characters of the secret, for recognising a registration. */
  readonly secretPrefix: string
  readonly status: WebhookStatus
  /** Derived from the delivery log, not stored: null until the first delivery settles. */
  readonly lastDeliveryAt: Date | null
  readonly lastDeliveryStatus: WebhookDeliveryStatus | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** The one response that carries the signing secret. Nothing can retrieve it later. */
export interface CreatedWebhook extends Webhook {
  readonly secret: string
}

/** One settled delivery: an event sent to one webhook, after its retries. */
export interface WebhookDelivery {
  readonly id: string
  readonly webhookId: string
  readonly event: WebhookEvent
  /** Exactly the JSON that was signed and sent. */
  readonly payload: unknown
  readonly status: WebhookDeliveryStatus
  /** How many HTTP requests it took. At least 1; more means retries. */
  readonly attempts: number
  /** When it succeeded, null when it never did. */
  readonly deliveredAt: Date | null
  readonly createdAt: Date
}

const webhookWire = {
  id: idSchema,
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  secret_prefix: z.string(),
  status: z.enum(WEBHOOK_STATUSES),
  last_delivery_at: nullableTimestampSchema,
  last_delivery_status: z.enum(WEBHOOK_DELIVERY_STATUSES).nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}

const webhookWireSchema = z.object(webhookWire)

function toWebhook(wire: z.output<typeof webhookWireSchema>): Webhook {
  return {
    id: wire.id,
    url: wire.url,
    events: wire.events,
    secretPrefix: wire.secret_prefix,
    status: wire.status,
    lastDeliveryAt: wire.last_delivery_at,
    lastDeliveryStatus: wire.last_delivery_status,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
  }
}

export const webhookSchema: z.ZodType<Webhook, unknown> = webhookWireSchema.transform(toWebhook)

export const createdWebhookSchema: z.ZodType<CreatedWebhook, unknown> = z
  .object({ ...webhookWire, secret: z.string() })
  .transform((wire): CreatedWebhook => ({ ...toWebhook(wire), secret: wire.secret }))

export const webhookDeliverySchema: z.ZodType<WebhookDelivery, unknown> = z
  .object({
    id: idSchema,
    webhook_id: idSchema,
    event: z.enum(WEBHOOK_EVENTS),
    payload: z.unknown(),
    status: z.enum(WEBHOOK_DELIVERY_STATUSES),
    attempts: z.number().int(),
    delivered_at: nullableTimestampSchema,
    created_at: timestampSchema,
  })
  .transform(
    (wire): WebhookDelivery => ({
      id: wire.id,
      webhookId: wire.webhook_id,
      event: wire.event,
      payload: wire.payload,
      status: wire.status,
      attempts: wire.attempts,
      deliveredAt: wire.delivered_at,
      createdAt: wire.created_at,
    }),
  )

export interface CreateWebhookInput {
  readonly url: string
  readonly events: readonly WebhookEvent[]
}

/**
 * `status` takes only the two values a customer controls. `failing` is what the
 * delivery engine reports about the endpoint, so setting it by hand would be
 * asserting something only the engine can know.
 */
export interface WebhookInput {
  readonly url?: string
  readonly events?: readonly WebhookEvent[]
  readonly status?: WebhookSettableStatus
}

export function createWebhookBody(input: CreateWebhookInput): unknown {
  return { url: input.url, events: input.events }
}

export function webhookBody(input: WebhookInput): unknown {
  return definedFields({ url: input.url, events: input.events, status: input.status })
}
