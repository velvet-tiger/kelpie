import { createHmac } from 'node:crypto'

import type { WebhookEvent } from './payloads.ts'

/**
 * What goes on the wire, and the signature over it.
 *
 * The body is rendered once and everything downstream uses that exact string:
 * `api.md` computes the signature over the raw body, so re-serialising before
 * sending would produce a signature for text the receiver never saw.
 */

/** `api.md` fixes this name and the `sha256=` prefix. */
export const SIGNATURE_HEADER = 'Kelpie-Signature'

/**
 * Not in `api.md`, and both earn their place. Delivery is at-least-once, so a
 * receiver needs a stable key to recognise a repeat; and reading the event name
 * off a header lets one route the request before parsing the body.
 */
export const DELIVERY_HEADER = 'Kelpie-Delivery'
export const EVENT_HEADER = 'Kelpie-Event'

export interface DeliveryEnvelope {
  readonly deliveryId: string
  readonly event: WebhookEvent
  readonly sentAt: Date
  /**
   * Included even though `api.md` keeps the workspace implicit everywhere else.
   * A REST caller's workspace comes from its credential; a receiver has no
   * credential, and two workspaces may point their webhooks at one endpoint.
   */
  readonly workspaceId: string
  readonly data: Record<string, unknown>
}

/** The delivery body as an object, for storing in the log alongside the text sent. */
export function deliveryBody(envelope: DeliveryEnvelope): Record<string, unknown> {
  return {
    id: envelope.deliveryId,
    event: envelope.event,
    created_at: envelope.sentAt.toISOString(),
    workspace_id: envelope.workspaceId,
    data: envelope.data,
  }
}

/** @returns The exact JSON text to send and to sign. */
export function renderDeliveryBody(body: Record<string, unknown>): string {
  return JSON.stringify(body)
}

/**
 * @param secret The plaintext signing secret, as the receiver holds it.
 * @returns `sha256=<hex>`, one value of `Kelpie-Signature`.
 */
export function signDeliveryBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

/**
 * Joins one or more signatures into the header value.
 *
 * A rotation with an overlap window signs under both the new secret and the old
 * one, so an endpoint that has not been redeployed yet still finds a value it
 * can verify. `api.md` therefore tells a receiver to split on `,` and accept if
 * **any** value matches, rather than comparing the header to one expected
 * string.
 *
 * That instruction has to hold outside a rotation too, which is why this is the
 * only way the header is ever built. A receiver that compares the whole header
 * would work perfectly until the first rotation and fail during it, which is
 * precisely when a customer can least afford a surprise. One signature renders
 * identically to the single value the header has always carried, so saying so
 * costs nothing today and is what makes the overlap work at all.
 */
export function joinSignatures(signatures: readonly string[]): string {
  if (signatures.length === 0) {
    throw new Error('A delivery must carry at least one signature')
  }

  return signatures.join(',')
}

export function deliveryHeaders(
  envelope: DeliveryEnvelope,
  signatures: readonly string[],
): Readonly<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    [SIGNATURE_HEADER]: joinSignatures(signatures),
    [DELIVERY_HEADER]: envelope.deliveryId,
    [EVENT_HEADER]: envelope.event,
  }
}
