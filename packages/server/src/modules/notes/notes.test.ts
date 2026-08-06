import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'

/** `/v1/notes` against real Postgres. Notes attach to any CRM record. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('notes', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let personId: string

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
  })

  afterAll(async () => {
    await database.close()
  })

  async function createPerson(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  function addNote(body: Record<string, unknown>, cookie = acme.cookie): Promise<Response> {
    return client.send('POST', '/v1/notes', { body, cookie })
  }

  async function noteOn(targetId: string, body: string): Promise<Record<string, unknown>> {
    const response = await addNote({ target_type: 'person', target_id: targetId, body })

    return readRecord(await response.json())
  }

  function listNotes(query: string, cookie = acme.cookie): Promise<Response> {
    return client.send('GET', `/v1/notes?${query}`, { cookie })
  }

  beforeEach(async () => {
    await database.truncateAll()
    harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app)
    acme = await client.owner()
    personId = await createPerson('Ada Lovelace')
  })

  describe('creating', () => {
    it('attaches a note to a person and attributes it to the author', async () => {
      const response = await addNote({
        target_type: 'person',
        target_id: personId,
        body: 'Cares about implementation, not price.',
      })
      const note = readRecord(await response.json())

      expect(response.status).toBe(201)
      expect(note.id).toMatch(/^note_/u)
      expect(note.target_type).toBe('person')
      expect(note.target_id).toBe(personId)
      expect(note.body).toBe('Cares about implementation, not price.')
      expect(note.pinned).toBe(false)
      expect(note.author_id).toMatch(/^mem_/u)
    })

    it('accepts a pinned note', async () => {
      const response = await addNote({
        target_type: 'person',
        target_id: personId,
        body: 'Read this first.',
        pinned: true,
      })

      expect(readRecord(await response.json()).pinned).toBe(true)
    })

    it('attaches to every record type the model allows', async () => {
      const companyResponse = await client.send('POST', '/v1/companies', {
        body: { name: 'Analytical Engines' },
        cookie: acme.cookie,
      })
      const companyId = readString(await companyResponse.json(), 'id')

      const response = await addNote({
        target_type: 'company',
        target_id: companyId,
        body: 'Renewal in March.',
      })

      expect(response.status).toBe(201)
    })

    it('answers 404 for a target that does not exist', async () => {
      const response = await addNote({
        target_type: 'person',
        target_id: 'per_nope',
        body: 'Into the void.',
      })

      expect(response.status).toBe(404)
    })

    it('answers 404 for a target in another workspace', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const theirs = await createPerson('Grace Hopper', other.cookie)

      expect((await addNote({ target_type: 'person', target_id: theirs, body: 'Peek' })).status).toBe(404)
    })

    it('answers 422 for an empty body, an unknown target type, and an unknown field', async () => {
      expect((await addNote({ target_type: 'person', target_id: personId, body: '' })).status).toBe(422)
      expect((await addNote({ target_type: 'role', target_id: personId, body: 'x' })).status).toBe(422)
      expect(
        (await addNote({ target_type: 'person', target_id: personId, body: 'x', autor: 'me' })).status,
      ).toBe(422)
    })

    it('answers 401 without credentials', async () => {
      const response = await client.send('POST', '/v1/notes', {
        body: { target_type: 'person', target_id: personId, body: 'x' },
      })

      expect(response.status).toBe(401)
    })
  })

  describe('listing', () => {
    it('returns the notes on one record, newest first', async () => {
      await noteOn(personId, 'First')
      await noteOn(personId, 'Second')

      const notes = readList(await (await listNotes(`target_type=person&target_id=${personId}`)).json())

      expect(notes.map((note) => note.body)).toEqual(['Second', 'First'])
    })

    it('does not return notes filed against another record', async () => {
      const other = await createPerson('Grace Hopper')

      await noteOn(personId, 'Hers')
      await noteOn(other, 'Theirs')

      const notes = readList(await (await listNotes(`target_type=person&target_id=${personId}`)).json())

      expect(notes.map((note) => note.body)).toEqual(['Hers'])
    })

    it('returns the notes on every record the filter names, and nothing else', async () => {
      const second = await createPerson('Grace Hopper')
      const unasked = await createPerson('Katherine Johnson')

      await noteOn(personId, 'Hers')
      await noteOn(second, 'Theirs')
      await noteOn(unasked, 'Nobody asked')

      const notes = readList(
        await (
          await listNotes(`target_type=person&target_id=${personId}&target_id=${second}`)
        ).json(),
      )

      expect(notes.map((note) => note.body)).toEqual(['Theirs', 'Hers'])
    })

    it('resolves a set in one request whether or not every record has a note', async () => {
      const silent = await createPerson('Grace Hopper')

      await noteOn(personId, 'Hers')

      const notes = readList(
        await (
          await listNotes(`target_type=person&target_id=${personId}&target_id=${silent}`)
        ).json(),
      )

      // The empty record is not an error. It is the answer: a page asking about
      // five rows gets the notes that exist and renders the rest as empty.
      expect(notes.map((note) => note.body)).toEqual(['Hers'])
    })

    it('filters on pinned', async () => {
      await addNote({ target_type: 'person', target_id: personId, body: 'Pinned', pinned: true })
      await noteOn(personId, 'Ordinary')

      const pinned = readList(
        await (await listNotes(`target_type=person&target_id=${personId}&pinned=true`)).json(),
      )
      const unpinned = readList(
        await (await listNotes(`target_type=person&target_id=${personId}&pinned=false`)).json(),
      )

      expect(pinned.map((note) => note.body)).toEqual(['Pinned'])
      expect(unpinned.map((note) => note.body)).toEqual(['Ordinary'])
    })

    it('answers 422 without a target, and for a pinned filter that is not a boolean', async () => {
      expect((await listNotes('target_type=person')).status).toBe(422)
      expect((await listNotes(`target_id=${personId}`)).status).toBe(422)
      expect((await listNotes(`target_type=person&target_id=${personId}&pinned=yes`)).status).toBe(422)
    })

    it('answers 422 for a blank id, and for more than 200 of them', async () => {
      const tooMany = Array.from({ length: 201 }, (_, index) => `target_id=per_${String(index)}`)

      expect((await listNotes('target_type=person&target_id=')).status).toBe(422)
      expect((await listNotes(`target_type=person&${tooMany.join('&')}`)).status).toBe(422)
    })

    it('answers 404 for a target in another workspace', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const theirs = await createPerson('Grace Hopper', other.cookie)

      expect((await listNotes(`target_type=person&target_id=${theirs}`)).status).toBe(404)
    })

    it('answers 404 when any one id in the set is outside the workspace', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const theirs = await createPerson('Grace Hopper', other.cookie)

      await noteOn(personId, 'Hers')

      // Not a partial answer. A caller that asked about two records and got one
      // record's notes cannot tell which of the two it named was the empty one.
      expect(
        (await listNotes(`target_type=person&target_id=${personId}&target_id=${theirs}`)).status,
      ).toBe(404)
    })
  })

  describe('reading and editing one', () => {
    it('reads a note back by id', async () => {
      const created = await noteOn(personId, 'Body')
      const response = await client.send('GET', `/v1/notes/${String(created.id)}`, {
        cookie: acme.cookie,
      })

      expect(readRecord(await response.json()).body).toBe('Body')
    })

    it('edits the body and the pin', async () => {
      const created = await noteOn(personId, 'Before')
      const response = await client.send('PATCH', `/v1/notes/${String(created.id)}`, {
        body: { body: 'After', pinned: true },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(updated.body).toBe('After')
      expect(updated.pinned).toBe(true)
    })

    it('leaves updated_at alone for a PATCH that changes nothing', async () => {
      const created = await noteOn(personId, 'Same')
      const response = await client.send('PATCH', `/v1/notes/${String(created.id)}`, {
        body: { body: 'Same' },
        cookie: acme.cookie,
      })

      expect(readRecord(await response.json()).updated_at).toBe(created.updated_at)
    })

    it('refuses to re-file a note under another record', async () => {
      const created = await noteOn(personId, 'Body')
      const response = await client.send('PATCH', `/v1/notes/${String(created.id)}`, {
        body: { target_id: 'per_other' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('answers 404 across a workspace boundary', async () => {
      const created = await noteOn(personId, 'Body')
      const other = await client.owner('grace@example.com', 'other')

      expect(
        (await client.send('GET', `/v1/notes/${String(created.id)}`, { cookie: other.cookie })).status,
      ).toBe(404)
      expect(
        (
          await client.send('PATCH', `/v1/notes/${String(created.id)}`, {
            body: { body: 'Theirs now' },
            cookie: other.cookie,
          })
        ).status,
      ).toBe(404)
    })
  })

  describe('deleting', () => {
    it('removes the note and answers 204', async () => {
      const created = await noteOn(personId, 'Body')
      const response = await client.send('DELETE', `/v1/notes/${String(created.id)}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(204)

      const remaining = readList(
        await (await listNotes(`target_type=person&target_id=${personId}`)).json(),
      )

      expect(remaining).toHaveLength(0)
    })

    it('answers 404 across a workspace boundary', async () => {
      const created = await noteOn(personId, 'Body')
      const other = await client.owner('grace@example.com', 'other')

      expect(
        (await client.send('DELETE', `/v1/notes/${String(created.id)}`, { cookie: other.cookie })).status,
      ).toBe(404)
    })
  })

  describe('deleting the record a note is attached to', () => {
    it('takes the notes with it', async () => {
      const created = await noteOn(personId, 'Body')

      await client.send('DELETE', `/v1/people/${personId}`, { cookie: acme.cookie })

      const response = await client.send('GET', `/v1/notes/${String(created.id)}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })
  })
})
