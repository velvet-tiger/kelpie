import { personSchema } from '@kelpie/schemas'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readCursor, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { activities } from '../activities/schema.ts'
import { coreModules } from '../core.ts'
import { deals } from '../deals/schema.ts'
import { notes } from '../notes/schema.ts'
import { personLinks } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { eq } from 'drizzle-orm'

/** `/v1/people` against real Postgres. */

const connectionString = testDatabaseUrl(process.env)

/** ISO 8601 UTC with milliseconds, which is the only timestamp shape `api.md` allows. */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

describe.skipIf(connectionString === undefined)('people', () => {
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

  async function createPerson(body: Record<string, unknown>, cookie = acme.cookie): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/people', { body, cookie })

    if (response.status !== 201) {
      throw new Error(`Creating a person answered ${String(response.status)}: ${await response.text()}`)
    }

    return readRecord(await response.json())
  }

  async function patchPerson(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await client.send('PATCH', `/v1/people/${id}`, { body, cookie: acme.cookie })

    if (response.status !== 200) {
      throw new Error(`Patching a person answered ${String(response.status)}: ${await response.text()}`)
    }

    return readRecord(await response.json())
  }

  async function createCompany(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const response = await client.send('POST', '/v1/companies', {
      body: { name, ...extra },
      cookie: acme.cookie,
    })

    return readString(await response.json(), 'id')
  }

  describe('creating', () => {
    it('needs only a name, and defaults the rest the way the UI does', async () => {
      const person = await createPerson({ name: 'Ada Lovelace' })

      expect(person.id).toMatch(/^per_/u)
      expect(person.name).toBe('Ada Lovelace')
      expect(person.email).toBeNull()
      expect(person.preferred_channel).toBe('email')
      expect(person.influence).toBe('influencer')
      expect(person.relationship).toBe('cold')
      expect(person.summary).toBe('')
      expect(person.tags).toEqual([])
      expect(person.phones).toEqual([])
      expect(person.social_profiles).toEqual([])
      expect(person.last_contacted_at).toBeNull()
    })

    it('renders timestamps as ISO 8601 UTC with milliseconds', async () => {
      const person = await createPerson({
        name: 'Ada Lovelace',
        last_contacted_at: '2026-07-01T09:30:00.000Z',
      })

      expect(String(person.created_at)).toMatch(ISO_8601_UTC)
      expect(String(person.updated_at)).toMatch(ISO_8601_UTC)
      expect(person.last_contacted_at).toBe('2026-07-01T09:30:00.000Z')
    })

    it('keeps the agent fields it was given', async () => {
      const person = await createPerson({
        name: 'Grace Hopper',
        email: 'GRACE@Example.COM ',
        influence: 'decision_maker',
        relationship: 'strong',
        preferred_channel: 'call',
        summary: 'Runs the platform team.',
        tags: ['champion', 'navy'],
        phones: ['+61 400 000 000'],
        social_profiles: [{ network: 'github', url: 'https://github.com/grace' }],
        timezone: 'Australia/Melbourne',
        location: 'Melbourne',
      })

      expect(person.email).toBe('grace@example.com')
      expect(person.influence).toBe('decision_maker')
      expect(person.summary).toBe('Runs the platform team.')
      expect(person.tags).toEqual(['champion', 'navy'])
      expect(person.social_profiles).toEqual([{ network: 'github', url: 'https://github.com/grace' }])
    })

    it('stores a blank email as null rather than as an empty string', async () => {
      const first = await createPerson({ name: 'One', email: '' })
      const second = await createPerson({ name: 'Two', email: '  ' })

      expect(first.email).toBeNull()
      expect(second.email).toBeNull()
    })

    it('refuses an unknown enum value with 422', async () => {
      const response = await client.send('POST', '/v1/people', {
        body: { name: 'Ada', influence: 'chief_vibes_officer' },
        cookie: acme.cookie,
      })
      const body = readRecord(await response.json())

      expect(response.status).toBe(422)
      expect(readRecord(body.error).code).toBe('validation_failed')
      expect(readRecord(body.error).details).toContainEqual(
        expect.objectContaining({ field: 'influence' }),
      )
    })

    it('refuses an unknown field with 422 rather than dropping it, and names it', async () => {
      const response = await client.send('POST', '/v1/people', {
        body: { name: 'Ada', job_title: 'Countess' },
        cookie: acme.cookie,
      })
      const body = readRecord(await response.json())

      expect(response.status).toBe(422)
      expect(readRecord(body.error).details).toEqual([
        { field: 'job_title', message: 'Unknown field' },
      ])
    })

    it('refuses a missing name with 422', async () => {
      const response = await client.send('POST', '/v1/people', { body: {}, cookie: acme.cookie })

      expect(response.status).toBe(422)
    })

    it('refuses a body that is not JSON with 400', async () => {
      const response = await harness.app.request('/v1/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: acme.cookie },
        body: 'not json',
      })

      expect(response.status).toBe(400)
    })

    it('answers 409 for a duplicate email in the same workspace', async () => {
      await createPerson({ name: 'Ada', email: 'ada@example.com' })

      const response = await client.send('POST', '/v1/people', {
        body: { name: 'Ada again', email: 'ADA@example.com' },
        cookie: acme.cookie,
      })
      const body = readRecord(await response.json())

      expect(response.status).toBe(409)
      expect(readRecord(body.error).code).toBe('conflict')
    })

    it('allows the same email in a different workspace', async () => {
      await createPerson({ name: 'Ada', email: 'ada@example.com' })
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('POST', '/v1/people', {
        body: { name: 'Ada', email: 'ada@example.com' },
        cookie: initech.cookie,
      })

      expect(response.status).toBe(201)
    })

    it('emits people.person.created after the transaction commits', async () => {
      const seen: { readonly recordId: string; readonly objectType: string }[] = []
      harness.services.events.subscribe('people.person.created', (event) => {
        seen.push({ recordId: event.target.id, objectType: event.target.type })
      })

      const person = await createPerson({ name: 'Ada' })
      await harness.services.events.drain()

      expect(seen).toEqual([{ recordId: person.id, objectType: 'person' }])
    })
  })

  /**
   * `name` is the canonical display string and the parts are optional detail
   * beside it. Composition runs one way and only on the way in.
   */
  describe('names', () => {
    it('defaults every part to null, because an unknown part is not an empty one', async () => {
      const person = await createPerson({ name: 'Prince' })

      expect(person.salutation).toBeNull()
      expect(person.first_name).toBeNull()
      expect(person.last_name).toBeNull()
      expect(person.suffix).toBeNull()
    })

    it('keeps the parts it was given, without touching the name', async () => {
      const person = await createPerson({
        name: 'Kit Johnson',
        salutation: 'Dr',
        first_name: 'Katherine',
        last_name: 'Johnson',
        suffix: 'PhD',
      })

      expect(person.name).toBe('Kit Johnson')
      expect(person.salutation).toBe('Dr')
      expect(person.first_name).toBe('Katherine')
      expect(person.last_name).toBe('Johnson')
      expect(person.suffix).toBe('PhD')
    })

    it('composes a name from the parts when the create sent none', async () => {
      const person = await createPerson({ first_name: 'Ada', last_name: 'Lovelace' })

      expect(person.name).toBe('Ada Lovelace')
      expect(person.first_name).toBe('Ada')
    })

    it('composes from one part alone, and leaves the salutation out of it', async () => {
      expect((await createPerson({ last_name: 'Lovelace' })).name).toBe('Lovelace')
      // "Dr Ada Lovelace" is a form of address, not what a list of people shows.
      const doctor = await createPerson({
        salutation: 'Dr',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada2@example.com',
      })

      expect(doctor.name).toBe('Ada Lovelace')
    })

    it('refuses a create carrying neither a name nor a part, and says which field', async () => {
      const response = await client.send('POST', '/v1/people', {
        body: { salutation: 'Dr' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
      expect(readRecord(readRecord(await response.json()).error).details).toEqual([
        { field: 'name', message: 'Send a name, or a first_name or last_name to compose one from' },
      ])
    })

    it('does not rename the person when a part is patched', async () => {
      const person = await createPerson({ name: 'Kit', first_name: 'Katherine' })
      const updated = await patchPerson(readString(person, 'id'), { first_name: 'Katharine' })

      // Someone chose "Kit". Recomputing the name from a part would undo that
      // choice from across the room, so a rename is `name` and nothing else.
      expect(updated.first_name).toBe('Katharine')
      expect(updated.name).toBe('Kit')
    })

    it('clears a part with null', async () => {
      const person = await createPerson({ name: 'Ada Lovelace', suffix: 'Jr' })
      const updated = await patchPerson(readString(person, 'id'), { suffix: null })

      expect(updated.suffix).toBeNull()
      expect(updated.name).toBe('Ada Lovelace')
    })

    it('never splits a name into parts', async () => {
      const person = await createPerson({ name: 'Ursula K. Le Guin' })

      expect(person.first_name).toBeNull()
      expect(person.last_name).toBeNull()
    })
  })

  describe('reading', () => {
    it('answers 401 without credentials', async () => {
      expect((await client.send('GET', '/v1/people')).status).toBe(401)
    })

    it('answers 403 before the account has a workspace', async () => {
      const cookie = await client.signUp('nobody@example.com')

      expect((await client.send('GET', '/v1/people', { cookie })).status).toBe(403)
    })

    it('answers 404 for a person in another workspace', async () => {
      const person = await createPerson({ name: 'Ada' })
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('GET', `/v1/people/${String(person.id)}`, {
        cookie: initech.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('answers 404 for an id that never existed', async () => {
      const response = await client.send('GET', '/v1/people/per_nothing', { cookie: acme.cookie })

      expect(response.status).toBe(404)
    })

    it('reaches the list with a workspace API key', async () => {
      await createPerson({ name: 'Ada' })
      const minted = await client.send('POST', '/v1/api-keys', {
        body: { name: 'CI', kind: 'workspace' },
        cookie: acme.cookie,
      })
      const secret = readString(await minted.json(), 'secret')

      const response = await client.send('GET', '/v1/people', { bearer: secret })

      expect(response.status).toBe(200)
      expect(readList(await response.json())).toHaveLength(1)
    })

    it('lists only this workspace', async () => {
      await createPerson({ name: 'Ada' })
      const initech = await client.owner('grace@example.com', 'initech')
      await createPerson({ name: 'Grace' }, initech.cookie)

      const ours = readList(await (await client.send('GET', '/v1/people', { cookie: acme.cookie })).json())
      const theirs = readList(
        await (await client.send('GET', '/v1/people', { cookie: initech.cookie })).json(),
      )

      expect(ours.map((person) => person.name)).toEqual(['Ada'])
      expect(theirs.map((person) => person.name)).toEqual(['Grace'])
    })
  })

  describe('filtering', () => {
    it('matches name, email, summary and tags', async () => {
      await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })
      await createPerson({ name: 'Grace Hopper', summary: 'Wrote the first compiler' })
      await createPerson({ name: 'Alan Turing', tags: ['cryptography'] })

      const matching = async (term: string): Promise<string[]> => {
        const response = await client.send('GET', `/v1/people?q=${encodeURIComponent(term)}`, {
          cookie: acme.cookie,
        })

        return readList(await response.json()).map((person) => String(person.name))
      }

      expect(await matching('lovelace')).toEqual(['Ada Lovelace'])
      expect(await matching('ANALYTICAL')).toEqual(['Ada Lovelace'])
      expect(await matching('compiler')).toEqual(['Grace Hopper'])
      expect(await matching('crypto')).toEqual(['Alan Turing'])
      expect(await matching('nobody')).toEqual([])
    })

    it('matches a first or last name the display name does not carry', async () => {
      await createPerson({ name: 'Kit', first_name: 'Katherine', last_name: 'Johnson' })
      await createPerson({ name: 'Someone Else', email: 'else@example.com' })

      const matching = async (term: string): Promise<string[]> => {
        const response = await client.send('GET', `/v1/people?q=${encodeURIComponent(term)}`, {
          cookie: acme.cookie,
        })

        return readList(await response.json()).map((person) => String(person.name))
      }

      // The same two parts `search_vector` carries, so this list and the
      // workspace search agree about who "johnson" is.
      expect(await matching('johnson')).toEqual(['Kit'])
      expect(await matching('katherine')).toEqual(['Kit'])
    })

    it('matches a position title and the company name behind it', async () => {
      const person = await createPerson({ name: 'Ada Lovelace' })
      const companyId = await createCompany('Analytical Engines')
      await client.send('POST', '/v1/positions', {
        body: { person_id: person.id, company_id: companyId, title: 'Chief Mathematician' },
        cookie: acme.cookie,
      })
      await createPerson({ name: 'Someone Else' })

      const byTitle = await client.send('GET', '/v1/people?q=mathematician', { cookie: acme.cookie })
      const byCompany = await client.send('GET', '/v1/people?q=analytical', { cookie: acme.cookie })

      expect(readList(await byTitle.json()).map((row) => row.name)).toEqual(['Ada Lovelace'])
      expect(readList(await byCompany.json()).map((row) => row.name)).toEqual(['Ada Lovelace'])
    })

    it('treats a wildcard in the term as a character, not a pattern', async () => {
      await createPerson({ name: 'Ada Lovelace' })
      await createPerson({ name: '100% Cotton' })

      const response = await client.send('GET', '/v1/people?q=%25', { cookie: acme.cookie })

      expect(readList(await response.json()).map((row) => row.name)).toEqual(['100% Cotton'])
    })

    it('filters by company through positions', async () => {
      const ada = await createPerson({ name: 'Ada Lovelace' })
      await createPerson({ name: 'Unattached Person' })
      const companyId = await createCompany('Analytical Engines')
      await client.send('POST', '/v1/positions', {
        body: { person_id: ada.id, company_id: companyId, title: 'Chief Mathematician' },
        cookie: acme.cookie,
      })

      const response = await client.send('GET', `/v1/people?company_id=${companyId}`, {
        cookie: acme.cookie,
      })

      expect(readList(await response.json()).map((row) => row.name)).toEqual(['Ada Lovelace'])
    })

    it('takes company_id more than once, and answers for any of them', async () => {
      const ada = await createPerson({ name: 'Ada Lovelace' })
      const grace = await createPerson({ name: 'Grace Hopper' })
      await createPerson({ name: 'Unemployed Ursula' })
      const harbour = await createCompany('Harbour')
      const initech = await createCompany('Initech')

      await client.send('POST', '/v1/positions', {
        body: { person_id: ada.id, company_id: harbour, title: 'Chief Mathematician' },
        cookie: acme.cookie,
      })
      await client.send('POST', '/v1/positions', {
        body: { person_id: grace.id, company_id: initech, title: 'Rear Admiral' },
        cookie: acme.cookie,
      })

      const response = await client.send(
        'GET',
        `/v1/people?company_id=${harbour}&company_id=${initech}&sort=name`,
        { cookie: acme.cookie },
      )

      expect(readList(await response.json()).map((row) => row.name)).toEqual([
        'Ada Lovelace',
        'Grace Hopper',
      ])
    })

    it('refuses a blank company_id with 422 rather than ignoring it', async () => {
      const response = await client.send('GET', '/v1/people?company_id=', { cookie: acme.cookie })

      expect(response.status).toBe(422)
      expect(readRecord(readRecord(await response.json()).error).code).toBe('validation_failed')
    })

    it('refuses more ids than a page could hold', async () => {
      const tooMany = Array.from({ length: 201 }, (_, index) => `company_id=com_${String(index)}`)
      const response = await client.send(`GET`, `/v1/people?${tooMany.join('&')}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })
  })

  describe('paging and sorting', () => {
    beforeEach(async () => {
      for (const name of ['Aaron', 'Beatrice', 'Cyrus', 'Delia', 'Ewan']) {
        await createPerson({ name })
      }
    })

    it('pages with an opaque cursor and stops with a null one', async () => {
      const seen: string[] = []
      let cursor: string | null = null
      let requests = 0

      do {
        const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`
        const payload: unknown = await (
          await client.send('GET', `/v1/people${query}`, { cookie: acme.cookie })
        ).json()

        seen.push(...readList(payload).map((row) => String(row.name)))
        cursor = readCursor(payload)
        requests += 1
      } while (cursor !== null && requests < 10)

      expect(seen).toHaveLength(5)
      expect(new Set(seen).size).toBe(5)
      expect(cursor).toBeNull()
    })

    it('sorts by a documented field in both directions', async () => {
      const names = async (sort: string): Promise<string[]> => {
        const response = await client.send(`GET`, `/v1/people?sort=${sort}`, { cookie: acme.cookie })

        return readList(await response.json()).map((row) => String(row.name))
      }

      expect(await names('name')).toEqual(['Aaron', 'Beatrice', 'Cyrus', 'Delia', 'Ewan'])
      expect(await names('-name')).toEqual(['Ewan', 'Delia', 'Cyrus', 'Beatrice', 'Aaron'])
    })

    it('pages a sorted list without repeating or losing a row', async () => {
      const first = await (
        await client.send('GET', '/v1/people?sort=name&limit=3', { cookie: acme.cookie })
      ).json()
      const cursor = readCursor(first)

      expect(cursor).not.toBeNull()

      const second = await (
        await client.send('GET', `/v1/people?sort=name&limit=3&cursor=${encodeURIComponent(String(cursor))}`, {
          cookie: acme.cookie,
        })
      ).json()

      expect(readList(first).map((row) => row.name)).toEqual(['Aaron', 'Beatrice', 'Cyrus'])
      expect(readList(second).map((row) => row.name)).toEqual(['Delia', 'Ewan'])
      expect(readCursor(second)).toBeNull()
    })

    it('refuses a cursor issued for a different sort order', async () => {
      const first = await (
        await client.send('GET', '/v1/people?sort=name&limit=2', { cookie: acme.cookie })
      ).json()
      const cursor = String(readCursor(first))

      const response = await client.send(
        'GET',
        `/v1/people?sort=-created_at&limit=2&cursor=${encodeURIComponent(cursor)}`,
        { cookie: acme.cookie },
      )

      expect(response.status).toBe(422)
    })

    it('refuses a cursor it did not issue', async () => {
      const response = await client.send('GET', '/v1/people?cursor=not-a-cursor', {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('refuses an undocumented sort field', async () => {
      const response = await client.send('GET', '/v1/people?sort=influence', { cookie: acme.cookie })

      expect(response.status).toBe(422)
    })

    it('refuses a limit outside the documented range', async () => {
      expect((await client.send('GET', '/v1/people?limit=0', { cookie: acme.cookie })).status).toBe(422)
      expect((await client.send('GET', '/v1/people?limit=201', { cookie: acme.cookie })).status).toBe(422)
      expect((await client.send('GET', '/v1/people?limit=ten', { cookie: acme.cookie })).status).toBe(422)
    })
  })

  describe('updating', () => {
    it('changes only the fields it was sent', async () => {
      const person = await createPerson({ name: 'Ada', summary: 'Original', tags: ['one'] })

      const response = await client.send('PATCH', `/v1/people/${String(person.id)}`, {
        body: { summary: 'Rewritten' },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(updated.summary).toBe('Rewritten')
      expect(updated.name).toBe('Ada')
      expect(updated.tags).toEqual(['one'])
    })

    it('clears a nullable field with null', async () => {
      const person = await createPerson({ name: 'Ada', email: 'ada@example.com', location: 'London' })

      const response = await client.send('PATCH', `/v1/people/${String(person.id)}`, {
        body: { email: null, location: null },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(updated.email).toBeNull()
      expect(updated.location).toBeNull()
    })

    it('refuses null for a field that is not nullable', async () => {
      const person = await createPerson({ name: 'Ada' })

      const response = await client.send('PATCH', `/v1/people/${String(person.id)}`, {
        body: { name: null },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('leaves updated_at alone when nothing actually changed', async () => {
      const person = await createPerson({ name: 'Ada', summary: 'Same' })

      const response = await client.send('PATCH', `/v1/people/${String(person.id)}`, {
        body: { summary: 'Same' },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(updated.updated_at).toBe(person.updated_at)
    })

    it('reports which fields changed', async () => {
      const person = await createPerson({ name: 'Ada', summary: 'Original' })
      const changes: (readonly string[])[] = []
      harness.services.events.subscribe('people.person.updated', (event) => {
        changes.push(event.data.changed)
      })

      await client.send('PATCH', `/v1/people/${String(person.id)}`, {
        body: { summary: 'Rewritten', name: 'Ada' },
        cookie: acme.cookie,
      })
      await harness.services.events.drain()

      expect(changes).toEqual([['summary']])
    })

    it('answers 404 across a workspace boundary', async () => {
      const person = await createPerson({ name: 'Ada' })
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('PATCH', `/v1/people/${String(person.id)}`, {
        body: { summary: 'Not yours' },
        cookie: initech.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('answers 409 when the new email is already taken', async () => {
      await createPerson({ name: 'Ada', email: 'ada@example.com' })
      const grace = await createPerson({ name: 'Grace' })

      const response = await client.send('PATCH', `/v1/people/${String(grace.id)}`, {
        body: { email: 'ada@example.com' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(409)
    })
  })

  describe('deleting', () => {
    it('answers 204 and then 404', async () => {
      const person = await createPerson({ name: 'Ada' })

      const deleted = await client.send('DELETE', `/v1/people/${String(person.id)}`, {
        cookie: acme.cookie,
      })

      expect(deleted.status).toBe(204)
      expect(
        (await client.send('GET', `/v1/people/${String(person.id)}`, { cookie: acme.cookie })).status,
      ).toBe(404)
    })

    it('takes its positions with it', async () => {
      const person = await createPerson({ name: 'Ada' })
      const companyId = await createCompany('Analytical Engines')
      await client.send('POST', '/v1/positions', {
        body: { person_id: person.id, company_id: companyId, title: 'Chief Mathematician' },
        cookie: acme.cookie,
      })

      await client.send('DELETE', `/v1/people/${String(person.id)}`, { cookie: acme.cookie })

      const remaining = await client.send('GET', '/v1/positions', { cookie: acme.cookie })
      expect(readList(await remaining.json())).toEqual([])
    })

    it('takes its notes and activities with it', async () => {
      const person = await createPerson({ name: 'Ada' })
      const personId = String(person.id)

      await database.db.insert(notes).values({
        id: 'note_test_one',
        workspaceId: acme.workspaceId,
        targetType: 'person',
        targetId: personId,
        body: 'Met at the Royal Society',
      })
      await database.db.insert(activities).values({
        id: 'act_test_one',
        workspaceId: acme.workspaceId,
        targetType: 'person',
        targetId: personId,
        kind: 'created',
        action: 'created the record',
      })

      await client.send('DELETE', `/v1/people/${personId}`, { cookie: acme.cookie })

      expect(await database.db.select().from(notes).where(eq(notes.targetId, personId))).toEqual([])
      expect(
        await database.db.select().from(activities).where(eq(activities.targetId, personId)),
      ).toEqual([])
    })

    it('answers 409 while a deal still lists the person, and keeps the notes', async () => {
      const person = await createPerson({ name: 'Ada' })
      const personId = String(person.id)
      const companyId = await createCompany('Analytical Engines')
      const [stage] = await database.db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.kind, 'deal'))
        .limit(1)

      await database.db.insert(deals).values({
        id: 'deal_test_one',
        workspaceId: acme.workspaceId,
        name: 'Engine rollout',
        companyId,
        stageId: String(stage?.id),
      })
      await database.db.insert(personLinks).values({
        id: 'plink_test_one',
        workspaceId: acme.workspaceId,
        personId,
        targetType: 'deal',
        targetId: 'deal_test_one',
      })
      await database.db.insert(notes).values({
        id: 'note_test_two',
        workspaceId: acme.workspaceId,
        targetType: 'person',
        targetId: personId,
        body: 'Still here afterwards',
      })

      const response = await client.send('DELETE', `/v1/people/${personId}`, { cookie: acme.cookie })
      const body = readRecord(await response.json())

      expect(response.status).toBe(409)
      expect(readRecord(body.error).code).toBe('conflict')
      expect(readRecord(body.error).details).toContainEqual(
        expect.objectContaining({ message: 'Referenced by deal' }),
      )
      // The refusal rolled back the whole transaction, dependents included.
      expect(await database.db.select().from(notes).where(eq(notes.targetId, personId))).toHaveLength(1)
    })

    it('answers 404 across a workspace boundary', async () => {
      const person = await createPerson({ name: 'Ada' })
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('DELETE', `/v1/people/${String(person.id)}`, {
        cookie: initech.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('emits people.person.deleted', async () => {
      const person = await createPerson({ name: 'Ada' })
      const seen: string[] = []
      harness.services.events.subscribe('people.person.deleted', (event) => {
        seen.push(event.target.id)
      })

      await client.send('DELETE', `/v1/people/${String(person.id)}`, { cookie: acme.cookie })
      await harness.services.events.drain()

      expect(seen).toEqual([person.id])
    })
  })

  /**
   * The client decodes with `personSchema`, so a field renamed here and not
   * there is a runtime failure in the browser that no server test would catch.
   * `parse` throws naming the offending field, which beats an equality assertion
   * on a shape nobody would keep up to date.
   */
  describe('the wire contract', () => {
    it('answers every read path with the shape @kelpie/schemas decodes', async () => {
      const created = await createPerson({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phones: ['+61 400 000 000'],
        social_profiles: [{ network: 'github', url: 'https://github.com/ada' }],
        timezone: 'Australia/Sydney',
        location: 'Sydney',
        preferred_channel: 'call',
        influence: 'champion',
        relationship: 'strong',
        summary: 'Runs the analytics team.',
        tags: ['ai'],
        last_contacted_at: '2026-07-01T09:30:00.000Z',
      })

      expect(personSchema.parse(created).name).toBe('Ada Lovelace')

      const detail = await client.send(`GET`, `/v1/people/${String(created.id)}`, { cookie: acme.cookie })
      expect(personSchema.parse(readRecord(await detail.json())).id).toBe(created.id)

      const listed = await client.send('GET', '/v1/people', { cookie: acme.cookie })
      expect(readList(await listed.json()).map((item) => personSchema.parse(item).id)).toContain(created.id)

      const patched = await client.send('PATCH', `/v1/people/${String(created.id)}`, {
        body: { summary: 'Updated' },
        cookie: acme.cookie,
      })
      expect(personSchema.parse(readRecord(await patched.json())).summary).toBe('Updated')
    })
  })
})
