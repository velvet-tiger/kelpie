import { eventSchema } from '@kelpie/schemas'
import { and, eq } from 'drizzle-orm'
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
import { notes } from '../notes/schema.ts'

/**
 * `/v1/events` and `/v1/attendances` against real Postgres.
 *
 * Event is a calendar object, not a pipeline: no stages, no kanban, no
 * person_links. People attach as Attendances; other records attach through
 * event_associations.
 */

const connectionString = testDatabaseUrl(process.env)

const CONTACT_FIELDS = [
  { label: 'Name', type: 'text', map_to: 'person.name', required: true },
  { label: 'Email', type: 'email', map_to: 'person.email', required: true },
]

describe.skipIf(connectionString === undefined)('events', () => {
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

  async function createPerson(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function createCompany(name: string): Promise<string> {
    const response = await client.send('POST', '/v1/companies', {
      body: { name },
      cookie: acme.cookie,
    })

    return readString(await response.json(), 'id')
  }

  function windowAround(
    startHoursFromNow: number,
    durationHours: number,
  ): { starts_at: string; ends_at: string } {
    const startsAt = new Date(Date.now() + startHoursFromNow * 60 * 60 * 1000)
    const endsAt = new Date(startsAt.getTime() + durationHours * 60 * 60 * 1000)

    return { starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() }
  }

  async function createEvent(
    body: Record<string, unknown> = {},
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/events', {
      body: {
        name: 'Product webinar',
        format: 'virtual',
        ...windowAround(24, 1),
        ...body,
      },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  it('creates, lists, and reads an Event', async () => {
    const created = await createEvent({ kind: 'webinar', location: 'Online' })
    const parsed = eventSchema.parse(created)

    expect(parsed.name).toBe('Product webinar')
    expect(parsed.kind).toBe('webinar')
    expect(parsed.format).toBe('virtual')
    expect(parsed.status).toBe('scheduled')
    expect(parsed.id.startsWith('event_')).toBe(true)

    const listed = readList(
      await (await client.send('GET', '/v1/events', { cookie: acme.cookie })).json(),
    )

    expect(listed.map((row) => row.id)).toEqual([created.id])

    const fetched = readRecord(
      await (await client.send('GET', `/v1/events/${readString(created, 'id')}`, {
        cookie: acme.cookie,
      })).json(),
    )

    expect(fetched.name).toBe('Product webinar')
  })

  it('refuses an Event that ends before it starts with 422', async () => {
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const endsAt = new Date(startsAt.getTime() - 60 * 60 * 1000)
    const response = await client.send('POST', '/v1/events', {
      body: {
        name: 'Backwards',
        format: 'virtual',
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(422)
  })

  it('registers a person as Attendance and refuses a duplicate with 409', async () => {
    const eventId = readString(await createEvent(), 'id')
    const personId = await createPerson('Ada Lovelace')

    const created = await client.send('POST', `/v1/events/${eventId}/attendances`, {
      body: { person_id: personId },
      cookie: acme.cookie,
    })

    expect(created.status).toBe(201)

    const row = readRecord(await created.json())

    expect(row.status).toBe('registered')
    expect(row.source).toBe('manual')
    expect(readString(row, 'id').startsWith('atnd_')).toBe(true)

    const duplicate = await client.send('POST', `/v1/events/${eventId}/attendances`, {
      body: { person_id: personId },
      cookie: acme.cookie,
    })

    expect(duplicate.status).toBe(409)
  })

  it('refuses an association to a missing record with 404', async () => {
    const response = await client.send('POST', '/v1/events', {
      body: {
        name: 'Partner summit',
        format: 'hybrid',
        ...windowAround(48, 2),
        associations: [{ target_type: 'company', target_id: 'co_missing' }],
      },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(404)
  })

  it('stores associations and answers the reverse list', async () => {
    const companyId = await createCompany('Northwind')
    const created = await createEvent({
      associations: [{ target_type: 'company', target_id: companyId }],
    })
    const eventId = readString(created, 'id')

    expect(created.associations).toEqual([
      { target_type: 'company', target_id: companyId },
    ])

    const reverse = readList(
      await (
        await client.send(
          'GET',
          `/v1/event-associations?target_type=company&target_id=${companyId}`,
          { cookie: acme.cookie },
        )
      ).json(),
    )

    expect(reverse).toEqual([
      {
        event_id: eventId,
        event_name: 'Product webinar',
        target_type: 'company',
        target_id: companyId,
      },
    ])
  })

  it('registers Attendance from a form attach target without duplicating on retry', async () => {
    const eventId = readString(await createEvent(), 'id')
    const formResponse = await client.send('POST', '/v1/forms', {
      body: {
        name: 'Webinar signup',
        fields: CONTACT_FIELDS,
        attach_targets: [{ target_type: 'event', target_id: eventId }],
      },
      cookie: acme.cookie,
    })

    expect(formResponse.status).toBe(201)

    const form = readRecord(await formResponse.json())
    const fields = Array.isArray(form.fields) ? form.fields : []
    const ids = Object.fromEntries(
      fields
        .filter((field): field is Record<string, unknown> => typeof field === 'object' && field !== null)
        .map((field) => [String(field.label), String(field.id)]),
    )
    const publicKey = readString(form, 'public_key')
    const answers = { [ids.Name ?? '']: 'Alex Rivera', [ids.Email ?? '']: 'alex@example.com' }

    const first = await client.send('POST', `/v1/public/forms/${publicKey}/submit`, {
      body: { answers },
    })

    expect(first.status).toBe(201)

    const listedAfterFirst = readList(
      await (
        await client.send('GET', `/v1/forms/${readString(form, 'id')}/submissions`, {
          cookie: acme.cookie,
        })
      ).json(),
    )

    expect(listedAfterFirst[0]?.action_log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: `attach:event:${eventId}`,
          status: 'ok',
          detail: 'registered',
        }),
      ]),
    )

    const second = await client.send('POST', `/v1/public/forms/${publicKey}/submit`, {
      body: { answers },
    })

    expect(second.status).toBe(201)

    const listedAfterSecond = readList(
      await (
        await client.send('GET', `/v1/forms/${readString(form, 'id')}/submissions`, {
          cookie: acme.cookie,
        })
      ).json(),
    )
    const latest = listedAfterSecond[0]

    expect(latest?.action_log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: `attach:event:${eventId}`,
          status: 'ok',
          detail: 'already registered',
        }),
      ]),
    )

    const attendances = readList(
      await (
        await client.send('GET', `/v1/events/${eventId}/attendances`, { cookie: acme.cookie })
      ).json(),
    )

    expect(attendances).toHaveLength(1)
    expect(attendances[0]?.source).toBe('form')
    expect(attendances[0]?.status).toBe('registered')
  })

  it('deletes notes on Attendances when the Event is deleted', async () => {
    const eventId = readString(await createEvent(), 'id')
    const personId = await createPerson('Ada Lovelace')
    const attendance = readRecord(
      await (
        await client.send('POST', `/v1/events/${eventId}/attendances`, {
          body: { person_id: personId },
          cookie: acme.cookie,
        })
      ).json(),
    )
    const attendanceId = readString(attendance, 'id')

    const noteResponse = await client.send('POST', '/v1/notes', {
      body: { target_type: 'attendance', target_id: attendanceId, body: 'Dietary: vegetarian' },
      cookie: acme.cookie,
    })

    expect(noteResponse.status).toBe(201)

    const deleted = await client.send('DELETE', `/v1/events/${eventId}`, { cookie: acme.cookie })

    expect(deleted.status).toBe(204)

    const leftover = await harness.services.db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.workspaceId, acme.workspaceId), eq(notes.targetId, attendanceId)))

    expect(leftover).toHaveLength(0)
  })
})
