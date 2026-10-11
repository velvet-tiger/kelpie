import { createHmac } from 'node:crypto'
import { createdWebhookSchema, webhookDeliverySchema, webhookSchema } from '@kelpie/schemas'
import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createEgressGuard } from '../../lib/egress.ts'
import { createCaptureTransport, createLogger } from '../../lib/logger.ts'
import { createSecretCipher } from '../../lib/secrets.ts'
import type { Transaction } from '../../runtime/transaction.ts'
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
import { createWebhooksModule } from './index.ts'
import { DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE } from './limits.ts'
import { lockRegistrations, rotateWebhookSecret } from './repository.ts'
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

    /**
     * A rotation reads nothing before it writes, so the workspace in the
     * statement's own condition is the only thing between an admin of one
     * workspace and the signing secret of another.
     */
    it('refuses to rotate the secret of a webhook in another workspace, and changes nothing', async () => {
      const id = readString(await createWebhook(), 'id')
      const other = await client.owner('mallory@example.com')

      async function storedSecret(): Promise<Record<string, unknown> | undefined> {
        const [row] = await database.db
          .select({
            secretEncrypted: webhooks.secretEncrypted,
            secretPrefix: webhooks.secretPrefix,
            previousSecretEncrypted: webhooks.previousSecretEncrypted,
            previousSecretExpiresAt: webhooks.previousSecretExpiresAt,
            updatedAt: webhooks.updatedAt,
          })
          .from(webhooks)
          .where(eq(webhooks.id, id))

        return row
      }

      const before = await storedSecret()

      for (const body of [undefined, { overlap: true }]) {
        const response = await client.send('POST', `/v1/webhooks/${id}/rotate_secret`, {
          cookie: other.cookie,
          ...(body === undefined ? {} : { body }),
        })

        expect(response.status).toBe(404)
        expect(await response.text()).not.toContain('whsec_')
      }

      expect(before?.previousSecretEncrypted).toBeNull()
      expect(await storedSecret()).toEqual(before)
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

    it('404s for a webhook that does not exist', async () => {
      const response = await rotate('wh_01JZZZZZZZZZZZZZZZZZZZZZZZ')

      expect(response.status).toBe(404)
    })

    it('refuses a field it does not know rather than rotating anyway', async () => {
      const id = readString(await createWebhook(), 'id')

      expect((await rotate(id, { overlap_hours: 72 })).status).toBe(422)
    })

    /**
     * The outgoing secret is moved by the rotation's own statement, from the
     * value the column holds at that moment. Each test plays a write that
     * lands between the request's arrival and its write: the suite holds it
     * open in a transaction, starts the rotation, and commits once the
     * rotation is waiting on the row. A rotation that carried a copy it read
     * on arrival would write that stale copy.
     */
    describe('a write that lands while a rotation is in flight', () => {
      const current = createSecretCipher({ SECRET_ENCRYPTION_KEY: TEST_SECRET_ENCRYPTION_KEY })
      /** A key the service no longer seals under: the previous key of an encryption key rotation. */
      const underPreviousKey = createSecretCipher({
        SECRET_ENCRYPTION_KEY: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      })

      /** Rotates with an overlap around a write the suite has not committed when the request arrives. */
      async function rotateAround(id: string, write: (tx: Transaction) => Promise<void>): Promise<Response> {
        let settled = false
        let rotating: Promise<Response> | undefined

        await database.db.transaction(async (tx) => {
          await write(tx)

          rotating = rotate(id, { overlap: true }).finally(() => {
            settled = true
          })

          // Commit only once the rotation is waiting on the row.
          await expect
            .poll(async () => settled || (await countLockWaits(database.db)) > 0)
            .toBe(true)
        })

        if (rotating === undefined) {
          throw new Error('unreachable: the rotation starts inside the transaction')
        }

        return rotating
      }

      async function storedSecrets(id: string): Promise<{ current: string; previous: string | null }> {
        const [row] = await database.db
          .select({ current: webhooks.secretEncrypted, previous: webhooks.previousSecretEncrypted })
          .from(webhooks)
          .where(eq(webhooks.id, id))

        if (row === undefined) {
          throw new Error(`No webhook ${id}`)
        }

        return row
      }

      /**
       * The reseal pass re-seals the secret under the current key after the
       * rotation request arrived and before it wrote. The secret the rotation
       * retires must be the re-sealed one, or the previous key's ciphertext
       * is back in the row after the pass reported it gone.
       */
      it('retires the secret as the reseal pass left it, under the current key', async () => {
        const created = await createWebhook()
        const id = readString(created, 'id')
        const original = readString(created, 'secret')

        // As the row is in the middle of an encryption key rotation.
        await database.db
          .update(webhooks)
          .set({ secretEncrypted: underPreviousKey.seal(original) })
          .where(eq(webhooks.id, id))

        const response = await rotateAround(id, async (tx) => {
          await tx
            .update(webhooks)
            .set({ secretEncrypted: current.seal(original) })
            .where(eq(webhooks.id, id))
        })
        const replacement = readString(readRecord(await response.json()), 'secret')
        const row = await storedSecrets(id)

        expect(response.status).toBe(200)
        expect(current.open(row.current)).toBe(replacement)
        // Opens with the current key alone, so the previous key can go.
        expect(current.open(row.previous ?? '')).toBe(original)
      })

      /**
       * Two rotations at the same moment behave as one after the other: the
       * second retires the secret the first one issued. If each carried the
       * secret it read on arrival, the first one's secret would be in neither
       * column, and the admin who was just given it would hold a secret that
       * verifies nothing.
       */
      it('retires the secret of a rotation that finished first, not the one both began from', async () => {
        const created = await createWebhook()
        const id = readString(created, 'id')

        const response = await rotateAround(id, async (tx) => {
          await rotateWebhookSecret(tx, acme.workspaceId, id, {
            secretEncrypted: current.seal('whsec_from_the_first_rotation'),
            secretPrefix: 'whsec_…tion',
            previousSecretExpiresAt: new Date(Date.now() + 60_000),
            updatedAt: new Date(),
          })
        })
        const replacement = readString(readRecord(await response.json()), 'secret')
        const row = await storedSecrets(id)

        expect(current.open(row.current)).toBe(replacement)
        expect(current.open(row.previous ?? '')).toBe('whsec_from_the_first_rotation')
      })
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

    /**
     * The tool calls the same service as the route, so an agent at the limit
     * gets the refusal a person gets, and cannot register past it.
     */
    it('gives the webhooks_create MCP tool the same refusal as the REST route', async () => {
      const narrow = await appWith({ WEBHOOK_MAX_PER_WORKSPACE: '1' })
      const minted = await narrow.client.send('POST', '/v1/api-keys', {
        body: { name: 'agent', kind: 'workspace', full_access: true },
        cookie: acme.cookie,
      })
      expect(minted.status).toBe(201)
      const bearer = readString(await minted.json(), 'secret')

      async function createByTool(url: string): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
        const response = await narrow.app.app.request('/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'webhooks_create', arguments: { url, events: ['record.created'] } },
          }),
        })
        const result = readRecord(readRecord(await response.json()).result)
        const [content] = result.content as { text: string }[]

        return { isError: result.isError === true, payload: readRecord(JSON.parse(content?.text ?? 'null')) }
      }

      // The tool registers while there is room, so the refusal below is the limit's.
      const first = await createByTool('https://example.com/by-tool')

      expect(first.isError).toBe(false)
      expect(readString(first.payload, 'secret').startsWith('whsec_')).toBe(true)

      const byTool = await createByTool('https://example.com/by-tool-2')
      const byRoute = await register(narrow.client, 'https://example.com/by-route')

      expect(byRoute.status).toBe(409)
      expect(byTool.isError).toBe(true)
      expect(readRecord(byTool.payload.error)).toMatchObject({
        code: 'conflict',
        message: 'A workspace may register at most 1 webhook',
      })
      expect(byTool.payload).toEqual(readRecord(await byRoute.json()))
      expect(await countRegistrations(acme.workspaceId)).toBe(1)
    })

    /** A bad value stops boot. It does not run the service with no limit. */
    it('refuses to boot on a limit that is not a whole number', async () => {
      await expect(appWith({ WEBHOOK_MAX_PER_WORKSPACE: 'plenty' })).rejects.toThrow()
      await expect(appWith({ WEBHOOK_MAX_PER_WORKSPACE: '0' })).rejects.toThrow()
    })
  })

  /**
   * An engine of the suite's own on the harness's database, so a test can hold
   * a request in flight and read the log lines. Everything it writes lands in
   * the same rows the app's own engine would write.
   */
  describe('a delivery in flight', () => {
    async function deliveriesOf(id: string): Promise<Record<string, unknown>[]> {
      return readList(
        await (await client.send('GET', `/v1/webhooks/${id}/deliveries`, { cookie: acme.cookie })).json(),
      )
    }

    const PAYLOAD = { object_type: 'person', record_id: 'per_01J8ZQ3R9V6X' }

    function directEngine(sendDelivery: SendDelivery): { engine: DeliveryEngine; logLines: string[] } {
      const logLines: string[] = []

      const engine = createDeliveryEngine({
        db: harness.services.db,
        transaction: harness.services.transaction,
        createId: harness.services.createId,
        now: () => new Date(),
        cipher: createSecretCipher({ SECRET_ENCRYPTION_KEY: TEST_SECRET_ENCRYPTION_KEY }),
        send: sendDelivery,
        sleep,
        retentionDays: DEFAULT_DELIVERY_RETENTION_DAYS,
        log: createLogger({ level: 'debug', transports: [createCaptureTransport((line) => logLines.push(line))] }),
      })

      return { engine, logLines }
    }

    function linesNamed(logLines: readonly string[], message: string): Record<string, unknown>[] {
      return logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.message === message)
    }

    /**
     * A delivery retries for about a minute, which is longer than an admin
     * takes to pause or delete the registration. Its request was built before
     * the change and is still sent, but its result must not undo what the
     * admin chose, and a registration that has gone has no log to write to.
     */
    describe('a registration that changes during the retries', () => {
      interface HeldDeliveries {
        /** The registration the test changes while its request is in flight. */
        readonly changedId: string
        /** A second registration the test leaves alone, to show a result still moves it. */
        readonly otherId: string
        /** Every request the sender was given, in order. */
        readonly requests: DeliveryRequest[]
        readonly logLines: string[]
        /** Lets every held request answer, retries included, and waits for the event to settle. */
        finish(): Promise<void>
      }

      /**
       * Two registrations and a sender that holds each request until the test
       * lets it answer, so both deliveries are in flight when this returns.
       *
       * @param answer What the endpoint answers once a request is let go.
       * @param startAs The status both registrations have when the event arrives.
       */
      async function holdDeliveries(
        answer: AttemptOutcome,
        startAs: 'active' | 'failing',
      ): Promise<HeldDeliveries> {
        const changedId = readString(await createWebhook({ url: 'https://example.com/changed' }), 'id')
        const otherId = readString(await createWebhook({ url: 'https://example.com/other' }), 'id')

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
        const { engine, logLines } = directEngine(held)

        let settled = false
        const delivering = engine
          .deliver({ workspaceId: acme.workspaceId, event: 'record.created', data: PAYLOAD })
          .finally(() => {
            settled = true
          })

        await expect.poll(() => requests.length).toBe(2)

        return {
          changedId,
          otherId,
          requests,
          logLines,
          async finish() {
            // Every held request goes in each poll. A refused delivery sends
            // four requests one after another, and one release for each poll
            // would spend most of the default timeout on waiting alone.
            await expect
              .poll(
                () => {
                  for (const release of releases.splice(0)) {
                    release()
                  }

                  return settled
                },
                { timeout: 5_000 },
              )
              .toBe(true)
            await delivering
          },
        }
      }

      async function statusOf(id: string): Promise<unknown> {
        const response = await client.send('GET', `/v1/webhooks/${id}`, { cookie: acme.cookie })

        return readRecord(await response.json()).status
      }

      function errorLines(logLines: readonly string[]): Record<string, unknown>[] {
        return logLines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.level === 'error')
      }

      /**
       * The pause lands after the request left. The request was sent, so it is
       * in the log. Each case is a result that would move the status if the
       * pause were not there.
       */
      it.each([
        { name: 'a failure on an active registration', before: 'active', answer: REFUSED, logged: 'failed' },
        { name: 'a success on a failing registration', before: 'failing', answer: DELIVERED, logged: 'success' },
      ] as const)('leaves a registration paused when its delivery settles after the pause: $name', async ({ before, answer, logged }) => {
        const held = await holdDeliveries(answer, before)
        const paused = await client.send('PATCH', `/v1/webhooks/${held.changedId}`, {
          body: { status: 'paused' },
          cookie: acme.cookie,
        })

        expect(paused.status).toBe(200)
        await held.finish()

        expect(await statusOf(held.changedId)).toBe('paused')
        expect((await deliveriesOf(held.changedId)).map((delivery) => delivery.status)).toEqual([logged])
        // The other registration was not paused, and its result moved it as before.
        expect(await statusOf(held.otherId)).toBe(answer.delivered ? 'active' : 'failing')
        expect(errorLines(held.logLines)).toEqual([])
      })

      it('records nothing, and reports no error, for a registration deleted while its request was in flight', async () => {
        const held = await holdDeliveries(REFUSED, 'active')
        const deleted = await client.send('DELETE', `/v1/webhooks/${held.changedId}`, { cookie: acme.cookie })

        expect(deleted.status).toBe(204)
        await held.finish()

        // Its retries were still sent: the request was built before the delete.
        expect(held.requests).toHaveLength(MAX_DELIVERY_ATTEMPTS * 2)
        expect(errorLines(held.logLines)).toEqual([])
        expect(
          await database.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, held.changedId)),
        ).toEqual([])
        expect((await deliveriesOf(held.otherId)).map((delivery) => delivery.status)).toEqual(['failed'])
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
        const { engine, logLines } = directEngine(createHttpSender(guard))

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
        const { engine, logLines } = directEngine(
          createHttpSender(createEgressGuard({ BLOCK_PRIVATE_EGRESS: false }), () =>
            Promise.reject(new TypeError('fetch failed')),
          ),
        )

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
