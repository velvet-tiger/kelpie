import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { dealPeople, deals } from '../deals/schema.ts'
import { partnershipPeople, partnerships } from '../partnerships/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'

/**
 * `/v1/activities` against real Postgres.
 *
 * Read-only, and every row here was written by the service that made the change,
 * which is what the emission assertions are checking.
 */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('activities', () => {
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

  async function createPerson(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function createCompany(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/companies', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function timeline(
    targetType: string,
    targetId: string,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>[]> {
    const response = await client.send(
      'GET',
      `/v1/activities?target_type=${targetType}&target_id=${targetId}`,
      { cookie },
    )

    return readList(await response.json())
  }

  /** The first stage of a pipeline, seeded when the workspace was created. */
  async function firstStageId(kind: string): Promise<string> {
    const [stage] = await database.db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(
        and(eq(pipelineStages.workspaceId, acme.workspaceId), eq(pipelineStages.kind, kind)),
      )
      .orderBy(pipelineStages.sortOrder)
      .limit(1)

    if (stage === undefined) {
      throw new Error(`Workspace creation seeded no ${kind} stages`)
    }

    return stage.id
  }

  /**
   * A deal, written straight to the table.
   *
   * The Deals module has no service or routes yet, and a person's timeline rolls
   * up the deals they are on. Inserting the row is what lets the roll-up be
   * asserted now rather than when that module lands.
   */
  async function insertDeal(name: string, companyId: string, personId?: string): Promise<string> {
    const dealId = `deal_${name.replace(/\W/gu, '')}`

    await database.db.insert(deals).values({
      id: dealId,
      workspaceId: acme.workspaceId,
      name,
      companyId,
      stageId: await firstStageId('deal'),
    })

    if (personId !== undefined) {
      await database.db.insert(dealPeople).values({ dealId, personId })
    }

    return dealId
  }

  async function recordDealActivity(dealId: string, action: string): Promise<void> {
    await client.send('POST', '/v1/notes', {
      body: { target_type: 'deal', target_id: dealId, body: action },
      cookie: acme.cookie,
    })
  }

  beforeEach(async () => {
    await database.truncateAll()
    harness = await createTestApp({
      modules: coreModules,
      environment: { NODE_ENV: 'test' },
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app)
    acme = await client.owner()
  })

  describe('emission on create', () => {
    it('files a created row against a new person', async () => {
      const personId = await createPerson('Ada Lovelace')
      const rows = await timeline('person', personId)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('created')
      expect(rows[0]?.action).toBe('created Person')
      expect(rows[0]?.detail).toBeNull()
      expect(rows[0]?.actor_member_id).toMatch(/^mem_/u)
      expect(rows[0]?.actor_label).toBeNull()
    })

    it('files a created row against a new company', async () => {
      const companyId = await createCompany('Analytical Engines')
      const rows = await timeline('company', companyId)

      expect(rows[0]?.kind).toBe('created')
      expect(rows[0]?.action).toBe('created Company')
    })
  })

  describe('emission on update', () => {
    it('names a single changed field and what it moved between', async () => {
      const personId = await createPerson('Ada Lovelace')

      await client.send('PATCH', `/v1/people/${personId}`, {
        body: { influence: 'decision_maker' },
        cookie: acme.cookie,
      })

      const rows = await timeline('person', personId)

      expect(rows[0]?.kind).toBe('updated')
      expect(rows[0]?.action).toBe('changed Influence')
      expect(rows[0]?.detail).toBe('influencer → decision_maker')
    })

    it('counts several changed fields', async () => {
      const personId = await createPerson('Ada Lovelace')

      await client.send('PATCH', `/v1/people/${personId}`, {
        body: { preferred_channel: 'call', relationship: 'warm' },
        cookie: acme.cookie,
      })

      const rows = await timeline('person', personId)

      expect(rows[0]?.action).toBe('changed 2 attributes')
      expect(rows[0]?.detail).toBe('Preferred channel, Relationship')
    })

    it('writes nothing for a PATCH that changes nothing', async () => {
      const personId = await createPerson('Ada Lovelace')

      await client.send('PATCH', `/v1/people/${personId}`, {
        body: { name: 'Ada Lovelace' },
        cookie: acme.cookie,
      })

      expect(await timeline('person', personId)).toHaveLength(1)
    })
  })

  describe('emission on link', () => {
    it('files a linked row on both ends of a new position', async () => {
      const personId = await createPerson('Ada Lovelace')
      const companyId = await createCompany('Analytical Engines')

      await client.send('POST', '/v1/positions', {
        body: { person_id: personId, company_id: companyId, title: 'Chief Mathematician' },
        cookie: acme.cookie,
      })

      const person = await timeline('person', personId)
      const company = await timeline('company', companyId)

      expect(person[0]?.kind).toBe('linked')
      expect(person[0]?.action).toBe('linked to company')
      expect(person[0]?.detail).toBe('Analytical Engines')
      expect(company[0]?.kind).toBe('linked')
      expect(company[0]?.action).toBe('linked to person')
      expect(company[0]?.detail).toBe('Ada Lovelace')
    })
  })

  describe('emission on note', () => {
    it('files a note_added row carrying the opening of the note', async () => {
      const personId = await createPerson('Ada Lovelace')

      await client.send('POST', '/v1/notes', {
        body: {
          target_type: 'person',
          target_id: personId,
          body: 'Cares about implementation, not price.',
        },
        cookie: acme.cookie,
      })

      const rows = await timeline('person', personId)

      expect(rows[0]?.kind).toBe('note_added')
      expect(rows[0]?.action).toBe('added a note')
      expect(rows[0]?.detail).toBe('Cares about implementation, not price.')
    })

    it('leaves the row behind when the note is deleted', async () => {
      const personId = await createPerson('Ada Lovelace')
      const created = await client.send('POST', '/v1/notes', {
        body: { target_type: 'person', target_id: personId, body: 'Body' },
        cookie: acme.cookie,
      })
      const noteId = readString(await created.json(), 'id')

      await client.send('DELETE', `/v1/notes/${noteId}`, { cookie: acme.cookie })

      const rows = await timeline('person', personId)

      expect(rows.map((row) => row.kind)).toEqual(['note_added', 'created'])
    })
  })

  describe('actor', () => {
    it('labels a workspace key rather than attributing it to a member', async () => {
      const keyResponse = await client.send('POST', '/v1/api-keys', {
        body: { name: 'CI', kind: 'workspace' },
        cookie: acme.cookie,
      })
      const secret = readString(await keyResponse.json(), 'secret')

      const created = await client.send('POST', '/v1/people', {
        body: { name: 'Grace Hopper' },
        bearer: secret,
      })
      const personId = readString(await created.json(), 'id')

      const rows = await timeline('person', personId)

      expect(rows[0]?.actor_member_id).toBeNull()
      expect(rows[0]?.actor_label).toBe('API key')
    })
  })

  describe('roll-up', () => {
    it("includes a company's deals on its timeline", async () => {
      const companyId = await createCompany('Analytical Engines')
      const dealId = await insertDeal('Northwind Pilot', companyId)

      await recordDealActivity(dealId, 'Pilot scoped')

      const rows = await timeline('company', companyId)

      expect(rows.map((row) => row.target_type)).toContain('deal')
      expect(rows.find((row) => row.target_type === 'deal')?.detail).toBe('Pilot scoped')
    })

    it("includes the deals a person is on, on their timeline", async () => {
      const companyId = await createCompany('Analytical Engines')
      const personId = await createPerson('Ada Lovelace')
      const dealId = await insertDeal('Northwind Pilot', companyId, personId)

      await recordDealActivity(dealId, 'Pilot scoped')

      const rows = await timeline('person', personId)

      expect(rows.find((row) => row.target_type === 'deal')?.target_id).toBe(dealId)
    })

    it("leaves out a deal the person is not on", async () => {
      const companyId = await createCompany('Analytical Engines')
      const personId = await createPerson('Ada Lovelace')
      const dealId = await insertDeal('Someone Elses Deal', companyId)

      await recordDealActivity(dealId, 'Not theirs')

      const rows = await timeline('person', personId)

      expect(rows.map((row) => row.target_type)).not.toContain('deal')
    })

    it("includes a person's partnerships", async () => {
      const companyId = await createCompany('Analytical Engines')
      const personId = await createPerson('Ada Lovelace')

      await database.db.insert(partnerships).values({
        id: 'prt_one',
        workspaceId: acme.workspaceId,
        name: 'Reseller',
        companyId,
        stageId: await firstStageId('partnership'),
        kind: 'reseller',
      })
      await database.db.insert(partnershipPeople).values({
        partnershipId: 'prt_one',
        personId,
      })

      await client.send('POST', '/v1/notes', {
        body: { target_type: 'partnership', target_id: 'prt_one', body: 'Quarterly review' },
        cookie: acme.cookie,
      })

      const rows = await timeline('person', personId)

      expect(rows.map((row) => row.target_type)).toContain('partnership')
    })
  })

  describe('reading', () => {
    it('returns newest first', async () => {
      const personId = await createPerson('Ada Lovelace')

      await client.send('PATCH', `/v1/people/${personId}`, {
        body: { relationship: 'warm' },
        cookie: acme.cookie,
      })

      const rows = await timeline('person', personId)

      expect(rows.map((row) => row.kind)).toEqual(['updated', 'created'])
    })

    it('answers 422 without a target and for an unknown target type', async () => {
      const personId = await createPerson('Ada Lovelace')

      expect((await client.send('GET', '/v1/activities', { cookie: acme.cookie })).status).toBe(422)
      expect(
        (
          await client.send(`GET`, `/v1/activities?target_type=role&target_id=${personId}`, {
            cookie: acme.cookie,
          })
        ).status,
      ).toBe(422)
    })

    it('answers 404 for a record that does not exist, and for one in another workspace', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const theirs = await createPerson('Grace Hopper', other.cookie)

      expect(
        (
          await client.send('GET', '/v1/activities?target_type=person&target_id=per_nope', {
            cookie: acme.cookie,
          })
        ).status,
      ).toBe(404)
      expect(
        (
          await client.send(`GET`, `/v1/activities?target_type=person&target_id=${theirs}`, {
            cookie: acme.cookie,
          })
        ).status,
      ).toBe(404)
    })

    it('answers 401 without credentials', async () => {
      const personId = await createPerson('Ada Lovelace')
      const response = await client.send(
        'GET',
        `/v1/activities?target_type=person&target_id=${personId}`,
      )

      expect(response.status).toBe(401)
    })

    it('pages, and the cursor keeps its place', async () => {
      const personId = await createPerson('Ada Lovelace')

      await client.send('PATCH', `/v1/people/${personId}`, {
        body: { relationship: 'warm' },
        cookie: acme.cookie,
      })
      await client.send('PATCH', `/v1/people/${personId}`, {
        body: { relationship: 'strong' },
        cookie: acme.cookie,
      })

      const first = await client.send(
        'GET',
        `/v1/activities?target_type=person&target_id=${personId}&limit=1`,
        { cookie: acme.cookie },
      )
      const firstBody = readRecord(await first.json())
      const cursor = firstBody.next_cursor

      expect(typeof cursor).toBe('string')

      const second = await client.send(
        'GET',
        `/v1/activities?target_type=person&target_id=${personId}&limit=1&cursor=${String(cursor)}`,
        { cookie: acme.cookie },
      )
      const secondRows = readList(await second.json())

      expect(readList(firstBody)[0]?.id).not.toBe(secondRows[0]?.id)
    })
  })

  describe('append-only', () => {
    it('has no route to change or remove one', async () => {
      const personId = await createPerson('Ada Lovelace')
      const activityId = String((await timeline('person', personId))[0]?.id)

      expect(
        (
          await client.send('PATCH', `/v1/activities/${activityId}`, {
            body: { action: 'rewrote history' },
            cookie: acme.cookie,
          })
        ).status,
      ).toBe(404)
      expect(
        (await client.send('DELETE', `/v1/activities/${activityId}`, { cookie: acme.cookie })).status,
      ).toBe(404)
      expect(
        (
          await client.send('POST', '/v1/activities', {
            body: { target_type: 'person', target_id: personId, kind: 'call', action: 'logged a call' },
            cookie: acme.cookie,
          })
        ).status,
      ).toBe(404)
    })
  })

  describe('deleting the record a timeline belongs to', () => {
    it('takes the activity with it', async () => {
      const personId = await createPerson('Ada Lovelace')

      await client.send('DELETE', `/v1/people/${personId}`, { cookie: acme.cookie })

      const response = await client.send(
        'GET',
        `/v1/activities?target_type=person&target_id=${personId}`,
        { cookie: acme.cookie },
      )

      expect(response.status).toBe(404)
    })
  })
})
