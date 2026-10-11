import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { grantPersonConsentIfAbsent, upsertPersonConsent } from './personConsentWrites.ts'
import { personConsents } from './schema.ts'

/**
 * The consent writes against a `person_consents` row that carries another
 * workspace.
 *
 * No request can write such a row: each caller reads the Person and the
 * purpose in its own workspace first. Each test puts one in the table
 * directly, to prove that the write also asks for the workspace and leaves
 * the row as it was.
 */

const connectionString = testDatabaseUrl(process.env)

const NOW = new Date('2026-10-11T09:00:00.000Z')
const NOTED_BEFORE = new Date('2026-01-05T12:00:00.000Z')

describe.skipIf(connectionString === undefined)('person consent writes', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let other: TestOwner
  let personId: string
  let purposeId: string

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
    other = await client.owner('grace@example.com')

    const person = await client.send('POST', '/v1/people', { body: { name: 'Ada Lovelace' }, cookie: acme.cookie })
    personId = readString(await person.json(), 'id')

    const purposes = readList(
      await (await client.send('GET', '/v1/consent_purposes', { cookie: acme.cookie })).json(),
    )
    const marketing = purposes.find((purpose) => purpose.slug === 'marketing')

    if (marketing === undefined) {
      throw new Error('A new workspace is expected to start with the marketing purpose')
    }

    purposeId = readString(marketing, 'id')

    await harness.services.db.insert(personConsents).values({
      workspaceId: other.workspaceId,
      personId,
      purposeId,
      status: 'withdrawn',
      notedAt: NOTED_BEFORE,
      source: 'manual',
    })
  })

  async function storedRows(): Promise<(typeof personConsents.$inferSelect)[]> {
    return harness.services.db
      .select()
      .from(personConsents)
      .where(and(eq(personConsents.personId, personId), eq(personConsents.purposeId, purposeId)))
  }

  function expectRowUnchanged(rows: readonly (typeof personConsents.$inferSelect)[]): void {
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      workspaceId: other.workspaceId,
      status: 'withdrawn',
      source: 'manual',
      notedAt: NOTED_BEFORE,
    })
  }

  it('refuses to set a status over the row, and leaves it as it was', async () => {
    await expect(
      harness.services.db.transaction((tx) =>
        upsertPersonConsent(tx, acme.workspaceId, personId, purposeId, 'marketing', 'Marketing', 'granted', 'manual', NOW),
      ),
    ).rejects.toThrow(`belongs to another workspace than ${acme.workspaceId}`)

    expectRowUnchanged(await storedRows())
  })

  it('does not delete the row when the status is cleared, and reports no earlier status', async () => {
    const change = await harness.services.db.transaction((tx) =>
      upsertPersonConsent(tx, acme.workspaceId, personId, purposeId, 'marketing', 'Marketing', null, 'manual', NOW),
    )

    expect(change).toEqual({ purposeSlug: 'marketing', purposeLabel: 'Marketing', status: null, previousStatus: null })
    expectRowUnchanged(await storedRows())
  })

  it('does not report the status of the row to a form submit', async () => {
    await expect(
      harness.services.db.transaction((tx) =>
        grantPersonConsentIfAbsent(tx, acme.workspaceId, personId, purposeId, 'form:form_1', NOW),
      ),
    ).rejects.toThrow(`was neither granted nor found in workspace ${acme.workspaceId}`)

    expectRowUnchanged(await storedRows())
  })

  it('still writes, reads back and clears a row of its own workspace', async () => {
    const contact = readList(
      await (await client.send('GET', '/v1/consent_purposes', { cookie: acme.cookie })).json(),
    ).find((purpose) => purpose.slug === 'contact')
    const contactId = readString(contact, 'id')

    const write = (status: 'granted' | 'withdrawn' | null): ReturnType<typeof upsertPersonConsent> =>
      harness.services.db.transaction((tx) =>
        upsertPersonConsent(tx, acme.workspaceId, personId, contactId, 'contact', 'Contact', status, 'manual', NOW),
      )

    expect(await write('granted')).toMatchObject({ status: 'granted', previousStatus: null })
    expect(await write('withdrawn')).toMatchObject({ status: 'withdrawn', previousStatus: 'granted' })
    expect(
      await harness.services.db.transaction((tx) =>
        grantPersonConsentIfAbsent(tx, acme.workspaceId, personId, contactId, 'form:form_1', NOW),
      ),
    ).toEqual({ applied: false, status: 'withdrawn' })
    expect(await write(null)).toMatchObject({ status: null, previousStatus: 'withdrawn' })
    expect(
      await harness.services.db.transaction((tx) =>
        grantPersonConsentIfAbsent(tx, acme.workspaceId, personId, contactId, 'form:form_1', NOW),
      ),
    ).toEqual({ applied: true, status: 'granted' })
  })
})
