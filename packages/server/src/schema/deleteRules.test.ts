import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { isReferenceViolation } from '../lib/database.ts'
import { createIdFactory } from '../lib/ids.ts'
import { companies } from '../modules/companies/schema.ts'
import { deals } from '../modules/deals/schema.ts'
import { formFields, formSubmissions, forms } from '../modules/forms/schema.ts'
import { people, personLinks } from '../modules/people/schema.ts'
import { pipelineStages } from '../modules/pipelines/schema.ts'
import { positions } from '../modules/positions/schema.ts'
import { workspaces } from '../modules/workspace/schema.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { insertWorkspaceFixture } from '../testing/fixtures.ts'
import type { WorkspaceFixture } from '../testing/fixtures.ts'

/**
 * Delete semantics from `schema.md` and roadmap decision 2, asserted against real
 * Postgres. These are database-level rules: cascade to dependents, restrict on
 * independent references, set null on evidence records.
 *
 * The polymorphic dependents (notes, activities, decisions, plan items) have no
 * database foreign key by design, so their cleanup is a service-layer concern and
 * is not asserted here.
 */

/** Asserts the database refused the write because a row still references the target. */
async function expectBlockedByReference(operation: Promise<unknown>): Promise<void> {
  let thrown: unknown

  try {
    await operation
  } catch (error: unknown) {
    thrown = error
  }

  expect(isReferenceViolation(thrown)).toBe(true)
}

const connectionString = testDatabaseUrl(process.env)
const createId = createIdFactory()

