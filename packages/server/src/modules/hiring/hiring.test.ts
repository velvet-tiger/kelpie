import { candidateSchema, roleSchema } from '@kelpie/schemas'
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
import { notes } from '../notes/schema.ts'
import { coreModules } from '../core.ts'
import { candidates } from './schema.ts'

/**
 * `/v1/roles` and `/v1/candidates` against real Postgres. Openings, the people
 * up for them, and the rule tying interview stage to candidate status.
 */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('hiring', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let roleId: string
  let aisha: string

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
    roleId = readString(await createRole({}), 'id')
    aisha = await createPerson('Aisha Rahman')
  })

  async function createPerson(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function createRole(
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/roles', {
      body: { title: 'Founding engineer', ...body },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  async function createCandidate(
    body: Record<string, unknown> = {},
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/candidates', {
      body: { role_id: roleId, person_id: aisha, ...body },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  async function patchCandidate(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('PATCH', `/v1/candidates/${id}`, {
      body,
      cookie: acme.cookie,
    })

    expect(response.status).toBe(200)

    return readRecord(await response.json())
  }

  async function activitiesFor(personId: string): Promise<Record<string, unknown>[]> {
    const response = await client.send(
      'GET',
      `/v1/activities?target_type=person&target_id=${personId}`,
      { cookie: acme.cookie },
    )

    return readList(await response.json())
  }

  describe('roles', () => {
    it('creates an open role from a title', async () => {
      const role = await createRole({})

      expect(role.id).toMatch(/^role_/u)
      expect(role.title).toBe('Founding engineer')
      expect(role.status).toBe('open')
    })

    it('closes and reopens a role', async () => {
      const closed = await client.send('PATCH', `/v1/roles/${roleId}`, {
        body: { status: 'closed' },
        cookie: acme.cookie,
      })

      expect(closed.status).toBe(200)
      expect(readRecord(await closed.json()).status).toBe('closed')

      const renamed = await client.send('PATCH', `/v1/roles/${roleId}`, {
        body: { title: 'Founding engineer (backend)', status: 'open' },
        cookie: acme.cookie,
      })
      const updated = readRecord(await renamed.json())

      expect(updated.title).toBe('Founding engineer (backend)')
      expect(updated.status).toBe('open')
    })

    it('writes nothing when nothing changes', async () => {
      const role = await createRole({ title: 'Product designer' })
      const id = readString(role, 'id')
      const response = await client.send('PATCH', `/v1/roles/${id}`, {
        body: { title: 'Product designer' },
        cookie: acme.cookie,
      })

      expect(readRecord(await response.json()).updated_at).toBe(role.updated_at)
    })

    it('filters by title and by status', async () => {
      const designer = await createRole({ title: 'Product designer', status: 'closed' })

      const byTitle = await client.send('GET', '/v1/roles?q=designer', { cookie: acme.cookie })
      const byStatus = await client.send('GET', '/v1/roles?status=closed', { cookie: acme.cookie })
      const byNothing = await client.send('GET', '/v1/roles?q=zeppelin', { cookie: acme.cookie })

      expect(readList(await byTitle.json()).map((item) => item.id)).toEqual([designer.id])
      expect(readList(await byStatus.json()).map((item) => item.id)).toEqual([designer.id])
      expect(readList(await byNothing.json())).toHaveLength(0)
    })

    it('refuses malformed values with 422', async () => {
      const cases: Record<string, unknown>[] = [
        {},
        { title: '' },
        { title: 'X', status: 'paused' },
        { title: 'X', headcount: 2 },
      ]

      for (const body of cases) {
        const response = await client.send('POST', '/v1/roles', { body, cookie: acme.cookie })

        expect(response.status).toBe(422)
      }

      const unknownStatus = await client.send('GET', '/v1/roles?status=paused', {
        cookie: acme.cookie,
      })

      expect(unknownStatus.status).toBe(422)
    })

    it('needs credentials', async () => {
      expect((await client.send('GET', '/v1/roles')).status).toBe(401)
      expect((await client.send('POST', '/v1/roles', { body: { title: 'X' } })).status).toBe(401)
    })

    it('keeps workspaces apart', async () => {
      const other = await client.owner('grace@example.com', 'other')

      const list = await client.send('GET', '/v1/roles', { cookie: other.cookie })
      const get = await client.send('GET', `/v1/roles/${roleId}`, { cookie: other.cookie })

      expect(readList(await list.json())).toHaveLength(0)
      expect(get.status).toBe(404)
    })
  })

  describe('candidates', () => {
    it('attaches a person to a role, in process at the first stage', async () => {
      const candidate = await createCandidate()

      expect(candidate.id).toMatch(/^cand_/u)
      expect(candidate.role_id).toBe(roleId)
      expect(candidate.person_id).toBe(aisha)
      expect(candidate.status).toBe('in_process')
      expect(candidate.interview_stage).toBe('sourced')
      expect(candidate.referrer_person_id).toBeNull()
    })

    it("files the link on the person's timeline, naming the role", async () => {
      await createCandidate()

      const linked = (await activitiesFor(aisha)).find(
        (activity) => activity.kind === 'linked' && activity.action === 'linked to role',
      )

      expect(linked?.detail).toBe('Founding engineer')
    })

    it('takes a status, a stage, and a referrer', async () => {
      const elena = await createPerson('Elena Sokolova')
      const candidate = await createCandidate({
        status: 'in_process',
        interview_stage: 'interview',
        referrer_person_id: elena,
      })

      expect(candidate.interview_stage).toBe('interview')
      expect(candidate.referrer_person_id).toBe(elena)
    })

    it('starts a nurtured candidate with no stage at all', async () => {
      const candidate = await createCandidate({ status: 'nurture' })

      expect(candidate.status).toBe('nurture')
      expect(candidate.interview_stage).toBeNull()
    })

    it('refuses the same person on the same role twice with 409', async () => {
      await createCandidate()

      const response = await client.send('POST', '/v1/candidates', {
        body: { role_id: roleId, person_id: aisha },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(409)
    })

    it('allows the same person on a second role', async () => {
      const second = readString(await createRole({ title: 'Product designer' }), 'id')

      await createCandidate()

      const response = await client.send('POST', '/v1/candidates', {
        body: { role_id: second, person_id: aisha },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(201)
    })

    it('reports a role or person outside the workspace as missing', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const foreignRole = readString(
        await createRole({ title: 'Foreign role' }, other.cookie),
        'id',
      )
      const foreignPerson = await createPerson('Grace Hopper', other.cookie)

      const byRole = await client.send('POST', '/v1/candidates', {
        body: { role_id: foreignRole, person_id: aisha },
        cookie: acme.cookie,
      })
      const byPerson = await client.send('POST', '/v1/candidates', {
        body: { role_id: roleId, person_id: foreignPerson },
        cookie: acme.cookie,
      })
      const byReferrer = await client.send('POST', '/v1/candidates', {
        body: { role_id: roleId, person_id: aisha, referrer_person_id: foreignPerson },
        cookie: acme.cookie,
      })

      expect(byRole.status).toBe(404)
      expect(byPerson.status).toBe(404)
      expect(byReferrer.status).toBe(404)
    })

    it('refuses malformed values with 422', async () => {
      const cases: Record<string, unknown>[] = [
        {},
        { role_id: roleId },
        { person_id: aisha },
        { role_id: roleId, person_id: aisha, status: 'ghosted' },
        { role_id: roleId, person_id: aisha, interview_stage: 'onsite' },
        { role_id: roleId, person_id: aisha, referrer_person_id: aisha },
        { role_id: roleId, person_id: aisha, notes: 'Strong systems design' },
      ]

      for (const body of cases) {
        const response = await client.send('POST', '/v1/candidates', { body, cookie: acme.cookie })

        expect(response.status).toBe(422)
      }
    })

    it('filters by role, person, and status', async () => {
      const second = readString(await createRole({ title: 'Product designer' }), 'id')
      const marcus = await createPerson('Marcus Webb')
      const inProcess = readString(await createCandidate(), 'id')
      const nurtured = readString(
        await createCandidate({ role_id: second, person_id: marcus, status: 'nurture' }),
        'id',
      )

      const byRole = await client.send('GET', `/v1/candidates?role_id=${second}`, {
        cookie: acme.cookie,
      })
      const byPerson = await client.send('GET', `/v1/candidates?person_id=${aisha}`, {
        cookie: acme.cookie,
      })
      const byStatus = await client.send('GET', '/v1/candidates?status=nurture', {
        cookie: acme.cookie,
      })

      expect(readList(await byRole.json()).map((item) => item.id)).toEqual([nurtured])
      expect(readList(await byPerson.json()).map((item) => item.id)).toEqual([inProcess])
      expect(readList(await byStatus.json()).map((item) => item.id)).toEqual([nurtured])
    })

    it('names a set of roles in one request, for a page of counts', async () => {
      const second = readString(await createRole({ title: 'Product designer' }), 'id')
      const marcus = await createPerson('Marcus Webb')

      await createCandidate()
      await createCandidate({ role_id: second, person_id: marcus })

      const response = await client.send(
        'GET',
        `/v1/candidates?role_id=${roleId}&role_id=${second}`,
        { cookie: acme.cookie },
      )

      expect(readList(await response.json())).toHaveLength(2)
    })

    it('refuses an unknown status filter with 422', async () => {
      const response = await client.send('GET', '/v1/candidates?status=ghosted', {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('keeps workspaces apart', async () => {
      const candidate = await createCandidate()
      const other = await client.owner('grace@example.com', 'other')

      const list = await client.send('GET', '/v1/candidates', { cookie: other.cookie })
      const get = await client.send('GET', `/v1/candidates/${String(candidate.id)}`, {
        cookie: other.cookie,
      })

      expect(readList(await list.json())).toHaveLength(0)
      expect(get.status).toBe(404)
    })
  })

  describe('the interview stage follows the status', () => {
    it('clears the stage when the candidate leaves the process', async () => {
      const candidate = await createCandidate({ interview_stage: 'interview' })
      const passed = await patchCandidate(readString(candidate, 'id'), { status: 'passed' })

      expect(passed.status).toBe('passed')
      expect(passed.interview_stage).toBeNull()
    })

    it('restores the first stage when the candidate rejoins it', async () => {
      const candidate = await createCandidate({ status: 'nurture' })
      const id = readString(candidate, 'id')

      const resumed = await patchCandidate(id, { status: 'in_process' })

      expect(resumed.interview_stage).toBe('sourced')

      const named = await patchCandidate(id, { status: 'in_process', interview_stage: 'offer' })

      expect(named.interview_stage).toBe('offer')
    })

    it('refuses a stage that contradicts the status', async () => {
      const id = readString(await createCandidate({ status: 'nurture' }), 'id')

      const onNurture = await client.send('PATCH', `/v1/candidates/${id}`, {
        body: { interview_stage: 'screen' },
        cookie: acme.cookie,
      })
      const clearingInProcess = await client.send('PATCH', `/v1/candidates/${id}`, {
        body: { status: 'in_process', interview_stage: null },
        cookie: acme.cookie,
      })

      expect(onNurture.status).toBe(422)
      expect(clearingInProcess.status).toBe(422)
    })

    it("files stage and status moves on the person's timeline in the mockup's words", async () => {
      const candidate = await createCandidate({ interview_stage: 'screen' })
      const id = readString(candidate, 'id')

      await patchCandidate(id, { interview_stage: 'interview' })

      const stageMove = (await activitiesFor(aisha)).find(
        (activity) => activity.action === 'changed Interview stage',
      )

      expect(stageMove?.detail).toBe('Screen → Interview')

      await patchCandidate(id, { status: 'nurture' })

      const statusMove = (await activitiesFor(aisha)).find(
        (activity) => activity.action === 'changed 2 attributes',
      )

      expect(statusMove?.detail).toBe('Candidate status, Interview stage')
    })

    it('names both referrers when one replaces another', async () => {
      const elena = await createPerson('Elena Sokolova')
      const marcus = await createPerson('Marcus Webb')
      const id = readString(await createCandidate({ referrer_person_id: elena }), 'id')

      await patchCandidate(id, { referrer_person_id: marcus })

      const change = (await activitiesFor(aisha)).find(
        (activity) => activity.action === 'changed Referrer',
      )

      expect(change?.detail).toBe('Elena Sokolova → Marcus Webb')

      const cleared = await patchCandidate(id, { referrer_person_id: null })

      expect(cleared.referrer_person_id).toBeNull()
    })

    it('writes nothing when nothing changes', async () => {
      const candidate = await createCandidate()
      const response = await client.send('PATCH', `/v1/candidates/${String(candidate.id)}`, {
        body: { status: 'in_process' },
        cookie: acme.cookie,
      })

      expect(readRecord(await response.json()).updated_at).toBe(candidate.updated_at)
    })
  })

  describe('deleting', () => {
    async function noteOn(candidateId: string): Promise<void> {
      const response = await client.send('POST', '/v1/notes', {
        body: {
          target_type: 'candidate',
          target_id: candidateId,
          body: 'Strong systems design; light on product sense.',
        },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(201)
    }

    async function notesLeftOn(candidateId: string): Promise<number> {
      const rows = await database.db
        .select({ id: notes.id })
        .from(notes)
        .where(and(eq(notes.targetType, 'candidate'), eq(notes.targetId, candidateId)))

      return rows.length
    }

    it('removes a candidacy with its interview notes, and files the unlink', async () => {
      const id = readString(await createCandidate(), 'id')

      await noteOn(id)

      const response = await client.send('DELETE', `/v1/candidates/${id}`, { cookie: acme.cookie })

      expect(response.status).toBe(204)
      expect(
        (await client.send('GET', `/v1/candidates/${id}`, { cookie: acme.cookie })).status,
      ).toBe(404)
      expect(await notesLeftOn(id)).toBe(0)

      const unlinked = (await activitiesFor(aisha)).find(
        (activity) => activity.action === 'unlinked from role',
      )

      expect(unlinked?.detail).toBe('Founding engineer')
    })

    it('takes every candidacy on a deleted role, with their notes', async () => {
      const id = readString(await createCandidate(), 'id')

      await noteOn(id)

      const response = await client.send('DELETE', `/v1/roles/${roleId}`, { cookie: acme.cookie })

      expect(response.status).toBe(204)
      expect(await notesLeftOn(id)).toBe(0)

      const left = await database.db
        .select({ id: candidates.id })
        .from(candidates)
        .where(eq(candidates.roleId, roleId))

      expect(left).toHaveLength(0)

      const unlinked = (await activitiesFor(aisha)).find(
        (activity) => activity.action === 'unlinked from role',
      )

      expect(unlinked?.detail).toBe('Founding engineer')
    })

    it("takes a deleted person's candidacies and their notes", async () => {
      const id = readString(await createCandidate(), 'id')

      await noteOn(id)

      const response = await client.send('DELETE', `/v1/people/${aisha}`, { cookie: acme.cookie })

      expect(response.status).toBe(204)
      expect(await notesLeftOn(id)).toBe(0)
    })

    it('refuses to delete a person another candidacy refers', async () => {
      const elena = await createPerson('Elena Sokolova')

      await createCandidate({ referrer_person_id: elena })

      const response = await client.send('DELETE', `/v1/people/${elena}`, { cookie: acme.cookie })

      expect(response.status).toBe(409)
    })
  })

  describe('the wire contract', () => {
    it('answers every read path with the shape @kelpie/schemas decodes', async () => {
      const elena = await createPerson('Elena Sokolova')
      const created = await createCandidate({
        interview_stage: 'interview',
        referrer_person_id: elena,
      })
      const id = String(created.id)

      expect(candidateSchema.parse(created).personId).toBe(aisha)

      const detail = await client.send('GET', `/v1/candidates/${id}`, { cookie: acme.cookie })
      expect(candidateSchema.parse(readRecord(await detail.json())).id).toBe(created.id)

      const listed = await client.send('GET', '/v1/candidates', { cookie: acme.cookie })
      expect(readList(await listed.json()).map((item) => candidateSchema.parse(item).id)).toContain(
        created.id,
      )

      const patched = await patchCandidate(id, { status: 'hired' })
      expect(candidateSchema.parse(patched).interviewStage).toBeNull()

      const role = await client.send('GET', `/v1/roles/${roleId}`, { cookie: acme.cookie })
      expect(roleSchema.parse(readRecord(await role.json())).title).toBe('Founding engineer')

      const roles = await client.send('GET', '/v1/roles', { cookie: acme.cookie })
      expect(readList(await roles.json()).map((item) => roleSchema.parse(item).id)).toContain(
        roleId,
      )
    })
  })
})
