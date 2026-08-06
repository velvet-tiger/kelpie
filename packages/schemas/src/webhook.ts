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

/**
 * How long a rotation may sign under both secrets.
 *
 * Long enough to cover a working day, because the window has to span a customer
 * noticing, changing their configuration and getting a deploy out, and short
 * enough that a leaked secret is not honoured for a week.
 *
 * Shared rather than duplicated: the service computes the expiry from it and the
 * browser tells the customer what they are choosing, and the two disagreeing
 * would mean a checkbox that promises a window nothing implements.
 */
export const WEBHOOK_SECRET_OVERLAP_HOURS = 24

/**
 * How long a delivery log row is kept.
 *
 * `schema.md` calls `webhook_deliveries` retention-pruned without setting a
 * window; this is the invented number. Thirty days covers "did last month's
 * integration change break anything" while keeping the fastest-growing table in
 * the schema bounded per webhook.
 *
 * Shared rather than duplicated for the same reason the overlap window is: the
 * engine prunes by it and the delivery log page tells the customer what is
 * kept, and the two disagreeing would mean a screen promising history the
 * engine has already deleted.
 */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30

/**
 * Replacing a webhook's signing secret.
 *
 * `overlap` keeps the old secret valid for a further
 * `WEBHOOK_SECRET_OVERLAP_HOURS`, so a delivery is signed under both and an
 * endpoint that has not been redeployed still verifies. Off means the old secret
 * stops working at once, and deliveries fail until the new one is live.
 */
export interface RotateWebhookSecretInput {
  readonly overlap: boolean
}

export function rotateWebhookSecretBody(input: RotateWebhookSecretInput): unknown {
  return { overlap: input.overlap }
}

export function createWebhookBody(input: CreateWebhookInput): unknown {
  return { url: input.url, events: input.events }
}

export function webhookBody(input: WebhookInput): unknown {
  return definedFields({ url: input.url, events: input.events, status: input.status })
}
