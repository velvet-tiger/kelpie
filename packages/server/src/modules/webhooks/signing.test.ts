import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  deliveryBody,
  deliveryHeaders,
  renderDeliveryBody,
  signDeliveryBody,
} from './signing.ts'
import type { DeliveryEnvelope } from './signing.ts'

const envelope: DeliveryEnvelope = {
  deliveryId: 'whd_01',
  event: 'record.created',
  sentAt: new Date('2026-08-05T01:02:03.456Z'),
  workspaceId: 'ws_01',
  data: { object_type: 'person', record_id: 'per_01' },
}

describe('deliveryBody', () => {
  it('carries the delivery id, the event, the workspace and the data', () => {
    expect(deliveryBody(envelope)).toEqual({
      id: 'whd_01',
      event: 'record.created',
      created_at: '2026-08-05T01:02:03.456Z',
      workspace_id: 'ws_01',
      data: { object_type: 'person', record_id: 'per_01' },
    })
  })

  /** `api.md` fixes ISO 8601 UTC with milliseconds on every timestamp. */
  it('renders the timestamp with milliseconds', () => {
    expect(deliveryBody(envelope).created_at).toBe('2026-08-05T01:02:03.456Z')
  })
})

describe('signDeliveryBody', () => {
  it('is an HMAC-SHA256 of the exact body under the plaintext secret', () => {
    const body = renderDeliveryBody(deliveryBody(envelope))
    const expected = createHmac('sha256', 'whsec_abc').update(body, 'utf8').digest('hex')

    expect(signDeliveryBody('whsec_abc', body)).toBe(`sha256=${expected}`)
  })

  /**
   * The whole reason the body is rendered once and passed around as text: a
   * receiver verifies against the bytes it was sent, so one differing byte has
   * to produce a different signature.
   */
  it('changes when a single byte of the body changes', () => {
    const body = renderDeliveryBody(deliveryBody(envelope))

    expect(signDeliveryBody('whsec_abc', body)).not.toBe(
      signDeliveryBody('whsec_abc', `${body} `),
    )
  })

  it('changes with the secret', () => {
    const body = renderDeliveryBody(deliveryBody(envelope))

    expect(signDeliveryBody('whsec_abc', body)).not.toBe(signDeliveryBody('whsec_xyz', body))
  })
})

describe('deliveryHeaders', () => {
  it('sends JSON, the signature, and the two headers a receiver routes and dedupes on', () => {
    const headers = deliveryHeaders(envelope, ['sha256=deadbeef'])

    expect(headers).toEqual({
      'Content-Type': 'application/json',
      [SIGNATURE_HEADER]: 'sha256=deadbeef',
      [DELIVERY_HEADER]: 'whd_01',
      [EVENT_HEADER]: 'record.created',
    })
  })

  /**
   * The format a receiver has to be written against from the start. It only
   * carries two values during a rotation overlap, and a receiver that compared
   * the whole header would fail exactly then.
   */
  it('joins two signatures with a comma, and one renders as it always has', () => {
    expect(deliveryHeaders(envelope, ['sha256=new', 'sha256=old'])[SIGNATURE_HEADER]).toBe(
      'sha256=new,sha256=old',
    )
    expect(deliveryHeaders(envelope, ['sha256=only'])[SIGNATURE_HEADER]).toBe('sha256=only')
  })

  it('refuses to send a delivery with no signature at all', () => {
    expect(() => deliveryHeaders(envelope, [])).toThrow(/at least one signature/u)
  })
})
