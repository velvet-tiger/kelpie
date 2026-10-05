import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { users } from '../auth/schema.ts'
import { idempotencyKeys } from './schema.ts'

/**
 * `Idempotency-Key` handling on `POST /v1/*` (`docs/agents/api-and-webhooks.md`),
 * exercised against `/v1/people` as a representative endpoint: the middleware is
 * generic across every module, so one resource's routes are enough to prove it.
 */

const connectionString = testDatabaseUrl(process.env)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readErrorCode(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.error) || typeof payload.error.code !== 'string') {
    throw new Error(`Expected an error body, got ${JSON.stringify(payload)}`)
  }

  return payload.error.code
}

describe.skipIf(connectionString === undefined)('idempotency keys', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner

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
    harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()
  })

  function postPeople(body: Record<string, unknown>, idempotencyKey?: string): Promise<Response> {
    return Promise.resolve(
      harness.app.request('/v1/people', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: acme.cookie,
          ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
        },
        body: JSON.stringify(body),
      }),
    )
  }

  /** The `actor_key` the middleware stores for the owner's session. */
  async function ownerActorKey(): Promise<string> {
    const [owner] = await database.db.select().from(users).where(eq(users.email, 'ada@example.com'))

    if (owner === undefined) {
      throw new Error('The owner account does not exist')
    }

    return `user:${owner.id}`
  }

  /** Invites an address at `role` and accepts it as a fresh account. */
  async function addMember(email: string, role: 'admin' | 'member'): Promise<string> {
    const invited = await client.send('POST', `/v1/workspaces/${acme.workspaceId}/invites`, {
      body: { email, role },
      cookie: acme.cookie,
    })
    expect(invited.status).toBe(201)
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

  async function countPeople(): Promise<number> {
    const response = await harness.app.request('/v1/people', { headers: { Cookie: acme.cookie } })
    const payload: unknown = await response.json()

    return isRecord(payload) && Array.isArray(payload.data) ? payload.data.length : -1
  }

  it('creates a distinct record per request when no key is given', async () => {
    const first = await postPeople({ name: 'Ada Lovelace' })
    const second = await postPeople({ name: 'Ada Lovelace' })

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(await countPeople()).toBe(2)
  })

  it('does not require a credential on an unauthenticated auth endpoint', async () => {
    // Idempotency is workspace-scoped, so an unauthenticated auth POST has
    // nothing to key on. The middleware must skip it rather than resolve an
    // actor and answer 401, which would make the header unusable on exactly the
    // endpoints most likely to be retried.
    const response = await harness.app.request('/v1/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'onboarding-key' },
      body: JSON.stringify({
        email: 'newcomer@example.com',
        name: 'Newcomer',
        password: 'correct horse battery staple',
      }),
    })

    expect(response.status).toBe(201)
  })

  it('replays the first response for a repeated key and body, without creating a second record', async () => {
    const first = await postPeople({ name: 'Ada Lovelace' }, 'key-1')
    expect(first.status).toBe(201)
    const firstBody = readRecord(await first.json())

    const second = await postPeople({ name: 'Ada Lovelace' }, 'key-1')
    expect(second.status).toBe(201)
    const secondBody = readRecord(await second.json())

    expect(secondBody).toEqual(firstBody)
    expect(await countPeople()).toBe(1)
  })

  it('does not replay one member\'s response to another member', async () => {
    const first = await postPeople({ name: 'Ada Lovelace' }, 'key-shared')
    expect(first.status).toBe(201)
    const firstId = readRecord(await first.json()).id

    const member = await addMember('grace@example.com', 'member')
    const second = await harness.app.request('/v1/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: member, 'Idempotency-Key': 'key-shared' },
      body: JSON.stringify({ name: 'Ada Lovelace' }),
    })

    // The member's own request ran: a new record, not the owner's stored answer.
    expect(second.status).toBe(201)
    expect(readRecord(await second.json()).id).not.toBe(firstId)
    expect(await countPeople()).toBe(2)
  })

  it('does not hand a new API key secret to a member who repeats the request', async () => {
    const request = (cookie: string): Promise<Response> =>
      Promise.resolve(
        harness.app.request('/v1/api-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': 'key-mint' },
          body: JSON.stringify({ name: 'CI', kind: 'workspace' }),
        }),
      )

    const minted = await request(acme.cookie)
    expect(minted.status).toBe(201)

    const member = await addMember('grace@example.com', 'member')
    const attempt = await request(member)

    // The role check runs, because nothing is replayed to a different actor.
    expect(attempt.status).toBe(403)
  })

  it('keeps no copy of a response that holds a secret, and refuses the retry', async () => {
    const request = (): Promise<Response> =>
      Promise.resolve(
        harness.app.request('/v1/api-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: acme.cookie, 'Idempotency-Key': 'key-secret' },
          body: JSON.stringify({ name: 'CI', kind: 'workspace' }),
        }),
      )

    const minted = await request()
    expect(minted.status).toBe(201)
    expect(minted.headers.get('Cache-Control')).toBe('no-store')
    const secret = readRecord(await minted.json()).secret

    const [row] = await database.db.select().from(idempotencyKeys)
    expect(JSON.stringify(row)).not.toContain(String(secret))
    expect(row?.response).toEqual({ status: 201, body: null, withheld: true })

    const retry = await request()
    expect(retry.status).toBe(409)
    expect(readErrorCode(await retry.json())).toBe('conflict')

    // The retry did not make a second key.
    const listed = await harness.app.request('/v1/api-keys?kind=workspace', { headers: { Cookie: acme.cookie } })
    const payload: unknown = await listed.json()
    expect(isRecord(payload) && Array.isArray(payload.data) ? payload.data.length : -1).toBe(1)
  })

  it('answers 409 when the same key is replayed with a different body', async () => {
    const first = await postPeople({ name: 'Ada Lovelace' }, 'key-2')
    expect(first.status).toBe(201)

    const second = await postPeople({ name: 'Grace Hopper' }, 'key-2')

    expect(second.status).toBe(409)
    expect(readErrorCode(await second.json())).toBe('conflict')
    expect(await countPeople()).toBe(1)
  })

  it('answers 409 for a key whose reservation is still in flight', async () => {
    // Simulates a concurrent request that reserved the key and has not
    // answered yet, without depending on real request timing.
    await database.db.insert(idempotencyKeys).values({
      id: 'idem_in_flight',
      workspaceId: acme.workspaceId,
      actorKey: await ownerActorKey(),
      key: 'key-3',
      requestHash: 'irrelevant-while-response-is-null',
      response: null,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const response = await postPeople({ name: 'Ada Lovelace' }, 'key-3')

    expect(response.status).toBe(409)
    expect(readErrorCode(await response.json())).toBe('conflict')
    expect(await countPeople()).toBe(0)
  })

  it('runs the request again once the stored reservation has expired', async () => {
    await database.db.insert(idempotencyKeys).values({
      id: 'idem_expired',
      workspaceId: acme.workspaceId,
      actorKey: await ownerActorKey(),
      key: 'key-4',
      requestHash: 'stale-hash-from-a-different-body',
      response: { status: 201, body: { id: 'per_stale', name: 'Someone else entirely' } },
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 90_000),
    })

    const response = await postPeople({ name: 'Ada Lovelace' }, 'key-4')

    expect(response.status).toBe(201)
    const body = readRecord(await response.json())
    expect(body.id).not.toBe('per_stale')
    expect(body.name).toBe('Ada Lovelace')
    expect(await countPeople()).toBe(1)
  })

  it('deletes the reservation when the handler fails, so a retry is not blocked by it', async () => {
    // A strict body with an unknown field fails validation inside the route
    // handler, which is what the middleware treats as "the handler threw".
    const failed = await postPeople({ name: 'Ada Lovelace', not_a_real_field: true }, 'key-5')
    expect(failed.status).toBe(422)

    const retried = await postPeople({ name: 'Ada Lovelace' }, 'key-5')

    expect(retried.status).toBe(201)
    expect(await countPeople()).toBe(1)

    const rows = await database.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, 'key-5'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.response).not.toBeNull()
  })

  it('sweeps this workspace’s other expired keys on the next reservation', async () => {
    await database.db.insert(idempotencyKeys).values([
      {
        id: 'idem_old_1',
        workspaceId: acme.workspaceId,
        actorKey: await ownerActorKey(),
        key: 'old-key-1',
        requestHash: 'h1',
        response: { status: 201, body: {} },
        expiresAt: new Date(Date.now() - 60_000),
      },
      {
        id: 'idem_old_2',
        workspaceId: acme.workspaceId,
        actorKey: await ownerActorKey(),
        key: 'old-key-2',
        requestHash: 'h2',
        response: { status: 201, body: {} },
        expiresAt: new Date(Date.now() - 60_000),
      },
    ])

    const response = await postPeople({ name: 'Ada Lovelace' }, 'fresh-key')
    expect(response.status).toBe(201)

    const rows = await database.db
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.workspaceId, acme.workspaceId))

    expect(rows.map((row) => row.key).sort()).toEqual(['fresh-key'])
  })

  it('runs unguarded when the actor has no workspace yet', async () => {
    const cookie = await client.signUp('brand-new@example.com')

    const first = await harness.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': 'onboarding-key' },
      body: JSON.stringify({ name: 'New Co', timezone: 'Australia/Melbourne' }),
    })

    expect(first.status).toBe(201)
    expect(readString(await first.json(), 'name')).toBe('New Co')
  })

  it('does not require credentials on a public route', async () => {
    const response = await harness.app.request(
      '/v1/public/workspaces/workspace_unknown/forms/not-a-real-slug/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'public-key' },
        body: JSON.stringify({ answers: {} }),
      },
    )

    // Not found, from the form lookup — not 401, which is what an actor
    // resolution attempt on a public route would have answered instead. The
    // message proves the handler ran: an unmatched path is a 404 too.
    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).toContain('Form not found')
  })
})
