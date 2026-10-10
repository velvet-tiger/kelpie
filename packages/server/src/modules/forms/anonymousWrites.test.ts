import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { companies } from '../companies/schema.ts'
import { coreModules } from '../core.ts'
import { people } from '../people/schema.ts'
import { positions } from '../positions/schema.ts'
import { raises } from '../raises/schema.ts'

/**
 * What a submit with no credentials may write, against real Postgres.
 *
 * The caller is a stranger. The email address and the company name they type
 * are claims, not proof. So a value the visitor supplies is written only on a
 * record the submit creates, never on one it matched or is attached to, and a
 * value the REST API would refuse reaches no record and never fails the submit.
 */

const connectionString = testDatabaseUrl(process.env)

const BASE_FIELDS = [
  { label: 'Name', type: 'text', map_to: 'person.name', required: true },
  { label: 'Email', type: 'email', map_to: 'person.email', required: true },
  { label: 'Company', type: 'text', map_to: 'company.name' },
  { label: 'Website', type: 'text', map_to: 'company.domain' },
  { label: 'Job title', type: 'text', map_to: 'position.title' },
]

describe.skipIf(connectionString === undefined)('what an anonymous submit may write', () => {
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

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  async function createForm(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/forms', {
      body: { name: 'Website contact', fields: BASE_FIELDS, ...body },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  /** A form's field ids, keyed by the label each was created with. */
  function fieldIds(form: Record<string, unknown>): Record<string, string> {
    const fields = Array.isArray(form.fields) ? form.fields : []

    return Object.fromEntries(
      fields.filter(isRecord).map((field) => [String(field.label), String(field.id)]),
    )
  }

  /** A public submit of `answers`, keyed by label, plus the two required answers. */
  function submit(
    form: Record<string, unknown>,
    answers: Record<string, string>,
    email = 'alex@example.com',
  ): Promise<Response> {
    const ids = fieldIds(form)
    const byId = Object.fromEntries(
      Object.entries({ Name: 'Alex Rivera', Email: email, ...answers }).map(([label, value]) => [
        ids[label] ?? `missing:${label}`,
        value,
      ]),
    )

    return client.send(
      'POST',
      `/v1/public/workspaces/${acme.workspaceId}/forms/${readString(form, 'slug')}/submit`,
      { body: { answers: byId } },
    )
  }

  /** The newest submission of a form, as the authenticated read gives it. */
  async function submissionFor(form: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await client.send('GET', `/v1/forms/${readString(form, 'id')}/submissions`, {
      cookie: acme.cookie,
    })
    const [row] = readList(await response.json())

    if (row === undefined) {
      throw new Error('Expected the form to have a submission')
    }

    return row
  }

  async function create(path: string, body: Record<string, unknown>): Promise<string> {
    const response = await client.send('POST', path, { body, cookie: acme.cookie })

    expect(response.status).toBe(201)

    return readString(await response.json(), 'id')
  }

  async function firstStageOfKind(kind: string): Promise<string> {
    const response = await client.send('GET', `/v1/pipeline_stages?kind=${kind}`, {
      cookie: acme.cookie,
    })

    return readString(readList(await response.json())[0] ?? {}, 'id')
  }

  /** A raise the form attaches its submitters to: the one record a submit maps onto but never creates. */
  async function createRaise(): Promise<string> {
    const companyId = await create('/v1/companies', { name: 'Northwind Capital' })

    return create('/v1/raises', {
      name: 'Seed round',
      company_id: companyId,
      stage_id: await firstStageOfKind('raise'),
    })
  }

  async function raiseForm(mapTo: string): Promise<{
    readonly form: Record<string, unknown>
    readonly raiseId: string
  }> {
    const raiseId = await createRaise()
    const form = await createForm({
      fields: [...BASE_FIELDS, { label: 'Extra', type: 'text', map_to: mapTo }],
      attach_targets: [{ target_type: 'raise', target_id: raiseId }],
    })

    return { form, raiseId }
  }

  async function personByEmail(email: string): Promise<typeof people.$inferSelect> {
    const rows = await database.db.select().from(people).where(eq(people.email, email))

    if (rows[0] === undefined) {
      throw new Error(`Expected a person with the address ${email}`)
    }

    return rows[0]
  }

  describe('a company the submit matched', () => {
    it('links to a company matched by name and leaves its blank domain blank', async () => {
      const companyId = await create('/v1/companies', { name: 'Example Co' })
      const form = await createForm()

      const response = await submit(form, {
        Company: 'example co',
        Website: 'attacker.example',
        'Job title': 'Chief Executive',
      })

      expect(response.status).toBe(201)

      const rows = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))

      // One company: the name matched it, and the visitor's domain went nowhere.
      expect(rows).toHaveLength(1)
      expect(rows[0]?.domain).toBeNull()

      // The link itself is the product's purpose and stays.
      const held = await database.db.select().from(positions).where(eq(positions.companyId, companyId))

      expect(held).toHaveLength(1)
      expect(held[0]?.title).toBe('Chief Executive')
    })

    it('leaves the domain of a name-matched company that already has one', async () => {
      await create('/v1/companies', { name: 'Example Co', domain: 'example.com' })
      const form = await createForm()

      await submit(form, { Company: 'Example Co', Website: 'attacker.example' })

      const rows = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))

      expect(rows).toHaveLength(1)
      expect(rows[0]?.domain).toBe('example.com')
    })

    it('matches on the domain before the name, and keeps the stored name', async () => {
      await create('/v1/companies', { name: 'Example Co', domain: 'example.com' })
      const form = await createForm()

      await submit(form, { Company: 'Another name', Website: 'example.com' })

      const rows = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))

      expect(rows).toHaveLength(1)
      expect(rows[0]?.name).toBe('Example Co')
    })

    it('still writes the domain on a company the submit creates', async () => {
      const form = await createForm()

      await submit(form, { Company: 'Brand New Co', Website: 'brandnew.example' })

      const rows = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))

      expect(rows).toHaveLength(1)
      expect(rows[0]?.domain).toBe('brandnew.example')
    })
  })

  describe('a mapped value the REST API would refuse', () => {
    it.each([
      ['a number too large to store', 'raise.check_size_cents', '1e30'],
      ['a number that is not whole', 'raise.check_size_cents', '12.5'],
      ['a negative number', 'raise.check_size_cents', '-5'],
      ['a date that is not a date', 'raise.expected_close', 'next week'],
      ['a currency that is not a code', 'raise.currency', 'dollars'],
    ])('skips %s, records the submission, and says so on its log', async (_name, target, value) => {
      const { form, raiseId } = await raiseForm(target)
      const [before] = await database.db.select().from(raises).where(eq(raises.id, raiseId))

      const response = await submit(form, { Extra: value })

      expect(response.status).toBe(201)

      const [raise] = await database.db.select().from(raises).where(eq(raises.id, raiseId))

      expect(before?.checkSizeCents).toBeNull()
      expect(before?.expectedClose).toBeNull()
      expect(raise?.checkSizeCents).toBeNull()
      expect(raise?.expectedClose).toBeNull()
      expect(raise?.currency).toBe(before?.currency)

      const submission = await submissionFor(form)

      // The answer is kept on the submission, as it was typed.
      expect(Object.values(readRecord(submission.answers))).toContain(value)
      expect(submission.action_log).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: `map_field:${target}`, status: 'skipped' }),
        ]),
      )
    })

    it('still writes a value the API would take, on a record the submit creates', async () => {
      const form = await createForm({
        fields: [...BASE_FIELDS, { label: 'Timezone', type: 'text', map_to: 'person.timezone' }],
      })

      await submit(form, { Timezone: 'Australia/Melbourne' })

      expect((await personByEmail('alex@example.com')).timezone).toBe('Australia/Melbourne')
      expect((await submissionFor(form)).action_log).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ status: 'skipped' })]),
      )
    })

    it('skips a one-line field that is longer than the API allows', async () => {
      const form = await createForm({
        fields: [...BASE_FIELDS, { label: 'Timezone', type: 'text', map_to: 'person.timezone' }],
      })

      const response = await submit(form, { Timezone: 'x'.repeat(501) })

      expect(response.status).toBe(201)
      expect((await personByEmail('alex@example.com')).timezone).toBeNull()
      expect((await submissionFor(form)).action_log).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'map_field:person.timezone', status: 'skipped' }),
        ]),
      )
    })

    it('creates no position from a title longer than the API allows', async () => {
      const form = await createForm()

      const response = await submit(form, { Company: 'Example Co', 'Job title': 'x'.repeat(501) })

      expect(response.status).toBe(201)
      expect(await database.db.select().from(positions)).toHaveLength(0)
      expect(await database.db.select().from(companies)).toHaveLength(1)
    })

    it('creates no company from a name longer than the API allows', async () => {
      const form = await createForm()

      const response = await submit(form, { Company: 'x'.repeat(501) })

      expect(response.status).toBe(201)
      expect(await database.db.select().from(companies)).toHaveLength(0)
    })

    it('falls back to the address for a person name longer than the API allows', async () => {
      const form = await createForm()

      const response = await submit(form, { Name: 'x'.repeat(501) })

      expect(response.status).toBe(201)
      expect((await personByEmail('alex@example.com')).name).toBe('alex')
    })
  })

  describe('a database error while writing mapped values', () => {
    it('rolls back that write alone, logs it, and keeps the submission', async () => {
      const form = await createForm({
        fields: [...BASE_FIELDS, { label: 'Timezone', type: 'text', map_to: 'person.timezone' }],
      })

      // The one way to make a write fail that the value check lets through: a
      // constraint the check knows nothing about. Removed again whatever happens.
      await database.db.execute(
        sql`ALTER TABLE people ADD CONSTRAINT test_short_timezone CHECK (timezone IS NULL OR length(timezone) < 5)`,
      )

      try {
        const response = await submit(form, { Timezone: 'Australia/Melbourne', Company: 'Example Co' })

        expect(response.status).toBe(201)

        // The person and the rest of the submit are there. Only the mapped write is not.
        expect((await personByEmail('alex@example.com')).timezone).toBeNull()
        expect(await database.db.select().from(companies)).toHaveLength(1)

        const submission = await submissionFor(form)

        expect(submission.person_id).not.toBeNull()
        expect(submission.action_log).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ action: 'map_fields:person', status: 'error' }),
          ]),
        )
      } finally {
        await database.db.execute(sql`ALTER TABLE people DROP CONSTRAINT IF EXISTS test_short_timezone`)
      }
    })
  })

  describe('a record that was already in the workspace', () => {
    /** One log entry per answer that went on no record, with the reason staff read. */
    function notWritten(target: string): unknown {
      return expect.objectContaining({
        action: `map_field:${target}`,
        status: 'skipped',
        detail: 'The record already existed',
      })
    }

    const PERSON_FIELDS = [
      { label: 'Name', type: 'text', map_to: 'person.name', required: true },
      { label: 'Email', type: 'email', map_to: 'person.email', required: true },
      { label: 'First name', type: 'text', map_to: 'person.first_name' },
      { label: 'Last name', type: 'text', map_to: 'person.last_name' },
      { label: 'Phone', type: 'text', map_to: 'person.phones' },
      { label: 'Salutation', type: 'text', map_to: 'person.salutation' },
      { label: 'Suffix', type: 'text', map_to: 'person.suffix' },
      { label: 'Timezone', type: 'text', map_to: 'person.timezone' },
      { label: 'About', type: 'textarea', map_to: 'person.summary' },
      { label: 'City', type: 'text', map_to: 'person.address.city' },
      { label: 'Interests', type: 'text', map_to: 'person.tags' },
      {
        label: 'Topic',
        type: 'select',
        map_to: 'person.custom_fields.topic',
        options: [{ key: 'pricing', value: 'Pricing' }],
      },
      { label: 'Stop contacting me', type: 'text', map_to: 'person.do_not_contact' },
    ]
    const PERSON_ANSWERS = {
      Name: 'Somebody Else',
      'First name': 'Somebody',
      'Last name': 'Else',
      Phone: '+61 400 000 000',
      Salutation: 'Dr',
      Suffix: 'Jr',
      Timezone: 'Australia/Melbourne',
      About: 'Approved for a discount',
      City: 'Melbourne',
      Interests: 'vip',
      Topic: 'pricing',
      'Stop contacting me': 'true',
    }

    async function personForm(): Promise<Record<string, unknown>> {
      await create('/v1/custom_fields', {
        object_type: 'person',
        key: 'topic',
        label: 'Topic',
        type: 'text',
      })

      return createForm({ fields: PERSON_FIELDS })
    }

    it('writes every answer on a person the submit creates', async () => {
      const form = await personForm()

      expect((await submit(form, PERSON_ANSWERS)).status).toBe(201)

      const person = await personByEmail('alex@example.com')

      expect(person).toMatchObject({
        name: 'Somebody Else',
        firstName: 'Somebody',
        lastName: 'Else',
        phones: ['+61 400 000 000'],
        salutation: 'Dr',
        suffix: 'Jr',
        timezone: 'Australia/Melbourne',
        summary: 'Approved for a discount',
        tags: ['vip'],
        doNotContact: true,
        customFields: { topic: 'pricing' },
      })
      expect(person.addresses[0]?.city).toBe('Melbourne')
      expect((await submissionFor(form)).action_log).toEqual([])
    })

    it('writes no answer on a person it matched by address, and logs each one', async () => {
      await create('/v1/people', { name: 'Alex Rivera', email: 'alex@example.com', tags: ['lead'] })
      const before = await personByEmail('alex@example.com')
      const form = await personForm()

      expect((await submit(form, PERSON_ANSWERS)).status).toBe(201)

      const person = await personByEmail('alex@example.com')

      expect(person).toMatchObject({
        name: 'Alex Rivera',
        firstName: before.firstName,
        lastName: before.lastName,
        phones: [],
        salutation: null,
        suffix: null,
        timezone: null,
        summary: '',
        tags: ['lead'],
        doNotContact: false,
        customFields: {},
        addresses: [],
      })
      // The one thing a submit stamps on a person it matched.
      expect(person.lastContactedAt).not.toBeNull()

      const submission = await submissionFor(form)

      expect(submission.person_id).toBe(person.id)
      // Every answer is still on the submission, for a member to read and copy.
      expect(Object.values(readRecord(submission.answers))).toEqual(
        expect.arrayContaining(Object.values(PERSON_ANSWERS)),
      )
      expect(submission.action_log).toEqual(
        expect.arrayContaining(
          PERSON_FIELDS.map((field) => field.map_to)
            .filter((target) => target !== 'person.email')
            .map(notWritten),
        ),
      )
      expect(submission.action_log).not.toEqual(expect.arrayContaining([notWritten('person.email')]))
    })

    it('never clears do not contact, and never sets it, on a person it matched', async () => {
      await create('/v1/people', {
        name: 'Alex Rivera',
        email: 'alex@example.com',
        do_not_contact: true,
      })
      await create('/v1/people', { name: 'Sam Lee', email: 'sam@example.com' })
      const form = await personForm()

      await submit(form, { 'Stop contacting me': 'false' })
      await submit(form, { 'Stop contacting me': 'true' }, 'sam@example.com')

      expect((await personByEmail('alex@example.com')).doNotContact).toBe(true)
      expect((await personByEmail('sam@example.com')).doNotContact).toBe(false)
    })

    it('adds no tag from a select field to a person it matched', async () => {
      await create('/v1/people', { name: 'Alex Rivera', email: 'alex@example.com', tags: ['lead'] })
      const form = await createForm({
        fields: [
          ...BASE_FIELDS,
          {
            label: 'Interests',
            type: 'select',
            map_to: 'person.tags',
            options: [{ key: 'demo', value: 'A demo' }],
          },
        ],
      })

      await submit(form, { Interests: 'demo' })

      expect((await personByEmail('alex@example.com')).tags).toEqual(['lead'])
      expect((await submissionFor(form)).action_log).toEqual(
        expect.arrayContaining([notWritten('person.tags')]),
      )
    })

    it('still adds the tags the form owner set to a person it matched', async () => {
      await create('/v1/people', { name: 'Alex Rivera', email: 'alex@example.com', tags: ['lead'] })
      const form = await createForm({ person_tags: ['inbound'] })

      await submit(form, {})

      expect((await personByEmail('alex@example.com')).tags).toEqual(['lead', 'inbound'])
    })

    it('writes no answer on a company it matched, by name or by domain', async () => {
      const byName = await create('/v1/companies', { name: 'Example Co', tags: ['customer'] })
      const byDomain = await create('/v1/companies', { name: 'Northwind', domain: 'northwind.example' })
      const form = await createForm({
        fields: [
          ...BASE_FIELDS,
          { label: 'Industry', type: 'text', map_to: 'company.industry' },
          { label: 'Segment', type: 'text', map_to: 'company.tags' },
        ],
      })

      await submit(form, {
        Company: 'Example Co',
        Website: 'attacker.example',
        Industry: 'Logistics',
        Segment: 'enterprise',
      })

      const [named] = await database.db.select().from(companies).where(eq(companies.id, byName))

      expect(named).toMatchObject({ domain: null, industry: null, tags: ['customer'] })
      // The name is what matched, so it is not an answer that went nowhere.
      expect((await submissionFor(form)).action_log).toEqual(
        expect.arrayContaining([
          notWritten('company.domain'),
          notWritten('company.industry'),
          notWritten('company.tags'),
        ]),
      )
      expect((await submissionFor(form)).action_log).not.toEqual(
        expect.arrayContaining([notWritten('company.name')]),
      )

      await submit(form, { Company: 'Another name', Website: 'northwind.example', Industry: 'Mining' }, 'sam@example.com')

      const [matched] = await database.db.select().from(companies).where(eq(companies.id, byDomain))

      expect(matched).toMatchObject({ name: 'Northwind', industry: null })
      expect(await database.db.select().from(companies)).toHaveLength(2)
    })

    it('writes the mapped answers on a company the submit creates', async () => {
      const form = await createForm({
        fields: [...BASE_FIELDS, { label: 'Industry', type: 'text', map_to: 'company.industry' }],
      })

      await submit(form, { Company: 'Brand New Co', Industry: 'Logistics' })

      const [company] = await database.db.select().from(companies)

      expect(company).toMatchObject({ name: 'Brand New Co', industry: 'Logistics' })
    })

    it('writes no answer on a raise the form attaches to', async () => {
      const { form, raiseId } = await raiseForm('raise.check_size_cents')

      expect((await submit(form, { Extra: '250000' })).status).toBe(201)

      const [raise] = await database.db.select().from(raises).where(eq(raises.id, raiseId))

      expect(raise?.checkSizeCents).toBeNull()
      expect((await submissionFor(form)).action_log).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: `attach:raise:${raiseId}`, status: 'ok' }),
          notWritten('raise.check_size_cents'),
        ]),
      )
    })

    it('keeps the title of a position the person already holds, and logs the new one', async () => {
      const form = await createForm()

      await submit(form, { Company: 'Example Co', 'Job title': 'Head of Ops' })
      await submit(form, { Company: 'Example Co', 'Job title': 'Chief Executive' })

      const held = await database.db.select().from(positions)

      expect(held).toHaveLength(1)
      expect(held[0]?.title).toBe('Head of Ops')
      expect((await submissionFor(form)).action_log).toEqual(
        expect.arrayContaining([notWritten('position.title')]),
      )
    })
  })

  describe('the embed page and the request headers', () => {
    /** The page, asked for as a request that names another host would reach the service. */
    async function loadEmbedAs(form: Record<string, unknown>, origin: string): Promise<Response> {
      return harness.app.request(
        `${origin}/v1/public/workspaces/${acme.workspaceId}/forms/${readString(form, 'id')}/embed`,
        { headers: { 'X-Forwarded-Proto': 'https' } },
      )
    }

    function readConfig(page: string): Record<string, unknown> {
      const match = /<script type="application\/json" id="kelpie-config">(.*?)<\/script>/su.exec(page)

      if (match?.[1] === undefined) {
        throw new Error('Expected the page to carry its config')
      }

      return readRecord(JSON.parse(match[1]))
    }

    it('posts to its own origin whatever host the request named', async () => {
      const form = await createForm()
      const response = await loadEmbedAs(form, 'http://attacker.example')

      expect(response.status).toBe(200)
      // The page is stored by shared caches, so nothing in it may come from a
      // header a caller chose.
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')

      const page = await response.text()

      expect(page).not.toContain('attacker.example')
      expect(readConfig(page).submitUrl).toBe(
        `/v1/public/workspaces/${acme.workspaceId}/forms/${readString(form, 'slug')}/submit`,
      )
    })

    it('asks its own origin for the spam-check token', async () => {
      const form = await createForm({ require_spam_check: true })
      const page = await (await loadEmbedAs(form, 'http://attacker.example')).text()

      expect(page).not.toContain('attacker.example')
      expect(readConfig(page).tokenUrl).toBe(
        `/v1/public/workspaces/${acme.workspaceId}/forms/${readString(form, 'id')}/token`,
      )
    })
  })
})
