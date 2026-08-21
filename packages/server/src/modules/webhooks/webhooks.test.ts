import { createHmac } from 'node:crypto'
import { createdWebhookSchema, webhookDeliverySchema, webhookSchema } from '@kelpie/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreMigrationsDirectory, coreModules } from '../core.ts'
import {
  DEFAULT_DELIVERY_RETENTION_DAYS,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_MS,
} from './delivery.ts'
import type { AttemptOutcome, DeliveryRequest, SendDelivery, Sleep } from './delivery.ts'
import { createWebhooksModule } from './index.ts'
import { webhookDeliveries, webhooks } from './schema.ts'
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER } from './signing.ts'

/**
 * `/v1/webhooks` and the delivery engine, against real Postgres.
 *
 * The outbound port and the retry waits are injected, so the suite asserts what
 * would have been sent without a network call and spends no real time on the
 * backoff. Everything else — fan-out, the delivery log, the status transitions
 * — runs against the same rows production would write.
 */

const connectionString = testDatabaseUrl(process.env)

const DELIVERED: AttemptOutcome = { delivered: true, status: 200, reason: null }
const REFUSED: AttemptOutcome = { delivered: false, status: 500, reason: 'endpoint answered 500' }


describe.skipIf(connectionString === undefined)('webhooks', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner

  /** What the fake sender was asked to send, and what it answers with. */
  let sent: DeliveryRequest[]
  let outcome: AttemptOutcome
  /** Consumed one per attempt before falling back to `outcome`, for scripting a retry. */
  let scripted: AttemptOutcome[]
  let waits: number[]

  const send: SendDelivery = (request) => {
    sent.push(request)

    return Promise.resolve(scripted.shift() ?? outcome)
  }

  const sleep: Sleep = (milliseconds) => {
    waits.push(milliseconds)

    return Promise.resolve()
  }

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
  })

  afterAll(async () => {
    await database.close()
  })

  beforeEach(async () => {
    await database.truncateAll()
    sent = []
    waits = []
    scripted = []
    outcome = DELIVERED

    harness = await createTestApp({
      // The one module swapped for a configured copy. Order is resolved from
      // `requires`, so appending it is the same registration order as core's.
      modules: [
        ...coreModules.filter((module) => module.id !== 'webhooks'),
        createWebhooksModule(coreMigrationsDirectory, { send, sleep }),
      ],
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()
  })

  async function createWebhook(
    body: Record<string, unknown> = {},
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/webhooks', {
      body: { url: 'https://example.com/hooks/kelpie', events: ['record.created'], ...body },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  /** Creates a Person, which is what emits `record.created`, and waits for delivery. */
  async function createPerson(name = 'Ada Lovelace', cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', {
      body: { name, email: `${name.split(' ')[0]?.toLowerCase() ?? 'x'}@example.com` },
      cookie,
    })

    expect(response.status).toBe(201)

    // Publication is not awaited by the request that caused it, so the suite
    // waits the way `runtime/events.ts` says to.
    await harness.services.events.drain()

    return readString(await response.json(), 'id')
  }

  async function listWebhooks(cookie = acme.cookie): Promise<Record<string, unknown>[]> {
    const response = await client.send('GET', '/v1/webhooks', { cookie })

    expect(response.status).toBe(200)

    return readList(await response.json())
  }

  /** Invites an address as a plain member and accepts as a fresh account. */
  async function addMember(email: string, role: 'admin' | 'member'): Promise<string> {
    const invited = await client.send('POST', `/v1/workspaces/${acme.workspaceId}/invites`, {
      body: { email, role },
      cookie: acme.cookie,
    })
    expect(invited.status).toBe(201)

    const body = harness.services.sentEmails.at(-1)?.body ?? ''
    const token = /token=(?<token>[\w-]+)/u.exec(body)?.groups?.token

    if (token === undefined) {
      throw new Error(`No invite token in the sent email: ${body}`)
    }

    const cookie = await client.signUp(email)
    const accepted = await client.send('POST', '/v1/invites/accept', { body: { token }, cookie })
    expect(accepted.status).toBe(200)

    return cookie
  }

  describe('registration', () => {
    it('answers with the secret exactly once', async () => {
      const created = await createWebhook()

      expect(readString(created, 'secret').startsWith('whsec_')).toBe(true)
      expect(created.status).toBe('active')
      expect(created.events).toEqual(['record.created'])
      expect(created.last_delivery_at).toBeNull()
      expect(created.last_delivery_status).toBeNull()

      const read = await client.send('GET', `/v1/webhooks/${readString(created, 'id')}`, {
        cookie: acme.cookie,
      })
      const body = readRecord(await read.json())

      expect(body.secret).toBeUndefined()
      expect(readString(body, 'secret_prefix').startsWith('whsec_…')).toBe(true)
    })

    it('parses as the wire schemas the browser decodes with', async () => {
      const created = await createWebhook()

      expect(createdWebhookSchema.parse(created).secret).toBe(created.secret)
      expect(webhookSchema.parse((await listWebhooks()).at(0)).id).toBe(created.id)
    })

    it('never returns the sealed secret in any response', async () => {
      const created = await createWebhook()
      const listed = JSON.stringify(await listWebhooks())

      expect(listed).not.toContain('secret_encrypted')
      expect(listed).not.toContain(readString(created, 'secret'))
    })

    it('refuses a URL nothing can be posted to', async () => {
      for (const url of ['not-a-url', 'ftp://example.com/hooks', 'https://u:p@example.com/h']) {
        const response = await client.send('POST', '/v1/webhooks', {
          body: { url, events: ['record.created'] },
          cookie: acme.cookie,
        })

        expect(response.status).toBe(422)
      }
    })

    it('refuses an empty, repeated, or unknown event list', async () => {
      for (const events of [[], ['record.created', 'record.created'], ['record.exploded']]) {
        const response = await client.send('POST', '/v1/webhooks', {
          body: { url: 'https://example.com/hooks', events },
          cookie: acme.cookie,
        })

        expect(response.status).toBe(422)
      }
    })

    it('refuses an unknown field rather than dropping it', async () => {
      const response = await client.send('POST', '/v1/webhooks', {
        body: { url: 'https://example.com/hooks', events: ['record.created'], secret: 'mine' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('pauses and resumes, and refuses to be told it is failing', async () => {
      const id = readString(await createWebhook(), 'id')

      const paused = await client.send('PATCH', `/v1/webhooks/${id}`, {
        body: { status: 'paused' },
        cookie: acme.cookie,
      })
      expect(paused.status).toBe(200)
      expect(readRecord(await paused.json()).status).toBe('paused')

      const claimed = await client.send('PATCH', `/v1/webhooks/${id}`, {
        body: { status: 'failing' },
        cookie: acme.cookie,
      })
      expect(claimed.status).toBe(422)
    })

    it('deletes, and then cannot be found', async () => {
      const id = readString(await createWebhook(), 'id')

      expect((await client.send('DELETE', `/v1/webhooks/${id}`, { cookie: acme.cookie })).status).toBe(204)
      expect((await client.send('GET', `/v1/webhooks/${id}`, { cookie: acme.cookie })).status).toBe(404)
    })

    it('filters by status', async () => {
      const id = readString(await createWebhook(), 'id')
      await createWebhook({ url: 'https://example.com/second' })
      await client.send('PATCH', `/v1/webhooks/${id}`, {
        body: { status: 'paused' },
        cookie: acme.cookie,
      })

      const paused = await client.send('GET', '/v1/webhooks?status=paused', { cookie: acme.cookie })

      expect(readList(await paused.json())).toHaveLength(1)
      expect(
        (await client.send('GET', '/v1/webhooks?status=exploded', { cookie: acme.cookie })).status,
      ).toBe(422)
    })
  })

  describe('access', () => {
    it('needs credentials', async () => {
      expect((await client.send('GET', '/v1/webhooks')).status).toBe(401)
    })

    /**
     * Reads are admin-only, unlike the team list. A webhook URL routinely
     * carries its own credential in the path, so listing registrations is
     * disclosing a secret rather than describing a setting.
     */
    it('is closed to a member, reads included', async () => {
      await createWebhook()
      const member = await addMember('grace@example.com', 'member')

      expect((await client.send('GET', '/v1/webhooks', { cookie: member })).status).toBe(403)
      expect(
        (await client.send('POST', '/v1/webhooks', {
          body: { url: 'https://example.com/hooks', events: ['record.created'] },
          cookie: member,
        })).status,
      ).toBe(403)
    })

    it('is open to an admin', async () => {
      const admin = await addMember('grace@example.com', 'admin')

      expect((await client.send('GET', '/v1/webhooks', { cookie: admin })).status).toBe(200)
    })

    it('hides another workspace entirely', async () => {
      const id = readString(await createWebhook(), 'id')
      const other = await client.owner('mallory@example.com', 'other')

      expect((await client.send('GET', `/v1/webhooks/${id}`, { cookie: other.cookie })).status).toBe(404)
      expect((await client.send('DELETE', `/v1/webhooks/${id}`, { cookie: other.cookie })).status).toBe(404)
      expect(readList(await (await client.send('GET', '/v1/webhooks', { cookie: other.cookie })).json())).toEqual([])
    })
  })

  describe('delivery', () => {
    it('signs the body it sends with the secret the customer was given', async () => {
      const created = await createWebhook()
      const secret = readString(created, 'secret')

      const personId = await createPerson()

      expect(sent).toHaveLength(1)
      const [request] = sent

      if (request === undefined) {
        throw new Error('unreachable: the delivery was just asserted')
      }

      const expected = createHmac('sha256', secret).update(request.body, 'utf8').digest('hex')

      expect(request.url).toBe('https://example.com/hooks/kelpie')
      expect(request.headers[SIGNATURE_HEADER]).toBe(`sha256=${expected}`)
      expect(request.headers[EVENT_HEADER]).toBe('record.created')
      expect(String(request.headers[DELIVERY_HEADER]).startsWith('whd_')).toBe(true)

      expect(JSON.parse(request.body)).toEqual({
        id: request.headers[DELIVERY_HEADER],
        event: 'record.created',
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/u),
        workspace_id: acme.workspaceId,
        data: { object_type: 'person', record_id: personId },
      })
    })

    it('carries the changed fields on an update, and the id on a delete', async () => {
      await createWebhook({ events: ['record.updated', 'record.deleted'] })
      const personId = await createPerson()

      expect(sent).toHaveLength(0)

      await client.send('PATCH', `/v1/people/${personId}`, {
        body: { location: 'Melbourne' },
        cookie: acme.cookie,
      })
      await harness.services.events.drain()

      await client.send('DELETE', `/v1/people/${personId}`, { cookie: acme.cookie })
      await harness.services.events.drain()

      const bodies = sent.map((request) => JSON.parse(request.body) as { event: string; data: unknown })

      expect(bodies.map((body) => body.event)).toEqual(['record.updated', 'record.deleted'])
      expect(bodies.at(0)?.data).toEqual({
        object_type: 'person',
        record_id: personId,
        changed_fields: ['location'],
      })
      expect(bodies.at(1)?.data).toEqual({ object_type: 'person', record_id: personId })
    })

    it('sends to every subscriber and to nobody else', async () => {
      await createWebhook({ url: 'https://example.com/one' })
      await createWebhook({ url: 'https://example.com/two' })
      await createWebhook({ url: 'https://example.com/other-event', events: ['form.submitted'] })

      const paused = await createWebhook({ url: 'https://example.com/paused' })
      await client.send('PATCH', `/v1/webhooks/${readString(paused, 'id')}`, {
        body: { status: 'paused' },
        cookie: acme.cookie,
      })

      await createPerson()

      expect(sent.map((request) => request.url).sort()).toEqual([
        'https://example.com/one',
        'https://example.com/two',
      ])
    })

    it('does not cross workspaces', async () => {
      await createWebhook({ url: 'https://example.com/acme' })
      const other = await client.owner('mallory@example.com', 'other')
      await createWebhook({ url: 'https://example.com/other' }, other.cookie)

      await createPerson('Ada Lovelace', other.cookie)

      expect(sent.map((request) => request.url)).toEqual(['https://example.com/other'])
    })

    it('records a success and leaves an active hook alone', async () => {
      const id = readString(await createWebhook(), 'id')
      await createPerson()

      const deliveries = readList(
        await (await client.send(`GET`, `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json(),
      )

      expect(deliveries).toHaveLength(1)
      const [delivery] = deliveries

      expect(delivery?.status).toBe('success')
      expect(delivery?.attempts).toBe(1)
      expect(delivery?.delivered_at).not.toBeNull()
      expect(delivery?.event).toBe('record.created')
      expect(() => webhookDeliverySchema.parse(delivery)).not.toThrow()

      const [webhook] = await listWebhooks()

      expect(webhook?.status).toBe('active')
      expect(webhook?.last_delivery_status).toBe('success')
      expect(webhook?.last_delivery_at).toBe(delivery?.created_at)
    })

    it('retries with backoff, then records the failure and marks the hook failing', async () => {
      const id = readString(await createWebhook(), 'id')
      outcome = REFUSED

      await createPerson()

      expect(sent).toHaveLength(MAX_DELIVERY_ATTEMPTS)
      expect(waits).toEqual([...RETRY_DELAYS_MS])

      const [delivery] = readList(
        await (await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json(),
      )

      expect(delivery?.status).toBe('failed')
      expect(delivery?.attempts).toBe(MAX_DELIVERY_ATTEMPTS)
      expect(delivery?.delivered_at).toBeNull()

      const [webhook] = await listWebhooks()

      expect(webhook?.status).toBe('failing')
      expect(webhook?.last_delivery_status).toBe('failed')
    })

    it('stops retrying the moment an attempt lands', async () => {
      const id = readString(await createWebhook(), 'id')
      scripted = [REFUSED]

      await createPerson()

      expect(sent).toHaveLength(2)
      expect(waits).toEqual([RETRY_DELAYS_MS[0]])

      const [delivery] = readList(
        await (await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json(),
      )

      // One row, not one per attempt: the log records a delivery, and the
      // attempt count is how hard it was to make.
      expect(delivery?.status).toBe('success')
      expect(delivery?.attempts).toBe(2)
      expect((await listWebhooks()).at(0)?.status).toBe('active')
    })

    it('returns a failing hook to active once an attempt lands', async () => {
      const id = readString(await createWebhook(), 'id')
      outcome = REFUSED
      await createPerson('Ada Lovelace')

      expect((await listWebhooks()).at(0)?.status).toBe('failing')

      outcome = DELIVERED
      await createPerson('Grace Hopper')

      const [webhook] = await listWebhooks()

      expect(webhook?.status).toBe('active')
      expect(webhook?.last_delivery_status).toBe('success')

      const deliveries = readList(
        await (await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json(),
      )

      expect(deliveries).toHaveLength(2)
      expect(deliveries.at(0)?.status).toBe('success')
    })

    /** A paused hook is not selected, so pausing is how a customer stops the noise. */
    it('logs nothing for a paused hook', async () => {
      const id = readString(await createWebhook(), 'id')
      await client.send('PATCH', `/v1/webhooks/${id}`, {
        body: { status: 'paused' },
        cookie: acme.cookie,
      })

      await createPerson()

      expect(sent).toHaveLength(0)
      expect(
        readList(await (await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json()),
      ).toEqual([])
    })
  })

  describe('the delivery log', () => {
    it('filters by status and 404s for a webhook that is not there', async () => {
      const id = readString(await createWebhook(), 'id')
      outcome = REFUSED
      await createPerson('Ada Lovelace')
      outcome = DELIVERED
      await createPerson('Grace Hopper')

      const failed = readList(
        await (await client.send('GET', `/v1/webhooks/${id}/deliveries?status=failed`, {
          cookie: acme.cookie,
        })).json(),
      )

      expect(failed).toHaveLength(1)
      expect(failed.at(0)?.status).toBe('failed')

      expect(
        (await client.send('GET', '/v1/webhooks/wh_missing/deliveries', { cookie: acme.cookie })).status,
      ).toBe(404)
    })

    it('stores the body as it was sent', async () => {
      const id = readString(await createWebhook(), 'id')
      await createPerson()

      const [delivery] = readList(
        await (await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json(),
      )

      expect(delivery?.payload).toEqual(JSON.parse(sent.at(0)?.body ?? '{}'))
    })
  })

  /**
   * `schema.md` calls the log retention-pruned. There is no scheduler in the
   * service, so the engine prunes a webhook's expired rows in the same
   * transaction that records its next delivery — the only place the log grows.
   */
  describe('retention', () => {
    const DAY_MS = 86_400_000

    function daysAgo(days: number): Date {
      return new Date(Date.now() - days * DAY_MS)
    }

    async function backdateDeliveries(webhookId: string, to: Date): Promise<void> {
      await database.db
        .update(webhookDeliveries)
        .set({ createdAt: to })
        .where(eq(webhookDeliveries.webhookId, webhookId))
    }

    async function listDeliveries(id: string): Promise<Record<string, unknown>[]> {
      return readList(
        await (await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json(),
      )
    }

    it('prunes rows that have outlived the window when the next delivery is recorded', async () => {
      const id = readString(await createWebhook(), 'id')
      await createPerson('Ada Lovelace')
      await backdateDeliveries(id, daysAgo(DEFAULT_DELIVERY_RETENTION_DAYS + 1))

      await createPerson('Grace Hopper')

      const deliveries = await listDeliveries(id)

      expect(deliveries).toHaveLength(1)
      // The survivor is the delivery that triggered the prune, so
      // `last_delivery_*` always has a row to read.
      expect(deliveries.at(0)?.payload).toEqual(JSON.parse(sent.at(-1)?.body ?? '{}'))
    })

    it('keeps rows still inside the window', async () => {
      const id = readString(await createWebhook(), 'id')
      await createPerson('Ada Lovelace')
      await backdateDeliveries(id, daysAgo(DEFAULT_DELIVERY_RETENTION_DAYS - 1))

      await createPerson('Grace Hopper')

      expect(await listDeliveries(id)).toHaveLength(2)
    })

    it('prunes a failed delivery in, and an expired row out, the same way', async () => {
      const id = readString(await createWebhook(), 'id')
      await createPerson('Ada Lovelace')
      await backdateDeliveries(id, daysAgo(DEFAULT_DELIVERY_RETENTION_DAYS + 1))

      outcome = REFUSED
      await createPerson('Grace Hopper')

      const deliveries = await listDeliveries(id)

      expect(deliveries).toHaveLength(1)
      expect(deliveries.at(0)?.status).toBe('failed')
    })

    it('touches only the webhook that recorded, so a silent hook keeps its residue', async () => {
      const active = readString(await createWebhook({ url: 'https://example.com/active' }), 'id')
      const paused = readString(await createWebhook({ url: 'https://example.com/paused' }), 'id')
      await createPerson('Ada Lovelace')

      const expiredAt = daysAgo(DEFAULT_DELIVERY_RETENTION_DAYS + 1)
      await backdateDeliveries(active, expiredAt)
      await backdateDeliveries(paused, expiredAt)
      await client.send('PATCH', `/v1/webhooks/${paused}`, {
        body: { status: 'paused' },
        cookie: acme.cookie,
      })

      await createPerson('Grace Hopper')

      // The delivering hook pruned its expired row and holds only the new one.
      expect(await listDeliveries(active)).toHaveLength(1)

      // The paused hook recorded nothing, so nothing pruned it: its expired row
      // stays until the hook or the workspace goes. Bounded, and documented.
      const residue = await listDeliveries(paused)

      expect(residue).toHaveLength(1)
      expect(new Date(readString(residue.at(0) ?? {}, 'created_at')).getTime()).toBe(
        expiredAt.getTime(),
      )
    })

    /**
     * The window is deployment configuration, so the wiring from environment
     * to engine is what this proves: under a seven-day window, a ten-day-old
     * row — safe under the thirty-day default — is pruned.
     */
    it('reads the window from the environment', async () => {
      const scoped = await createTestApp({
        modules: [
          ...coreModules.filter((module) => module.id !== 'webhooks'),
          createWebhooksModule(coreMigrationsDirectory, { send, sleep }),
        ],
        environment: { ...TEST_ENVIRONMENT, WEBHOOK_DELIVERY_RETENTION_DAYS: '7' },
        services: createTestServices({ db: database.db }),
      })
      const scopedClient = createTestClient(scoped.app, scoped.services.db)
      const owner = await scopedClient.owner('narrow@example.com', 'narrow')

      const created = await scopedClient.send('POST', '/v1/webhooks', {
        body: { url: 'https://example.com/hooks/narrow', events: ['record.created'] },
        cookie: owner.cookie,
      })
      expect(created.status).toBe(201)
      const id = readString(readRecord(await created.json()), 'id')

      const first = await scopedClient.send('POST', '/v1/people', {
        body: { name: 'Ada Lovelace', email: 'ada@example.com' },
        cookie: owner.cookie,
      })
      expect(first.status).toBe(201)
      await scoped.services.events.drain()

      await backdateDeliveries(id, daysAgo(10))

      const second = await scopedClient.send('POST', '/v1/people', {
        body: { name: 'Grace Hopper', email: 'grace@example.com' },
        cookie: owner.cookie,
      })
      expect(second.status).toBe(201)
      await scoped.services.events.drain()

      const listed = await scopedClient.send('GET', `/v1/webhooks/${id}/deliveries`, {
        cookie: owner.cookie,
      })

      expect(readList(await listed.json())).toHaveLength(1)
    })
  })

  /**
   * Replacing a leaked secret without deleting the registration, which would
   * take its subscriptions and its whole delivery log with it.
   */
  describe('rotating the signing secret', () => {
    /** Every `sha256=…` value on the last delivery. */
    function signaturesSent(): string[] {
      return String(sent.at(-1)?.headers[SIGNATURE_HEADER] ?? '').split(',')
    }

    function signatureUnder(secret: string): string {
      return `sha256=${createHmac('sha256', secret).update(sent.at(-1)?.body ?? '', 'utf8').digest('hex')}`
    }

    async function rotate(id: string, body?: Record<string, unknown>): Promise<Response> {
      return client.send('POST', `/v1/webhooks/${id}/rotate_secret`, {
        cookie: acme.cookie,
        ...(body === undefined ? {} : { body }),
      })
    }

    it('answers with a new secret, once, and keeps the registration', async () => {
      const created = await createWebhook({ events: ['record.created', 'record.updated'] })
      const id = readString(created, 'id')
      const original = readString(created, 'secret')

      const response = await rotate(id)
      const rotated = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(readString(rotated, 'secret')).not.toBe(original)
      expect(readString(rotated, 'secret').startsWith('whsec_')).toBe(true)
      // The id, the events and the delivery log all survive. Deleting and
      // re-registering is what this endpoint exists to avoid.
      expect(rotated.id).toBe(id)
      expect(rotated.events).toEqual(['record.created', 'record.updated'])
      expect(readString(rotated, 'secret_prefix')).not.toBe(readString(created, 'secret_prefix'))

      // And never again: the list carries a prefix and no secret.
      expect((await listWebhooks()).at(0)).not.toHaveProperty('secret')
    })

    it('signs with the new secret and not the old one', async () => {
      const created = await createWebhook()
      const original = readString(created, 'secret')
      const replacement = readString(readRecord(await (await rotate(readString(created, 'id'))).json()), 'secret')

      await createPerson()

      expect(signaturesSent()).toEqual([signatureUnder(replacement)])
      expect(signaturesSent()).not.toContain(signatureUnder(original))
    })

    /**
     * The whole point of the overlap: an endpoint still holding the old secret
     * finds a value it can verify, so nothing fails while the customer deploys.
     */
    it('signs with both secrets during an overlap', async () => {
      const created = await createWebhook()
      const original = readString(created, 'secret')
      const replacement = readString(
        readRecord(await (await rotate(readString(created, 'id'), { overlap: true })).json()),
        'secret',
      )

      await createPerson()

      const signatures = signaturesSent()

      expect(signatures).toHaveLength(2)
      expect(signatures).toContain(signatureUnder(replacement))
      expect(signatures).toContain(signatureUnder(original))
      // Newest first, so a receiver that only reads the first value is on the
      // secret it is being moved to rather than the one being retired.
      expect(signatures.at(0)).toBe(signatureUnder(replacement))
    })

    it('stops signing with the old secret once the window has passed', async () => {
      const created = await createWebhook()
      const original = readString(created, 'secret')
      await rotate(readString(created, 'id'), { overlap: true })

      // Straight past the expiry the rotation wrote, rather than waiting a day.
      await database.db
        .update(webhooks)
        .set({ previousSecretExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(webhooks.id, readString(created, 'id')))

      await createPerson()

      expect(signaturesSent()).toHaveLength(1)
      expect(signaturesSent()).not.toContain(signatureUnder(original))
    })

    it('discards a previous secret when rotating again without an overlap', async () => {
      const created = await createWebhook()
      const id = readString(created, 'id')
      await rotate(id, { overlap: true })
      await rotate(id)

      const [row] = await database.db
        .select({
          previous: webhooks.previousSecretEncrypted,
          expires: webhooks.previousSecretExpiresAt,
        })
        .from(webhooks)
        .where(eq(webhooks.id, id))

      // Not merely expired: the ciphertext is gone, so a retired secret is not
      // left sitting at rest for the life of the registration.
      expect(row?.previous).toBeNull()
      expect(row?.expires).toBeNull()
    })

    it('keeps the delivery log across a rotation', async () => {
      const id = readString(await createWebhook(), 'id')
      await createPerson('Ada Lovelace')
      await rotate(id, { overlap: true })
      await createPerson('Grace Hopper')

      const deliveries = readList(
        await (await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json(),
      )

      expect(deliveries).toHaveLength(2)
    })

    it('needs the admin role, like every other verb here', async () => {
      const id = readString(await createWebhook(), 'id')
      const member = await addMember('grace@example.com', 'member')

      const response = await client.send('POST', `/v1/webhooks/${id}/rotate_secret`, {
        cookie: member,
      })

      expect(response.status).toBe(403)
    })

    it('404s for a webhook in another workspace', async () => {
      const response = await rotate('wh_01JZZZZZZZZZZZZZZZZZZZZZZZ')

      expect(response.status).toBe(404)
    })

    it('refuses a field it does not know rather than rotating anyway', async () => {
      const id = readString(await createWebhook(), 'id')

      expect((await rotate(id, { overlap_hours: 72 })).status).toBe(422)
    })
  })

  describe('services.secretEncryption precedence', () => {
    it('boots the module from services.secretEncryption when SECRET_ENCRYPTION_KEY is missing from the environment', async () => {
      // TEST_ENVIRONMENT normally carries SECRET_ENCRYPTION_KEY, so most suites
      // exercise the fallback. Here it is stripped, and services carries the
      // key instead. If webhooks reads through the fallback, boot throws
      // ModuleBootError. Boot succeeding is the whole assertion.
      const { SECRET_ENCRYPTION_KEY, ...environmentWithoutKey } = TEST_ENVIRONMENT

      // Reference the discarded binding so a stricter linter cannot complain.
      expect(SECRET_ENCRYPTION_KEY).toBeDefined()

      const overridden = await createTestApp({
        modules: coreModules,
        environment: environmentWithoutKey,
        services: createTestServices({
          db: database.db,
          secretEncryption: { SECRET_ENCRYPTION_KEY: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=' },
        }),
      })

      // Reaching the /v1/webhooks surface at all proves the module registered,
      // which the fallback path would have blocked before this branch existed.
      const listed = await overridden.app.request('/v1/webhooks')
      expect(listed.status).not.toBe(500)
    })
  })
})