describe.skipIf(connectionString === undefined)('delete rules', () => {
  let database: TestDatabase
  let fixture: WorkspaceFixture

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
    fixture = await insertWorkspaceFixture(database.db)
  })

  async function insertPerson(name: string): Promise<string> {
    const id = createId('person')
    await database.db.insert(people).values({
      id,
      workspaceId: fixture.workspaceId,
      name,
      email: `${id}@example.com`,
      preferredChannel: 'email',
      influence: 'champion',
      relationship: 'warm',
    })

    return id
  }

  async function insertCompany(name: string): Promise<string> {
    const id = createId('company')
    await database.db.insert(companies).values({
      id,
      workspaceId: fixture.workspaceId,
      name,
      domain: `${id}.example.com`,
      stage: 'startup',
      sizeBand: '1-10',
      accountType: 'prospect',
      icpFit: 'high',
    })

    return id
  }

  async function insertDealStage(slug: string): Promise<string> {
    const id = createId('pipelineStage')
    await database.db.insert(pipelineStages).values({
      id,
      workspaceId: fixture.workspaceId,
      kind: 'deal',
      slug,
      label: 'Qualifying',
      sortOrder: 0,
    })

    return id
  }

  async function insertDeal(companyId: string, stageId: string): Promise<string> {
    const id = createId('deal')
    await database.db.insert(deals).values({
      id,
      workspaceId: fixture.workspaceId,
      name: 'Acme rollout',
      companyId,
      stageId,
      ownerId: fixture.memberId,
    })

    return id
  }

  it('cascades positions when their person is deleted', async () => {
    const personId = await insertPerson('Grace Hopper')
    const companyId = await insertCompany('Univac')
    await database.db.insert(positions).values({
      id: createId('position'),
      workspaceId: fixture.workspaceId,
      personId,
      companyId,
      title: 'Engineer',
    })

    await database.db.delete(people).where(eq(people.id, personId))

    expect(await database.db.select().from(positions)).toHaveLength(0)
    expect(await database.db.select().from(companies)).toHaveLength(1)
  })

  it('blocks deleting a company that still has deals', async () => {
    const companyId = await insertCompany('Initech')
    const stageId = await insertDealStage('qualifying')
    await insertDeal(companyId, stageId)

    await expectBlockedByReference(database.db.delete(companies).where(eq(companies.id, companyId)))

    expect(await database.db.select().from(companies)).toHaveLength(1)
  })

  it('blocks deleting a pipeline stage that still has records', async () => {
    const companyId = await insertCompany('Hooli')
    const stageId = await insertDealStage('qualifying')
    await insertDeal(companyId, stageId)

    await expectBlockedByReference(
      database.db.delete(pipelineStages).where(eq(pipelineStages.id, stageId)),
    )
  })

  it('blocks deleting a person who is a deal contact', async () => {
    const personId = await insertPerson('Alan Turing')
    const companyId = await insertCompany('Bletchley')
    const stageId = await insertDealStage('qualifying')
    const dealId = await insertDeal(companyId, stageId)
    await database.db.insert(personLinks).values({
      id: createId('personLink'),
      workspaceId: fixture.workspaceId,
      personId,
      targetType: 'deal',
      targetId: dealId,
    })

    await expectBlockedByReference(database.db.delete(people).where(eq(people.id, personId)))
  })

  it('cascades fields and submissions when a form is deleted', async () => {
    const formId = createId('form')
    await database.db.insert(forms).values({
      id: formId,
      workspaceId: fixture.workspaceId,
      name: 'Contact us',
      title: 'Contact us',
      publicKey: `pk_${formId}`,
    })
    await database.db.insert(formFields).values({
      id: createId('formField'),
      workspaceId: fixture.workspaceId,
      formId,
      label: 'Email',
      type: 'email',
      mapTo: 'person.email',
      sortOrder: 0,
    })
    await database.db.insert(formSubmissions).values({
      id: createId('formSubmission'),
      workspaceId: fixture.workspaceId,
      formId,
      answers: { email: 'someone@example.com' },
    })

    await database.db.delete(forms).where(eq(forms.id, formId))

    expect(await database.db.select().from(formFields)).toHaveLength(0)
    expect(await database.db.select().from(formSubmissions)).toHaveLength(0)
  })

  it('sets a submission record link to null when the record is deleted', async () => {
    const personId = await insertPerson('Katherine Johnson')
    const formId = createId('form')
    await database.db.insert(forms).values({
      id: formId,
      workspaceId: fixture.workspaceId,
      name: 'Contact us',
      title: 'Contact us',
      publicKey: `pk_${formId}`,
    })
    const submissionId = createId('formSubmission')
    await database.db.insert(formSubmissions).values({
      id: submissionId,
      workspaceId: fixture.workspaceId,
      formId,
      answers: {},
      personId,
    })

    await database.db.delete(people).where(eq(people.id, personId))

    const [submission] = await database.db
      .select()
      .from(formSubmissions)
      .where(eq(formSubmissions.id, submissionId))

    expect(submission?.personId).toBeNull()
  })

  it('cascades everything the workspace owns when the workspace is deleted', async () => {
    const personId = await insertPerson('Margaret Hamilton')
    const companyId = await insertCompany('Draper')
    const stageId = await insertDealStage('qualifying')
    await insertDeal(companyId, stageId)
    await database.db.insert(positions).values({
      id: createId('position'),
      workspaceId: fixture.workspaceId,
      personId,
      companyId,
      title: 'Director of Software Engineering',
    })

    await database.db.delete(workspaces).where(eq(workspaces.id, fixture.workspaceId))

    expect(await database.db.select().from(people)).toHaveLength(0)
    expect(await database.db.select().from(companies)).toHaveLength(0)
    expect(await database.db.select().from(deals)).toHaveLength(0)
    expect(await database.db.select().from(positions)).toHaveLength(0)
    expect(await database.db.select().from(pipelineStages)).toHaveLength(0)
  })
})

describe.skipIf(connectionString === undefined)('migrations', () => {
  it('create every table the schema declares', async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    const database = await connectTestDatabase(connectionString)

    try {
      const rows = await database.db.execute<{ table_name: string }>(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_type = 'BASE TABLE'
          and table_name not like '\\_\\_drizzle\\_%'
      `)

      const names = [...rows].map((row) => row.table_name)

      expect(names).toContain('workspaces')
      expect(names).toContain('people')
      expect(names).toContain('handbook_pages')
      expect(names).toContain('password_reset_tokens')
      expect(names).toContain('email_verification_tokens')
      expect(names).toContain('import_job_rows')
      expect(names).toContain('workspace_module_settings')
      expect(names).toContain('rate_limit_buckets')
      expect(names).toContain('lists')
      expect(names).toContain('list_members')
      expect(names).toContain('person_links')
      expect(names).toContain('form_lists')
      expect(names).toContain('form_attach_targets')
      expect(names).toContain('custom_field_definitions')
      expect(names).not.toContain('deal_people')
      expect(names).not.toContain('partnership_people')
      expect(names).not.toContain('raise_people')
      expect(names).toHaveLength(42)
    } finally {
      await database.close()
    }
  })
})
