import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { coreModules } from '../modules/core.ts'
import { createTestApp } from '../testing/app.ts'
import type { TestApp } from '../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../testing/client.ts'
import type { TestClient, TestOwner } from '../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { TEST_ENVIRONMENT } from '../testing/environment.ts'
import { createTestServices } from '../testing/services.ts'

/**
 * The cross-site guard on `/v1`, through the whole app. `app.request` builds the
 * URL as `http://localhost/...`, so that is this deployment's own origin.
 */

const connectionString = testDatabaseUrl(process.env)

const OWN_ORIGIN = 'http://localhost'
const PASSWORD = 'correct horse battery staple'

describe.skipIf(connectionString === undefined)('cross-site guard', () => {
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

  function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, { method, headers, ...(body === undefined ? {} : { body }) }),
    )
  }

  function postPerson(headers: Record<string, string>): Promise<Response> {
    return send('POST', '/v1/people', headers, JSON.stringify({ name: 'Grace Hopper' }))
  }

  async function errorCode(response: Response): Promise<string> {
    return readString(readRecord(readRecord(await response.json()).error), 'code')
  }

  async function countPeople(): Promise<number> {
    const response = await client.send('GET', '/v1/people', { cookie: acme.cookie })

    return readList(await response.json()).length
  }

  async function mintKey(): Promise<string> {
    const response = await client.send('POST', '/v1/api-keys', {
      cookie: acme.cookie,
      body: { name: 'Agent', kind: 'workspace' },
    })

    return readString(await response.json(), 'secret')
  }

  describe('origin', () => {
    it('refuses a session request from another origin, and writes nothing', async () => {
      const response = await postPerson({
        'Content-Type': 'application/json',
        Cookie: acme.cookie,
        Origin: 'https://evil.example',
      })

      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('forbidden')
      expect(await countPeople()).toBe(0)
    })

    it('refuses a sibling subdomain and an opaque origin', async () => {
      for (const origin of ['http://forms.localhost', 'http://localhost:8080', 'null']) {
        const response = await postPerson({
          'Content-Type': 'application/json',
          Cookie: acme.cookie,
          Origin: origin,
        })

        expect(response.status, origin).toBe(403)
      }
    })

    it('refuses a cross-site request that states only Sec-Fetch-Site', async () => {
      for (const site of ['cross-site', 'same-site']) {
        const response = await postPerson({
          'Content-Type': 'application/json',
          Cookie: acme.cookie,
          'Sec-Fetch-Site': site,
        })

        expect(response.status, site).toBe(403)
      }
    })

    it('allows its own origin, and a client that sends no origin', async () => {
      const own = await postPerson({
        'Content-Type': 'application/json',
        Cookie: acme.cookie,
        Origin: OWN_ORIGIN,
        'Sec-Fetch-Site': 'same-origin',
      })
      const none = await postPerson({ 'Content-Type': 'application/json', Cookie: acme.cookie })

      expect(own.status).toBe(201)
      expect(none.status).toBe(201)
    })

    it('allows its own origin behind a proxy that ends TLS', async () => {
      const forwarded = await postPerson({
        'Content-Type': 'application/json',
        Cookie: acme.cookie,
        Origin: 'https://localhost',
        'X-Forwarded-Proto': 'https',
      })
      // A proxy that does not forward the scheme: the request arrives as http.
      const notForwarded = await postPerson({
        'Content-Type': 'application/json',
        Cookie: acme.cookie,
        Origin: 'https://localhost',
      })

      expect(forwarded.status).toBe(201)
      expect(notForwarded.status).toBe(201)
    })

    it('refuses the http page of a deployment on https', async () => {
      const response = await postPerson({
        'Content-Type': 'application/json',
        Cookie: acme.cookie,
        Origin: 'http://localhost',
        'X-Forwarded-Proto': 'https',
      })

      expect(response.status).toBe(403)
    })

    it('refuses a forged login, which needs no session', async () => {
      const body = JSON.stringify({ email: 'ada@example.com', password: PASSWORD })
      const forged = await send(
        'POST',
        '/v1/auth/login',
        { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body,
      )
      const own = await send(
        'POST',
        '/v1/auth/login',
        { 'Content-Type': 'application/json', Origin: OWN_ORIGIN },
        body,
      )

      expect(forged.status).toBe(403)
      expect(forged.headers.get('Set-Cookie')).toBeNull()
      expect(own.status).toBe(200)
    })

    it('covers PATCH and DELETE, and leaves GET alone', async () => {
      const created = await postPerson({ 'Content-Type': 'application/json', Cookie: acme.cookie })
      const id = readString(await created.json(), 'id')
      const forged = { Cookie: acme.cookie, Origin: 'https://evil.example' }

      const patch = await send(
        'PATCH',
        `/v1/people/${id}`,
        { ...forged, 'Content-Type': 'application/json' },
        JSON.stringify({ name: 'Changed' }),
      )
      const remove = await send('DELETE', `/v1/people/${id}`, forged)
      const read = await send('GET', `/v1/people/${id}`, forged)

      expect(patch.status).toBe(403)
      expect(remove.status).toBe(403)
      expect(read.status).toBe(200)
      expect(readString(await read.json(), 'name')).toBe('Grace Hopper')
    })

    it('leaves a bearer request alone', async () => {
      const secret = await mintKey()

      const response = await postPerson({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        Origin: 'https://evil.example',
      })

      expect(response.status).toBe(201)
    })

    it('leaves the public surface open to any origin', async () => {
      const response = await send('GET', '/v1/public/config', { Origin: 'https://customer.example' })

      expect(response.status).toBe(200)
    })
  })

  describe('content type', () => {
    it('refuses a session body that is not JSON', async () => {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const response = await postPerson({ 'Content-Type': type, Cookie: acme.cookie, Origin: OWN_ORIGIN })

        expect(response.status, type).toBe(415)
        expect(await errorCode(response), type).toBe('unsupported_media_type')
      }

      expect(await countPeople()).toBe(0)
    })

    it('refuses a body with no content type', async () => {
      const body = JSON.stringify({ name: 'Grace Hopper' })
      const response = await postPerson({ Cookie: acme.cookie, 'Content-Length': String(body.length) })

      expect(response.status).toBe(415)
    })

    it('accepts JSON with a charset parameter', async () => {
      const response = await postPerson({
        'Content-Type': 'Application/JSON; charset=utf-8',
        Cookie: acme.cookie,
      })

      expect(response.status).toBe(201)
    })

    it('accepts a POST with no body and no content type', async () => {
      const response = await send('POST', '/v1/auth/logout', { Cookie: acme.cookie, Origin: OWN_ORIGIN })

      expect(response.status).toBe(204)
    })

    it('accepts multipart on the two import routes that take the file', async () => {
      function upload(path: string): Promise<Response> {
        const form = new FormData()

        form.set('file', new File(['name,email\nGrace Hopper,grace@example.com\n'], 'people.csv', { type: 'text/csv' }))
        form.set('source', 'custom')
        form.set('object', 'people')
        form.set('conflict_mode', 'skip')

        return Promise.resolve(
          harness.app.request(path, {
            method: 'POST',
            headers: { Cookie: acme.cookie, Origin: OWN_ORIGIN },
            body: form,
          }),
        )
      }

      const created = await upload('/v1/import/jobs')

      expect(created.status).toBe(201)

      const committed = await upload(`/v1/import/jobs/${readString(await created.json(), 'id')}/commit`)

      expect([200, 202]).toContain(committed.status)
    })

    it('leaves a bearer request alone', async () => {
      const secret = await mintKey()

      const response = await postPerson({ 'Content-Type': 'text/plain', Authorization: `Bearer ${secret}` })

      expect(response.status).toBe(201)
    })
  })
})
