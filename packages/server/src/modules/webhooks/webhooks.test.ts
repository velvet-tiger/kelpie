import { createHmac } from 'node:crypto'
import { createdWebhookSchema, webhookDeliverySchema, webhookSchema } from '@kelpie/schemas'
import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createEgressGuard } from '../../lib/egress.ts'
import { createCaptureTransport, createLogger } from '../../lib/logger.ts'
import { createSecretCipher } from '../../lib/secrets.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT, TEST_SECRET_ENCRYPTION_KEY } from '../../testing/environment.ts'
import { countLockWaits } from '../../testing/lockWaits.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreMigrationsDirectory, coreModules } from '../core.ts'
import {
  DEFAULT_DELIVERY_RETENTION_DAYS,
  DELIVERY_REFUSED_REASONS,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_MS,
  createDeliveryEngine,
  createHttpSender,
} from './delivery.ts'
import type {
  AttemptOutcome,
  DeliveryEngine,
  DeliveryRequest,
  SendDelivery,
  Sleep,
} from './delivery.ts'
import { createDeliveryLimiter } from './deliveryLimiter.ts'
import type { DeliveryLimits } from './deliveryLimiter.ts'
import { createWebhooksModule } from './index.ts'
import { DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE } from './limits.ts'
import { lockRegistrations } from './repository.ts'
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
    // The invitation email is a job; run it as the worker would.
    await harness.runQueuedJobs()

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
      const other = await client.owner('mallory@example.com')

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
        body: {
          addresses: [
            {
              kind: 'home',
              line1: null,
              line2: null,
              city: 'Melbourne',
              region: null,
              postal_code: null,
              country: 'AU',
              primary: true,
            },
          ],
        },
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
        changed_fields: ['addresses'],
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
      const other = await client.owner('mallory@example.com')
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
   * The delivery log is retention-pruned (`docs/agents/api-and-webhooks.md`).
   * There is no scheduler in the service, so the engine prunes a webhook's
   * expired rows in the same transaction that records its next delivery — the
   * only place the log grows.
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
      const owner = await scopedClient.owner('narrow@example.com')

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

  /**
   * The same app on the same database under another environment, the way the
   * retention suite reads its window. Sessions are rows, so a cookie from the
   * suite's own app signs in here too.
   */
  async function appWith(environment: Record<string, string>): Promise<{ app: TestApp; client: TestClient }> {
    const app = await createTestApp({
      modules: [
        ...coreModules.filter((module) => module.id !== 'webhooks'),
        createWebhooksModule(coreMigrationsDirectory, { send, sleep }),
      ],
      environment: { ...TEST_ENVIRONMENT, ...environment },
      services: createTestServices({ db: database.db }),
    })

    return { app, client: createTestClient(app.app, app.services.db) }
  }

  async function countRegistrations(workspaceId: string): Promise<number> {
    const [row] = await database.db
      .select({ total: count() })
      .from(webhooks)
      .where(eq(webhooks.workspaceId, workspaceId))

    return row?.total ?? 0
  }

  async function register(
    target: TestClient,
    url: string,
    cookie = acme.cookie,
  ): Promise<Response> {
    return target.send('POST', '/v1/webhooks', {
      body: { url, events: ['record.created'] },
      cookie,
    })
  }

  /**
   * Each registration is an endpoint the process may have to call on every
   * event, so one workspace cannot hold an unlimited number of them.
   */
  describe('the registration limit', () => {
    it('refuses the registration after the last allowed one, with a 409', async () => {
      for (let index = 0; index < DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE; index += 1) {
        expect((await register(client, `https://example.com/hooks/${String(index)}`)).status).toBe(201)
      }

      const refused = await register(client, 'https://example.com/hooks/one-too-many')
      const body = readRecord(await refused.json())

      expect(refused.status).toBe(409)
      expect(readRecord(body.error).code).toBe('conflict')
      expect(readString(readRecord(body.error), 'message')).toContain(
        `at most ${String(DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE)} webhooks`,
      )
      expect(await countRegistrations(acme.workspaceId)).toBe(DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE)
    })

    it('counts one workspace, not the deployment', async () => {
      const narrow = await appWith({ WEBHOOK_MAX_PER_WORKSPACE: '1' })
      const other = await narrow.client.owner('mallory@example.com')

      expect((await register(narrow.client, 'https://example.com/acme')).status).toBe(201)
      expect((await register(narrow.client, 'https://example.com/acme-2')).status).toBe(409)
      expect((await register(narrow.client, 'https://example.com/other', other.cookie)).status).toBe(201)
    })

    /**
     * A deployment may lower the limit under a workspace that is already over
     * it. Nothing is deleted for the customer: they cannot add one until they
     * are under the limit again.
     */
    it('keeps the rows of a workspace that is over the limit, and refuses a new one until it is under', async () => {
      const ids: string[] = []

      for (const name of ['one', 'two', 'three']) {
        ids.push(readString(await createWebhook({ url: `https://example.com/${name}` }), 'id'))
      }

      const narrow = await appWith({ WEBHOOK_MAX_PER_WORKSPACE: '2' })

      expect((await register(narrow.client, 'https://example.com/four')).status).toBe(409)
      expect(await countRegistrations(acme.workspaceId)).toBe(3)
      expect(readList(await (await narrow.client.send('GET', '/v1/webhooks', { cookie: acme.cookie })).json())).toHaveLength(3)

      // Still at the limit after one goes, so still refused.
      await narrow.client.send('DELETE', `/v1/webhooks/${ids[0] ?? ''}`, { cookie: acme.cookie })
      expect((await register(narrow.client, 'https://example.com/four')).status).toBe(409)

      await narrow.client.send('DELETE', `/v1/webhooks/${ids[1] ?? ''}`, { cookie: acme.cookie })
      expect((await register(narrow.client, 'https://example.com/four')).status).toBe(201)
      expect(await countRegistrations(acme.workspaceId)).toBe(2)
    })

    /** A paused hook still holds its place: resuming it must never put a workspace over. */
    it('counts a paused registration', async () => {
      const narrow = await appWith({ WEBHOOK_MAX_PER_WORKSPACE: '1' })
      const id = readString(await createWebhook(), 'id')

      await client.send('PATCH', `/v1/webhooks/${id}`, { body: { status: 'paused' }, cookie: acme.cookie })

      expect((await register(narrow.client, 'https://example.com/second')).status).toBe(409)
    })

    /**
     * The count and the insert are one decision. The suite plays a
     * registration in flight: it has the lock, it has written its row, and it
     * has not committed. A request that counted without waiting would not see
     * that row, and would take the same last place.
     */
    it('waits for a registration in flight before it counts, so two cannot take the last place', async () => {
      const narrow = await appWith({ WEBHOOK_MAX_PER_WORKSPACE: '2' })
      await createWebhook({ url: 'https://example.com/one' })

      let settled = false
      let racing: Promise<Response> | undefined

      await database.db.transaction(async (tx) => {
        await lockRegistrations(tx, acme.workspaceId)
        await tx.insert(webhooks).values({
          id: harness.services.createId('webhook'),
          workspaceId: acme.workspaceId,
          url: 'https://example.com/in-flight',
          events: ['record.created'],
          secretEncrypted: 'sealed-by-the-suite',
          secretPrefix: 'whsec_…test',
        })

        racing = register(narrow.client, 'https://example.com/racing').finally(() => {
          settled = true
        })

        // Commit only once the request is waiting on the lock. If it answers
        // first it did not wait, and the assertions below say so.
        await expect
          .poll(async () => settled || (await countLockWaits(database.db)) > 0)
          .toBe(true)
      })

      expect((await racing)?.status).toBe(409)
      expect(await countRegistrations(acme.workspaceId)).toBe(2)
    })

    /** A bad value stops boot. It does not run the service with no limit. */
    it('refuses to boot on a limit that is not a whole number', async () => {
      await expect(appWith({ WEBHOOK_MAX_PER_WORKSPACE: 'plenty' })).rejects.toThrow()
      await expect(appWith({ WEBHOOK_MAX_CONCURRENT_DELIVERIES: '0' })).rejects.toThrow()
      await expect(appWith({ WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: 'some' })).rejects.toThrow()
    })
  })

  /**
   * The process that delivers is the process that serves every workspace. The
   * engine runs a bounded number of deliveries and keeps a bounded number
   * waiting; one over both is written to the log and never sent.
   */
  describe('the delivery limit', () => {
    async function deliveriesOf(id: string): Promise<Record<string, unknown>[]> {
      return readList(
        await (await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json(),
      )
    }

    const PAYLOAD = { object_type: 'person', record_id: 'per_01J8ZQ3R9V6X' }

    /** Limits under which one workspace may have everything, for the tests of the process limits alone. */
    function unshared(maxConcurrent: number, maxWaiting: number): DeliveryLimits {
      return {
        maxConcurrent,
        maxWaiting,
        maxConcurrentPerWorkspace: maxConcurrent,
        maxWaitingPerWorkspace: maxWaiting,
      }
    }

    /**
     * An engine of the suite's own on the harness's database, so a test can
     * hold a delivery in flight, read the log lines, and move the clock.
     */
    function directEngine(options: {
      readonly send: SendDelivery
      readonly limits: DeliveryLimits
      readonly now?: () => Date
    }): { engine: DeliveryEngine; logLines: string[] } {
      const logLines: string[] = []

      const engine = createDeliveryEngine({
        db: harness.services.db,
        transaction: harness.services.transaction,
        createId: harness.services.createId,
        now: options.now ?? ((): Date => new Date()),
        cipher: createSecretCipher({ SECRET_ENCRYPTION_KEY: TEST_SECRET_ENCRYPTION_KEY }),
        send: options.send,
        sleep,
        retentionDays: DEFAULT_DELIVERY_RETENTION_DAYS,
        limiter: createDeliveryLimiter(options.limits),
        log: createLogger({ level: 'debug', transports: [createCaptureTransport((line) => logLines.push(line))] }),
      })

      return { engine, logLines }
    }

    function linesNamed(logLines: readonly string[], message: string): Record<string, unknown>[] {
      return logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.message === message)
    }

    it('records a delivery over the limit as failed, sends nothing for it, and leaves the hook active', async () => {
      const narrow = await appWith({
        WEBHOOK_MAX_CONCURRENT_DELIVERIES: '1',
        WEBHOOK_MAX_WAITING_DELIVERIES: '0',
        WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: '1',
        WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: '0',
      })
      const ids = [
        readString(await createWebhook({ url: 'https://example.com/one' }), 'id'),
        readString(await createWebhook({ url: 'https://example.com/two' }), 'id'),
      ]

      const created = await narrow.client.send('POST', '/v1/people', {
        body: { name: 'Ada Lovelace', email: 'ada@example.com' },
        cookie: acme.cookie,
      })
      expect(created.status).toBe(201)
      await narrow.app.services.events.drain()

      // One slot and no line: the first registration the fan-out reaches is
      // sent, and the other finds no room.
      expect(sent).toHaveLength(1)

      const logs = await Promise.all(ids.map((id) => deliveriesOf(id)))
      const refused = logs.flat().filter((delivery) => delivery.attempts === 0)
      const delivered = logs.flat().filter((delivery) => delivery.attempts === 1)

      expect(logs.flat()).toHaveLength(2)
      expect(delivered).toHaveLength(1)
      expect(delivered.at(0)?.status).toBe('success')
      expect(refused).toHaveLength(1)
      expect(refused.at(0)?.status).toBe('failed')
      expect(refused.at(0)?.delivered_at).toBeNull()
      expect(refused.at(0)?.event).toBe('record.created')
      expect(() => webhookDeliverySchema.parse(refused.at(0))).not.toThrow()
      // The row shows the event that was not sent, in the shape of a body.
      expect(readRecord(refused.at(0)?.payload)).toMatchObject({
        id: refused.at(0)?.id,
        event: 'record.created',
        workspace_id: acme.workspaceId,
      })

      // The endpoint was never called, so it has not failed. The limit is
      // the service's, and `failing` would blame the customer's server.
      const listed = await listWebhooks()

      expect(listed.map((webhook) => webhook.status)).toEqual(['active', 'active'])
      expect(listed.map((webhook) => webhook.last_delivery_status).sort()).toEqual(['failed', 'success'])
    })

    it('leaves a failing hook failing when its delivery is over the limit', async () => {
      const first = readString(await createWebhook({ url: 'https://example.com/one' }), 'id')
      const second = readString(await createWebhook({ url: 'https://example.com/two' }), 'id')

      outcome = REFUSED
      await createPerson('Ada Lovelace')
      expect((await listWebhooks()).map((webhook) => webhook.status)).toEqual(['failing', 'failing'])

      outcome = DELIVERED
      const { engine } = directEngine({ send, limits: unshared(1, 0) })

      await engine.deliver({ workspaceId: acme.workspaceId, event: 'record.created', data: PAYLOAD })

      const statuses = new Map((await listWebhooks()).map((webhook) => [webhook.id, webhook.status]))
      const refused = (await deliveriesOf(first)).some((delivery) => delivery.attempts === 0) ? first : second
      const reached = refused === first ? second : first

      // The one that was reached recovered. The one that was not says what
      // the last real attempt said.
      expect(statuses.get(reached)).toBe('active')
      expect(statuses.get(refused)).toBe('failing')
    })

    it('sends a delivery that had to wait, once a slot frees', async () => {
      const narrow = await appWith({
        WEBHOOK_MAX_CONCURRENT_DELIVERIES: '1',
        WEBHOOK_MAX_WAITING_DELIVERIES: '5',
        WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: '1',
        WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: '5',
      })

      for (const name of ['one', 'two', 'three']) {
        await createWebhook({ url: `https://example.com/${name}` })
      }

      const created = await narrow.client.send('POST', '/v1/people', {
        body: { name: 'Ada Lovelace', email: 'ada@example.com' },
        cookie: acme.cookie,
      })
      expect(created.status).toBe(201)
      await narrow.app.services.events.drain()

      expect(sent.map((request) => request.url).sort()).toEqual([
        'https://example.com/one',
        'https://example.com/three',
        'https://example.com/two',
      ])
      expect((await listWebhooks()).map((webhook) => webhook.last_delivery_status)).toEqual([
        'success',
        'success',
        'success',
      ])
    })

    /** The limit is on the process, so two events share it. */
    it('runs no more than the limit at one time across events', async () => {
      for (const name of ['one', 'two', 'three']) {
        await createWebhook({ url: `https://example.com/${name}` })
      }

      let inFlight = 0
      let most = 0
      const releases: (() => void)[] = []
      const held: SendDelivery = async () => {
        inFlight += 1
        most = Math.max(most, inFlight)

        await new Promise<void>((resolve) => {
          releases.push(resolve)
        })

        inFlight -= 1

        return DELIVERED
      }
      const { engine } = directEngine({ send: held, limits: unshared(2, 100) })
      const event = { workspaceId: acme.workspaceId, event: 'record.created', data: PAYLOAD } as const

      const both = Promise.all([engine.deliver(event), engine.deliver(event)])

      // Six deliveries, two slots. Release one at a time until all are sent.
      for (let finished = 0; finished < 6; finished += 1) {
        await expect.poll(() => releases.length).toBeGreaterThan(0)
        expect(inFlight).toBeLessThanOrEqual(2)
        releases.shift()?.()
      }

      await both

      expect(most).toBe(2)
    })

    /**
     * A receiver refuses a body whose `created_at` is old. The body is built
     * when the delivery takes its slot, so the time it spent in the line does
     * not count against it.
     */
    it('dates a delivery from when it starts, not from when it joined the line', async () => {
      await createWebhook({ url: 'https://example.com/one' })
      await createWebhook({ url: 'https://example.com/two' })

      let clock = new Date('2026-08-24T01:00:00.000Z')
      const bodies: { created_at: string }[] = []
      const releases: (() => void)[] = []
      const held: SendDelivery = async (request) => {
        bodies.push(JSON.parse(request.body) as { created_at: string })

        await new Promise<void>((resolve) => {
          releases.push(resolve)
        })

        return DELIVERED
      }
      const { engine } = directEngine({
        send: held,
        limits: unshared(1, 1),
        now: () => clock,
      })

      const delivering = engine.deliver({
        workspaceId: acme.workspaceId,
        event: 'record.created',
        data: PAYLOAD,
      })

      await expect.poll(() => releases.length).toBe(1)
      // Ten minutes pass while the second delivery waits for the only slot.
      clock = new Date('2026-08-24T01:10:00.000Z')
      releases.shift()?.()

      await expect.poll(() => releases.length).toBe(1)
      releases.shift()?.()
      await delivering

      expect(bodies.map((body) => body.created_at)).toEqual([
        '2026-08-24T01:00:00.000Z',
        '2026-08-24T01:10:00.000Z',
      ])
    })

    it('logs a delivery over the limit with the reason and the settings to raise', async () => {
      await createWebhook({ url: 'https://example.com/one' })
      await createWebhook({ url: 'https://example.com/two' })

      const { engine, logLines } = directEngine({ send, limits: unshared(1, 0) })

      await engine.deliver({ workspaceId: acme.workspaceId, event: 'record.created', data: PAYLOAD })

      const refused = linesNamed(logLines, 'webhook delivery not attempted')

      expect(refused).toHaveLength(1)
      expect(refused[0]).toMatchObject({
        level: 'warn',
        workspaceId: acme.workspaceId,
        event: 'record.created',
        reason: DELIVERY_REFUSED_REASONS.workspace,
      })
      expect(DELIVERY_REFUSED_REASONS.workspace).toContain('WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE')
      expect(DELIVERY_REFUSED_REASONS.process).toContain('WEBHOOK_MAX_WAITING_DELIVERIES')
      // Not the line for an endpoint that failed: nothing was sent.
      expect(linesNamed(logLines, 'webhook delivery failed')).toEqual([])
    })

    /**
     * The process limits alone would let one workspace with slow endpoints
     * hold every slot and fill the line. Each workspace has a share of both,
     * so another workspace's delivery is still sent.
     */
    describe('the share of one workspace', () => {
      it('sends for another workspace while one is at its share, and refuses only the one over it', async () => {
        for (const name of ['one', 'two', 'three']) {
          await createWebhook({ url: `https://example.com/acme/${name}` })
        }

        const other = await client.owner('mallory@example.com')
        const otherId = readString(
          await createWebhook({ url: 'https://example.com/other' }, other.cookie),
          'id',
        )

        const inFlight: string[] = []
        const releases: (() => void)[] = []
        const held: SendDelivery = async (request) => {
          inFlight.push(request.url)

          await new Promise<void>((resolve) => {
            releases.push(resolve)
          })

          return DELIVERED
        }
        const { engine, logLines } = directEngine({
          send: held,
          limits: {
            maxConcurrent: 3,
            maxWaiting: 3,
            maxConcurrentPerWorkspace: 1,
            maxWaitingPerWorkspace: 1,
          },
        })

        // Three deliveries for a share of one slot and one place in the line:
        // one runs, one waits, and one is refused.
        const acmeDelivering = engine.deliver({
          workspaceId: acme.workspaceId,
          event: 'record.created',
          data: PAYLOAD,
        })
        await expect.poll(() => inFlight.length).toBe(1)

        const otherDelivering = engine.deliver({
          workspaceId: other.workspaceId,
          event: 'record.created',
          data: PAYLOAD,
        })

        // In flight beside the first workspace's, which still holds its slot.
        await expect.poll(() => inFlight).toContain('https://example.com/other')
        expect(inFlight).toHaveLength(2)

        let settled = false
        const both = Promise.all([acmeDelivering, otherDelivering]).finally(() => {
          settled = true
        })

        await expect
          .poll(() => {
            releases.shift()?.()

            return settled
          })
          .toBe(true)
        await both

        const otherLog = readList(
          await (
            await client.send('GET', `/v1/webhooks/${otherId}/deliveries`, { cookie: other.cookie })
          ).json(),
        )

        expect(otherLog).toHaveLength(1)
        expect(otherLog.at(0)).toMatchObject({ status: 'success', attempts: 1 })

        const refused = linesNamed(logLines, 'webhook delivery not attempted')

        expect(refused).toHaveLength(1)
        expect(refused[0]).toMatchObject({
          workspaceId: acme.workspaceId,
          limit: 'workspace',
          reason: DELIVERY_REFUSED_REASONS.workspace,
        })
        expect(inFlight.filter((url) => url.startsWith('https://example.com/acme/'))).toHaveLength(2)
      })

      it('reads the share from the environment', async () => {
        const narrow = await appWith({
          WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: '1',
          WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: '0',
        })

        await createWebhook({ url: 'https://example.com/one' })
        await createWebhook({ url: 'https://example.com/two' })

        const created = await narrow.client.send('POST', '/v1/people', {
          body: { name: 'Ada Lovelace', email: 'ada@example.com' },
          cookie: acme.cookie,
        })
        expect(created.status).toBe(201)
        await narrow.app.services.events.drain()

        // The process has twenty slots. The workspace has one, and no place to wait.
        expect(sent).toHaveLength(1)
      })

      /** A share above the whole is no share. Boot refuses it. */
      it('refuses to boot on a workspace limit above the process limit', async () => {
        await expect(
          appWith({
            WEBHOOK_MAX_CONCURRENT_DELIVERIES: '4',
            WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: '5',
          }),
        ).rejects.toThrow()
        await expect(
          appWith({
            WEBHOOK_MAX_WAITING_DELIVERIES: '300',
            WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: '301',
          }),
        ).rejects.toThrow()
      })
    })

    /**
     * A delivery can wait for its slot, and then retry, for longer than an
     * admin takes to change the registration. The engine reads the
     * registration again when the delivery starts, and no delivery result is
     * written over `paused`.
     */
    describe('a registration that changes after its event', () => {
      interface HeldDeliveries {
        /** The registration whose request is in flight, held by the sender. */
        readonly inFlightId: string
        /** The registration whose delivery is in the line behind it. */
        readonly waitingId: string
        /** Every request the sender was given, in order. */
        readonly requests: DeliveryRequest[]
        readonly logLines: string[]
        /** Lets every held request answer, and waits for the event to settle. */
        finish(): Promise<void>
      }

      /**
       * Two registrations, one slot, and a sender that holds each request
       * until the test lets it answer: one delivery is in flight and the other
       * waits for the slot.
       *
       * @param answer What the endpoint answers once a request is let go.
       * @param startAs The status both registrations have when the event arrives.
       */
      async function holdOneAndQueueOne(
        answer: AttemptOutcome = DELIVERED,
        startAs: 'active' | 'failing' = 'active',
      ): Promise<HeldDeliveries> {
        const idByUrl = new Map<string, string>()

        for (const url of ['https://example.com/one', 'https://example.com/two']) {
          idByUrl.set(url, readString(await createWebhook({ url }), 'id'))
        }

        await database.db.update(webhooks).set({ status: startAs })

        const requests: DeliveryRequest[] = []
        const releases: (() => void)[] = []
        const held: SendDelivery = async (request) => {
          requests.push(request)

          await new Promise<void>((resolve) => {
            releases.push(resolve)
          })

          return answer
        }
        const { engine, logLines } = directEngine({ send: held, limits: unshared(1, 5) })

        let settled = false
        const delivering = engine
          .deliver({ workspaceId: acme.workspaceId, event: 'record.created', data: PAYLOAD })
          .finally(() => {
            settled = true
          })

        await expect.poll(() => requests.length).toBe(1)

        const inFlightId = idByUrl.get(requests.at(0)?.url ?? '')
        const waitingId = [...idByUrl.values()].find((id) => id !== inFlightId)

        if (inFlightId === undefined || waitingId === undefined) {
          throw new Error(`The first request went to an address the test did not register: ${requests.at(0)?.url ?? ''}`)
        }

        return {
          inFlightId,
          waitingId,
          requests,
          logLines,
          async finish() {
            await expect
              .poll(() => {
                releases.shift()?.()

                return settled
              })
              .toBe(true)
            await delivering
          },
        }
      }

      async function statusOf(id: string): Promise<unknown> {
        const response = await client.send('GET', `/v1/webhooks/${id}`, { cookie: acme.cookie })

        return readRecord(await response.json()).status
      }

      async function patch(id: string, body: Record<string, unknown>): Promise<void> {
        const response = await client.send('PATCH', `/v1/webhooks/${id}`, { body, cookie: acme.cookie })

        expect(response.status).toBe(200)
      }

      function errorLines(logLines: readonly string[]): Record<string, unknown>[] {
        return logLines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.level === 'error')
      }

      it('sends nothing to a registration paused while its delivery waited, and leaves it paused', async () => {
        const held = await holdOneAndQueueOne()

        await patch(held.waitingId, { status: 'paused' })
        await held.finish()

        expect(held.requests).toHaveLength(1)
        expect(await statusOf(held.waitingId)).toBe('paused')
        // Not sending is what the admin asked for. It is not a failure.
        expect(await deliveriesOf(held.waitingId)).toEqual([])
        expect(errorLines(held.logLines)).toEqual([])
      })

      it('posts to the address the registration has now, not the one it had at the event', async () => {
        const held = await holdOneAndQueueOne()

        await patch(held.waitingId, { url: 'https://example.com/moved' })
        await held.finish()

        expect(held.requests).toHaveLength(2)
        expect(held.requests.at(1)?.url).toBe('https://example.com/moved')
      })

      it('signs with the secret the registration has now', async () => {
        const held = await holdOneAndQueueOne()
        const rotated = await client.send('POST', `/v1/webhooks/${held.waitingId}/rotate_secret`, {
          cookie: acme.cookie,
        })
        const secret = readString(readRecord(await rotated.json()), 'secret')

        await held.finish()

        const request = held.requests.at(1)

        expect(request?.headers[SIGNATURE_HEADER]).toBe(
          `sha256=${createHmac('sha256', secret).update(request?.body ?? '', 'utf8').digest('hex')}`,
        )
      })

      it('sends nothing to a registration deleted while its delivery waited, and reports no error', async () => {
        const held = await holdOneAndQueueOne()
        const deleted = await client.send('DELETE', `/v1/webhooks/${held.waitingId}`, { cookie: acme.cookie })

        expect(deleted.status).toBe(204)
        await held.finish()

        expect(held.requests).toHaveLength(1)
        expect(errorLines(held.logLines)).toEqual([])
        expect(linesNamed(held.logLines, 'webhook delivery skipped')).toMatchObject([
          { webhookId: held.waitingId, reason: 'deleted' },
        ])
      })

      it('sends nothing to a registration that dropped the event while its delivery waited', async () => {
        const held = await holdOneAndQueueOne()

        await patch(held.waitingId, { events: ['form.submitted'] })
        await held.finish()

        expect(held.requests).toHaveLength(1)
        expect(await deliveriesOf(held.waitingId)).toEqual([])
      })

      /**
       * The pause lands after the request left. The request was sent, so it is
       * in the log, and its result must not undo what the admin chose. Each
       * case is a result that would move the status if the pause were not there.
       */
      it.each([
        { name: 'a failure on an active registration', before: 'active', answer: REFUSED, logged: 'failed' },
        { name: 'a success on a failing registration', before: 'failing', answer: DELIVERED, logged: 'success' },
      ] as const)('leaves a registration paused when its delivery settles after the pause: $name', async ({ before, answer, logged }) => {
        const held = await holdOneAndQueueOne(answer, before)

        await patch(held.inFlightId, { status: 'paused' })
        await held.finish()

        expect(await statusOf(held.inFlightId)).toBe('paused')
        expect((await deliveriesOf(held.inFlightId)).map((delivery) => delivery.status)).toEqual([logged])
        // The other registration was not paused, and its result moved it as before.
        expect(await statusOf(held.waitingId)).toBe(answer.delivered ? 'active' : 'failing')
      })

      it('records nothing, and reports no error, for a registration deleted while its request was in flight', async () => {
        const held = await holdOneAndQueueOne()
        const deleted = await client.send('DELETE', `/v1/webhooks/${held.inFlightId}`, { cookie: acme.cookie })

        expect(deleted.status).toBe(204)
        await held.finish()

        expect(held.requests).toHaveLength(2)
        expect(errorLines(held.logLines)).toEqual([])
        expect(
          await database.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, held.inFlightId)),
        ).toEqual([])
      })

      /**
       * A delivery over the limit writes a row at once, with no wait in which
       * to read the registration again. The suite plays a delete in flight:
       * the row is still listed, and is gone by the time the log is written.
       */
      it('records nothing, and reports no error, for a refused delivery whose registration was deleted', async () => {
        const id = readString(await createWebhook(), 'id')
        const releases: (() => void)[] = []
        const held: SendDelivery = async () => {
          await new Promise<void>((resolve) => {
            releases.push(resolve)
          })

          return DELIVERED
        }
        const { engine, logLines } = directEngine({ send: held, limits: unshared(1, 0) })
        const event = { workspaceId: acme.workspaceId, event: 'record.created', data: PAYLOAD } as const

        // Takes the only slot, so the next delivery is refused.
        const first = engine.deliver(event)
        await expect.poll(() => releases.length).toBe(1)

        let settled = false
        let second: Promise<void> | undefined

        await database.db.transaction(async (tx) => {
          await tx.delete(webhooks).where(eq(webhooks.id, id))

          second = engine.deliver(event).finally(() => {
            settled = true
          })

          // Commit the delete only once the engine is waiting on the row.
          await expect
            .poll(async () => settled || (await countLockWaits(database.db)) > 0)
            .toBe(true)
        })

        await second
        releases.shift()?.()
        await first

        expect(linesNamed(logLines, 'webhook delivery not attempted')).toHaveLength(1)
        expect(errorLines(logLines)).toEqual([])
        expect(await database.db.select().from(webhookDeliveries)).toEqual([])
      })
    })

    /**
     * The real sender behind an egress guard whose resolver is injected, so no
     * request leaves. An admin reads the delivery log, and what a host name
     * resolves to inside the deployment's network is not theirs to learn.
     */
    describe('an endpoint the egress guard refuses', () => {
      const REFUSED_ADDRESS = '10.0.0.5'

      it.each([
        { name: 'before the request', answers: [[REFUSED_ADDRESS]] },
        // DNS rebinding: the check sees a public address, and the connection a private one.
        { name: 'at the connection', answers: [['93.184.216.34'], [REFUSED_ADDRESS]] },
      ])('gives the address to the log line and to nothing a customer reads, $name', async ({ answers }) => {
        const id = readString(await createWebhook(), 'id')
        const remaining = [...answers]
        const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, () =>
          Promise.resolve(remaining.shift() ?? [REFUSED_ADDRESS]),
        )
        const { engine, logLines } = directEngine({
          send: createHttpSender(guard),
          limits: unshared(1, 0),
        })

        await engine.deliver({ workspaceId: acme.workspaceId, event: 'record.created', data: PAYLOAD })

        const failures = linesNamed(logLines, 'webhook delivery failed')

        expect(failures).toHaveLength(1)
        expect(failures[0]).toMatchObject({
          level: 'warn',
          webhookId: id,
          attempts: MAX_DELIVERY_ATTEMPTS,
          blockedAddress: REFUSED_ADDRESS,
          reason:
            'BlockedEgressError: Refusing to connect to example.com: the host has a private or reserved address',
        })

        const listed = await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })
        const rows = await database.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, id))

        expect(rows).toHaveLength(1)
        expect(rows.at(0)?.status).toBe('failed')
        expect(JSON.stringify(rows)).not.toContain(REFUSED_ADDRESS)
        expect(await listed.text()).not.toContain(REFUSED_ADDRESS)
        expect(JSON.stringify(await listWebhooks())).not.toContain(REFUSED_ADDRESS)
      })

      it('adds no address to the log line of a failure the guard did not cause', async () => {
        await createWebhook()
        const { engine, logLines } = directEngine({
          send: createHttpSender(createEgressGuard({ BLOCK_PRIVATE_EGRESS: false }), () =>
            Promise.reject(new TypeError('fetch failed')),
          ),
          limits: unshared(1, 0),
        })

        await engine.deliver({ workspaceId: acme.workspaceId, event: 'record.created', data: PAYLOAD })

        const failures = linesNamed(logLines, 'webhook delivery failed')

        expect(failures).toHaveLength(1)
        expect(failures[0]).toMatchObject({ reason: 'TypeError: fetch failed' })
        expect(failures[0]).not.toHaveProperty('blockedAddress')
      })
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
