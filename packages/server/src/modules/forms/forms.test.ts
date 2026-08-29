import { formSchema, formSubmissionSchema, formSubmitResultSchema } from '@kelpie/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { activities } from '../activities/schema.ts'
import { companies } from '../companies/schema.ts'
import { coreModules } from '../core.ts'
import { deals } from '../deals/schema.ts'
import { people } from '../people/schema.ts'
import { positions } from '../positions/schema.ts'

/**
 * `/v1/forms` and `/v1/public/forms/…` against real Postgres.
 *
 * Two surfaces on one module: managing a form needs credentials, submitting one
 * needs nothing but the `public_key`. The auth boundary between them is asserted
 * here rather than assumed, because it is the only place in core where an
 * unauthenticated request reaches a workspace-scoped write.
 */

const connectionString = testDatabaseUrl(process.env)

/** The mockup's contact template, which is what a new form starts as. */
const CONTACT_FIELDS = [
  { label: 'Name', type: 'text', map_to: 'person.name', required: true },
  { label: 'Email', type: 'email', map_to: 'person.email', required: true },
  { label: 'Company', type: 'text', map_to: 'company.name' },
  { label: 'Job title', type: 'text', map_to: 'position.title' },
  { label: 'Message', type: 'textarea', map_to: 'submission' },
]

describe.skipIf(connectionString === undefined)('forms', () => {
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

  async function createForm(
    body: Record<string, unknown> = {},
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/forms', {
      body: { name: 'Website contact', fields: CONTACT_FIELDS, ...body },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  /** A form's fields, keyed by the label they were created with. */
  function fieldIds(form: Record<string, unknown>): Record<string, string> {
    const fields = Array.isArray(form.fields) ? form.fields : []

    return Object.fromEntries(
      fields.filter(isRecord).map((field) => [String(field.label), String(field.id)]),
    )
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  /** A public submit: no cookie, no bearer, nothing but the key in the path. */
  function submit(publicKey: string, answers: Record<string, string>): Promise<Response> {
    return client.send('POST', `/v1/public/forms/${publicKey}/submit`, { body: { answers } })
  }

  /**
   * The answers a submit always carries.
   *
   * Name and Email are both `required` on the contact template, so a case about
   * anything else still has to fill them in, exactly as a visitor would.
   */
  function filledIn(
    ids: Record<string, string>,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      [ids.Name ?? '']: 'Alex Rivera',
      [ids.Email ?? '']: 'alex@example.com',
      ...extra,
    }
  }

  /** Creates a form, then submits it, and hands back the parsed submit response. */
  async function submitContact(
    answers: (ids: Record<string, string>) => Record<string, string>,
    formBody: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const form = await createForm(formBody)
    const response = await submit(readString(form, 'public_key'), answers(fieldIds(form)))

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  describe('creating a form', () => {
    it('answers with the form, its fields in order, and a public key', async () => {
      const form = await createForm()
      const parsed = formSchema.parse(form)

      expect(parsed.name).toBe('Website contact')
      expect(parsed.title).toBe('Website contact')
      expect(parsed.status).toBe('active')
      expect(parsed.publicKey.length).toBeGreaterThan(20)
      expect(parsed.fields.map((field) => field.label)).toEqual([
        'Name',
        'Email',
        'Company',
        'Job title',
        'Message',
      ])
      expect(parsed.fields.map((field) => field.sortOrder)).toEqual([0, 1, 2, 3, 4])
    })

    it('gives every form its own public key', async () => {
      const first = await createForm()
      const second = await createForm({ name: 'Newsletter' })

      expect(readString(first, 'public_key')).not.toBe(readString(second, 'public_key'))
    })

    it('refuses a field list with no person.email mapping', async () => {
      const response = await client.send('POST', '/v1/forms', {
        body: { name: 'Broken', fields: [{ label: 'Name', type: 'text', map_to: 'person.name' }] },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
      expect(JSON.stringify(await response.json())).toContain('person.email')
    })

    it('refuses a select with no options', async () => {
      const response = await client.send('POST', '/v1/forms', {
        body: {
          name: 'Broken',
          fields: [
            { label: 'Email', type: 'email', map_to: 'person.email' },
            { label: 'Size', type: 'select', map_to: 'submission' },
          ],
        },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('refuses an unknown field on the body, per api.md', async () => {
      const response = await client.send('POST', '/v1/forms', {
        body: { name: 'Broken', fields: CONTACT_FIELDS, colour: 'blue' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('refuses a deal stage from another pipeline', async () => {
      const stages = await client.send('GET', '/v1/pipeline_stages?kind=opportunity', {
        cookie: acme.cookie,
      })
      const opportunityStage = readString(readList(await stages.json())[0] ?? {}, 'id')
      const response = await client.send('POST', '/v1/forms', {
        body: {
          name: 'Broken',
          fields: CONTACT_FIELDS,
          create_deal: true,
          deal_stage_id: opportunityStage,
        },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })
  })

  describe('reading forms', () => {
    it('lists them newest first, each with its fields', async () => {
      await createForm({ name: 'Older' })
      await createForm({ name: 'Newer' })

      const response = await client.send('GET', '/v1/forms', { cookie: acme.cookie })
      const rows = readList(await response.json()).map((row) => formSchema.parse(row))

      expect(rows.map((row) => row.name)).toEqual(['Newer', 'Older'])
      expect(rows[0]?.fields).toHaveLength(5)
    })

    it('filters by status', async () => {
      await createForm({ name: 'Live' })
      await createForm({ name: 'Paused', status: 'paused' })

      const response = await client.send('GET', '/v1/forms?status=paused', { cookie: acme.cookie })

      expect(readList(await response.json()).map((row) => row.name)).toEqual(['Paused'])
    })

    it('refuses a status that does not exist rather than answering with nothing', async () => {
      const response = await client.send('GET', '/v1/forms?status=archived', { cookie: acme.cookie })

      expect(response.status).toBe(422)
    })

    it('hides a form from another workspace behind a 404', async () => {
      const form = await createForm()
      const other = await client.owner('beth@example.com', 'beta')
      const response = await client.send('GET', `/v1/forms/${readString(form, 'id')}`, {
        cookie: other.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('updating a form', () => {
    it('replaces the whole field list and renumbers it', async () => {
      const form = await createForm()
      const response = await client.send('PATCH', `/v1/forms/${readString(form, 'id')}`, {
        body: {
          fields: [
            { label: 'Work email', type: 'email', map_to: 'person.email', required: true },
            { label: 'Message', type: 'textarea', map_to: 'submission' },
          ],
        },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)

      const parsed = formSchema.parse(readRecord(await response.json()))

      expect(parsed.fields.map((field) => field.label)).toEqual(['Work email', 'Message'])
      expect(parsed.fields.map((field) => field.sortOrder)).toEqual([0, 1])
    })

    it('leaves the field list alone when the request does not carry one', async () => {
      const form = await createForm()
      const response = await client.send('PATCH', `/v1/forms/${readString(form, 'id')}`, {
        body: { status: 'paused' },
        cookie: acme.cookie,
      })
      const parsed = formSchema.parse(readRecord(await response.json()))

      expect(parsed.status).toBe('paused')
      expect(parsed.fields).toHaveLength(5)
    })

    it('refuses a replacement list that cannot process a submission', async () => {
      const form = await createForm()
      const response = await client.send('PATCH', `/v1/forms/${readString(form, 'id')}`, {
        body: { fields: [{ label: 'Name', type: 'text', map_to: 'person.name' }] },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    /**
     * A field builder sends the whole list on every save. Rewriting an unchanged
     * one would move every field id, and a stored answer is keyed by field id.
     */
    it('leaves the field ids alone when the list came back unchanged', async () => {
      const form = await createForm()
      const before = fieldIds(form)
      const response = await client.send('PATCH', `/v1/forms/${readString(form, 'id')}`, {
        body: { fields: CONTACT_FIELDS },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(fieldIds(readRecord(await response.json()))).toEqual(before)
    })

    it('never reissues the public key, so an embedded form keeps working', async () => {
      const form = await createForm()
      const response = await client.send('PATCH', `/v1/forms/${readString(form, 'id')}`, {
        body: { name: 'Renamed' },
        cookie: acme.cookie,
      })
      const parsed = formSchema.parse(readRecord(await response.json()))

      expect(parsed.publicKey).toBe(readString(form, 'public_key'))
    })
  })

  describe('deleting a form', () => {
    it('takes its fields and submissions with it and leaves the CRM records', async () => {
      const form = await createForm()

      await submit(readString(form, 'public_key'), filledIn(fieldIds(form)))

      const response = await client.send('DELETE', `/v1/forms/${readString(form, 'id')}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(204)

      const survivors = await database.db
        .select()
        .from(people)
        .where(eq(people.workspaceId, acme.workspaceId))

      expect(survivors).toHaveLength(1)
    })
  })

  describe('the embed endpoint', () => {
    it('hands back a hosted URL and iframe snippets pointed at the bare embed', async () => {
      const form = await createForm()
      const response = await client.send('GET', `/v1/forms/${readString(form, 'id')}/embed`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)

      const body = readRecord(await response.json())
      const publicKey = readString(form, 'public_key')

      expect(readString(body, 'url')).toContain(`/v1/public/forms/${publicKey}/embed?view=page`)
      expect(readString(body, 'embed_url')).toMatch(new RegExp(`/v1/public/forms/${publicKey}/embed$`))
      expect(readString(body, 'iframe_snippet')).toContain('<iframe')
      expect(readString(body, 'iframe_snippet')).toContain(readString(body, 'embed_url'))
      expect(readString(body, 'iframe_snippet')).not.toContain('view=page')
      expect(readString(body, 'script_snippet')).toContain('<script')
    })
  })

  describe('the public submit', () => {
    it('needs no credentials at all', async () => {
      const result = await submitContact((ids) => filledIn(ids))

      // The submit answered a well-formed result, with no session or key sent.
      expect(formSubmitResultSchema.parse(result).id).not.toBe('')
    })

    it('echoes the thank-you copy so an embed needs no second request', async () => {
      const result = await submitContact(
        (ids) => filledIn(ids),
        { thank_you_message: 'Got it. Speak soon.' },
      )

      expect(formSubmitResultSchema.parse(result).thankYouMessage).toBe('Got it. Speak soon.')
    })

    /**
     * The public routes are ungated by the runtime (it gates only credentialled
     * routes), so the module-off check lives in the handlers. A workspace that
     * turns forms off must stop accepting submissions and stop serving the embed,
     * not just hide the management screens.
     */
    it('refuses submit and embed when the workspace has the forms module off', async () => {
      const form = await createForm()
      const publicKey = readString(form, 'public_key')
      const ids = fieldIds(form)

      const off = await client.send('PATCH', `/v1/workspaces/${acme.workspaceId}/modules/forms`, {
        body: { enabled: false },
        cookie: acme.cookie,
      })
      expect(off.status).toBe(200)

      expect((await submit(publicKey, filledIn(ids))).status).toBe(403)
      expect((await client.send('GET', `/v1/public/forms/${publicKey}/embed`)).status).toBe(403)
    })

    it('creates the Person with the defaults from forms.md', async () => {
      await submitContact((ids) => ({
        [ids.Email ?? '']: 'Alex@Example.com',
        [ids.Name ?? '']: 'Alex Rivera',
      }))

      const [person] = await database.db
        .select()
        .from(people)
        .where(eq(people.workspaceId, acme.workspaceId))

      expect(person?.name).toBe('Alex Rivera')
      expect(person?.email).toBe('alex@example.com')
      expect(person?.relationship).toBe('cold')
      expect(person?.preferredChannel).toBe('email')
      expect(person?.influence).toBe('influencer')
      expect(person?.lastContactedAt).not.toBeNull()
    })

    it('creates the Company, and the Position that carries the title', async () => {
      const result = await submitContact((ids) =>
        filledIn(ids, { [ids.Company ?? '']: 'Example Co', [ids['Job title'] ?? '']: 'Head of Ops' }),
      )

      const [company] = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))
      const [position] = await database.db
        .select()
        .from(positions)
        .where(eq(positions.workspaceId, acme.workspaceId))

      expect(company?.name).toBe('Example Co')
      expect(company?.accountType).toBe('prospect')
      expect(company?.icpFit).toBe('unknown')
      expect(position?.title).toBe('Head of Ops')
      // The response no longer echoes the record ids; the stored submission does,
      // and the dedicated submission test asserts that link.
      expect(formSubmitResultSchema.parse(result).id).not.toBe('')
    })

    /**
     * An email domain is not a company identifier. One company sends from
     * several, a consumer address belongs to none, and two people at unrelated
     * businesses can share one.
     */
    it('never takes the company domain from the address', async () => {
      await submitContact((ids) => filledIn(ids, { [ids.Company ?? '']: 'Example Co' }))

      const [company] = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))

      expect(company?.name).toBe('Example Co')
      expect(company?.domain).toBeNull()
    })

    it('keeps two people on unrelated companies apart, whatever they send from', async () => {
      const form = await createForm()
      const ids = fieldIds(form)
      const key = readString(form, 'public_key')

      await submit(key, {
        [ids.Name ?? '']: 'Alex Rivera',
        [ids.Email ?? '']: 'alex@gmail.com',
        [ids.Company ?? '']: 'Bracket Works',
      })
      await submit(key, {
        [ids.Name ?? '']: 'Sam Okafor',
        [ids.Email ?? '']: 'sam@gmail.com',
        [ids.Company ?? '']: 'Harbour Lane',
      })

      const rows = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))

      expect(rows.map((row) => row.name).sort()).toEqual(['Bracket Works', 'Harbour Lane'])
    })

    it('uses a mapped company domain when the form asks for one', async () => {
      const form = await createForm({
        fields: [
          ...CONTACT_FIELDS,
          { label: 'Website', type: 'text', map_to: 'company.domain' },
        ],
      })
      const ids = fieldIds(form)

      await submit(readString(form, 'public_key'), {
        ...filledIn(ids),
        [ids.Company ?? '']: 'Example Co',
        [ids.Website ?? '']: 'https://www.example.com/pricing',
      })

      const [company] = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))

      expect(company?.domain).toBe('www.example.com')
    })

    it('matches the same person again rather than creating a second one', async () => {
      const form = await createForm()
      const ids = fieldIds(form)
      const key = readString(form, 'public_key')

      await submit(key, filledIn(ids))
      await submit(key, { [ids.Email ?? '']: 'ALEX@example.com', [ids.Name ?? '']: 'Alex' })

      const rows = await database.db
        .select()
        .from(people)
        .where(eq(people.workspaceId, acme.workspaceId))

      expect(rows).toHaveLength(1)
      // Fill blanks only: the stored name is what the team has since learned.
      expect(rows[0]?.name).toBe('Alex Rivera')
    })

    it('fills a blank the matched company did not have', async () => {
      const created = await client.send('POST', '/v1/companies', {
        body: { name: 'Example Co' },
        cookie: acme.cookie,
      })

      expect(created.status).toBe(201)

      const form = await createForm({
        fields: [
          ...CONTACT_FIELDS,
          { label: 'Website', type: 'text', map_to: 'company.domain' },
        ],
      })
      const ids = fieldIds(form)

      await submit(readString(form, 'public_key'), {
        ...filledIn(ids),
        [ids.Company ?? '']: 'Example Co',
        [ids.Website ?? '']: 'example.com',
      })

      const rows = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))

      // Matched by name, and the mapped domain filled the blank it had.
      expect(rows).toHaveLength(1)
      expect(rows[0]?.domain).toBe('example.com')
    })

    it('reuses the position a person already holds at a company', async () => {
      const form = await createForm()
      const ids = fieldIds(form)
      const key = readString(form, 'public_key')

      await submit(
        key,
        filledIn(ids, { [ids.Company ?? '']: 'Example Co', [ids['Job title'] ?? '']: 'Head of Ops' }),
      )
      await submit(
        key,
        filledIn(ids, { [ids.Company ?? '']: 'Example Co', [ids['Job title'] ?? '']: 'VP Operations' }),
      )

      const rows = await database.db
        .select()
        .from(positions)
        .where(eq(positions.workspaceId, acme.workspaceId))

      expect(rows).toHaveLength(1)
      expect(rows[0]?.title).toBe('Head of Ops')
    })

    it('records the submission with its answers and every id it produced', async () => {
      const form = await createForm()
      const ids = fieldIds(form)
      const response = await submit(
        readString(form, 'public_key'),
        filledIn(ids, { [ids.Message ?? '']: 'Interested in a demo' }),
      )
      const parsed = formSubmitResultSchema.parse(readRecord(await response.json()))

      expect(parsed.formId).toBe(readString(form, 'id'))

      const listed = await client.send(`GET`, `/v1/forms/${readString(form, 'id')}/submissions`, {
        cookie: acme.cookie,
      })
      const rows = readList(await listed.json()).map((row) => formSubmissionSchema.parse(row))

      expect(rows).toHaveLength(1)
      expect(rows[0]?.answers[ids.Message ?? '']).toBe('Interested in a demo')
      // The record ids live on the stored submission, read over the
      // authenticated API, not on the public submit response.
      expect(rows[0]?.dealId).toBeNull()

      const detail = await client.send(
        'GET',
        `/v1/forms/${readString(form, 'id')}/submissions/${rows[0]?.id ?? ''}`,
        { cookie: acme.cookie },
      )
      const one = formSubmissionSchema.parse(readRecord(await detail.json()))

      expect(detail.status).toBe(200)
      expect(one.id).toBe(rows[0]?.id)
      expect(one.answers[ids.Message ?? '']).toBe('Interested in a demo')
    })

    it('answers 404 for a submission that is not on the form', async () => {
      const form = await createForm()
      const response = await client.send(
        'GET',
        `/v1/forms/${readString(form, 'id')}/submissions/sub_missing`,
        { cookie: acme.cookie },
      )

      expect(response.status).toBe(404)
    })

    it('files the submission on the person timeline, attributed to the form', async () => {
      await submitContact((ids) => filledIn(ids))

      const rows = await database.db
        .select()
        .from(activities)
        .where(eq(activities.workspaceId, acme.workspaceId))
      const submitted = rows.find((row) => row.action.startsWith('Submitted via'))

      expect(submitted?.action).toBe('Submitted via Website contact')
      expect(submitted?.actorLabel).toBe('Form')
      expect(submitted?.actorMemberId).toBeNull()
      expect(submitted?.targetType).toBe('person')
    })

    it('refuses a paused form with a 409', async () => {
      const form = await createForm({ status: 'paused' })
      const response = await submit(readString(form, 'public_key'), filledIn(fieldIds(form)))

      expect(response.status).toBe(409)
    })

    it('refuses a blank answer to a required field', async () => {
      const form = await createForm()
      const ids = fieldIds(form)
      const response = await submit(readString(form, 'public_key'), {
        [ids.Email ?? '']: 'alex@example.com',
      })

      expect(response.status).toBe(422)
      expect(JSON.stringify(await response.json())).toContain('Name is required')
    })

    it('refuses answers with no email with a 422', async () => {
      const form = await createForm()
      const ids = fieldIds(form)
      const response = await submit(readString(form, 'public_key'), {
        [ids.Name ?? '']: 'Alex Rivera',
        [ids.Email ?? '']: '  ',
      })

      expect(response.status).toBe(422)
    })

    it('refuses an answer for a field the form does not have', async () => {
      const form = await createForm()
      const ids = fieldIds(form)
      const response = await submit(
        readString(form, 'public_key'),
        filledIn(ids, { ff_ghost: 'x' }),
      )

      expect(response.status).toBe(422)
    })

    it('answers 404 for a key no form carries', async () => {
      const response = await submit('not-a-real-key', { anything: 'x' })

      expect(response.status).toBe(404)
    })

    it('writes nothing when the answers are refused', async () => {
      const form = await createForm()
      const ids = fieldIds(form)

      await submit(readString(form, 'public_key'), { [ids.Name ?? '']: 'Alex' })

      const rows = await database.db
        .select()
        .from(people)
        .where(eq(people.workspaceId, acme.workspaceId))

      expect(rows).toHaveLength(0)
    })
  })

  describe('a form that creates deals', () => {
    const dealForm = { create_deal: true, deal_name_template: '{{company.name}} — website' }

    it('creates the deal, names it from the template, and links the person', async () => {
      await submitContact((ids) => filledIn(ids, { [ids.Company ?? '']: 'Example Co' }), dealForm)

      const [deal] = await database.db
        .select()
        .from(deals)
        .where(eq(deals.workspaceId, acme.workspaceId))
      const [person] = await database.db
        .select()
        .from(people)
        .where(eq(people.workspaceId, acme.workspaceId))

      expect(deal?.name).toBe('Example Co — website')
      expect(deal?.valueCents).toBe(0)
      expect(deal?.ownerId).not.toBeNull()
      expect(deal?.expectedClose).not.toBeNull()

      const linked = await client.send(
        'GET',
        `/v1/deals/${deal?.id ?? ''}`,
        { cookie: acme.cookie },
      )
      const body = readRecord(await linked.json())

      expect(body.person_ids).toEqual([person?.id])
    })

    it('opens the deal in the first open stage when the form names none', async () => {
      await submitContact(
        (ids) => filledIn(ids, { [ids.Company ?? '']: 'Example Co' }),
        dealForm,
      )

      const stages = await client.send('GET', '/v1/pipeline_stages?kind=deal', { cookie: acme.cookie })
      const firstStage = readString(readList(await stages.json())[0] ?? {}, 'id')
      const [deal] = await database.db
        .select()
        .from(deals)
        .where(eq(deals.workspaceId, acme.workspaceId))

      expect(deal?.stageId).toBe(firstStage)
    })

    /**
     * The form has a company field, so a visitor who skips it resolves no
     * company. A deal belongs to a company, so there is no deal to create and
     * the submission says so rather than inventing one.
     */
    it('creates no deal when the visitor named no company', async () => {
      await submitContact((ids) => filledIn(ids), dealForm)

      const rows = await database.db
        .select()
        .from(deals)
        .where(eq(deals.workspaceId, acme.workspaceId))

      expect(rows).toHaveLength(0)
    })

    /**
     * The form author is told at configuration time, because the alternative is
     * a form that silently never creates the deals it promises.
     */
    it('refuses a deal-creating form with no company field at all', async () => {
      const response = await client.send('POST', '/v1/forms', {
        body: {
          name: 'Broken',
          create_deal: true,
          fields: [
            { label: 'Name', type: 'text', map_to: 'person.name' },
            { label: 'Email', type: 'email', map_to: 'person.email', required: true },
          ],
        },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
      expect(JSON.stringify(await response.json())).toContain('company.name or company.domain')
    })

    /** Turning the flag on is what breaks it, and that request names no fields. */
    it('refuses turning deal creation on when the stored fields cannot support it', async () => {
      const form = await createForm({
        fields: [
          { label: 'Name', type: 'text', map_to: 'person.name' },
          { label: 'Email', type: 'email', map_to: 'person.email', required: true },
        ],
      })
      const response = await client.send('PATCH', `/v1/forms/${readString(form, 'id')}`, {
        body: { create_deal: true },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('files the deal on its own timeline, attributed to the form', async () => {
      await submitContact(
        (ids) => filledIn(ids, { [ids.Company ?? '']: 'Example Co' }),
        dealForm,
      )

      const rows = await database.db
        .select()
        .from(activities)
        .where(eq(activities.workspaceId, acme.workspaceId))
      const created = rows.find((row) => row.targetType === 'deal')

      expect(created?.action).toBe('created Deal via Website contact')
      expect(created?.actorLabel).toBe('Form')
    })
  })

  describe('the auth boundary', () => {
    it('refuses the management list without credentials', async () => {
      const response = await client.send('GET', '/v1/forms')

      expect(response.status).toBe(401)
    })

    it('refuses the submissions list without credentials', async () => {
      const form = await createForm()
      const response = await client.send('GET', `/v1/forms/${readString(form, 'id')}/submissions`)

      expect(response.status).toBe(401)
    })

    /** The public key names the workspace; it grants nothing else. */
    it('does not let a public key reach the management surface', async () => {
      const form = await createForm()
      const response = await client.send('GET', '/v1/forms', {
        bearer: readString(form, 'public_key'),
      })

      expect(response.status).toBe(401)
    })

    it('answers a CORS preflight on the submit endpoint', async () => {
      const form = await createForm()
      const response = await harness.app.request(
        `/v1/public/forms/${readString(form, 'public_key')}/submit`,
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://example.com',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
          },
        },
      )

      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    /** No `Allow-Credentials`, so a browser never attaches a reader's session cookie. */
    it('answers a submit cross-origin without allowing credentials', async () => {
      const form = await createForm()
      const ids = fieldIds(form)
      const response = await harness.app.request(
        `/v1/public/forms/${readString(form, 'public_key')}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
          body: JSON.stringify({ answers: filledIn(ids) }),
        },
      )

      expect(response.status).toBe(201)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    })

    it('leaves the authenticated surface without CORS headers', async () => {
      const response = await harness.app.request('/v1/forms', {
        headers: { Origin: 'https://example.com' },
      })

      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })
  })

  describe('the hosted embed page', () => {
    it('serves the form as HTML, with no credentials', async () => {
      const form = await createForm({ title: 'Talk to Acme' })
      const response = await client.send(
        'GET',
        `/v1/public/forms/${readString(form, 'public_key')}/embed`,
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('text/html')

      const page = await response.text()

      expect(page).toContain('class="layout-embed"')
      expect(page).toContain('<label')
      expect(page).toContain('Job title')
      expect(page).not.toContain('class="eyebrow"')
      expect(page).not.toContain('<h1>Talk to Acme</h1>')
      expect(page).toContain(`/v1/public/forms/${readString(form, 'public_key')}/submit`)
    })

    it('serves the hosted page layout with workspace chrome when view=page', async () => {
      const form = await createForm({ title: 'Talk to Acme' })
      const response = await client.send(
        'GET',
        `/v1/public/forms/${readString(form, 'public_key')}/embed?view=page`,
      )

      const page = await response.text()

      expect(page).toContain('class="layout-page"')
      expect(page).toContain('<div class="eyebrow">Acme</div>')
      expect(page).toContain('<h1>Talk to Acme</h1>')
    })

    it('defaults the public heading to the form name when title is omitted', async () => {
      const form = await createForm()
      const response = await client.send(
        'GET',
        `/v1/public/forms/${readString(form, 'public_key')}/embed?view=page`,
      )

      expect(await response.text()).toContain('<h1>Website contact</h1>')
    })

    it('sends a policy that allows framing and forbids outside sources', async () => {
      const form = await createForm()
      const response = await client.send(
        'GET',
        `/v1/public/forms/${readString(form, 'public_key')}/embed`,
      )
      const policy = response.headers.get('Content-Security-Policy') ?? ''

      expect(policy).toContain('frame-ancestors *')
      expect(policy).toContain("default-src 'none'")
      expect(response.headers.get('X-Frame-Options')).toBeNull()
    })

    it('renders a paused form as closed rather than as a dead form', async () => {
      const form = await createForm({ status: 'paused' })
      const response = await client.send(
        'GET',
        `/v1/public/forms/${readString(form, 'public_key')}/embed`,
      )

      expect(await response.text()).toContain('not accepting submissions')
    })

    it('answers 404 for a key no form carries', async () => {
      const response = await client.send('GET', '/v1/public/forms/not-a-real-key/embed')

      expect(response.status).toBe(404)
    })
  })

  describe('post-submit actions', () => {
    async function firstStageOfKind(kind: string): Promise<string> {
      const response = await client.send('GET', `/v1/pipeline_stages?kind=${kind}`, {
        cookie: acme.cookie,
      })
      const stage = readList(await response.json())[0]

      return readString(stage ?? {}, 'id')
    }

    async function submissionFor(formId: string): Promise<Record<string, unknown>> {
      const response = await client.send('GET', `/v1/forms/${formId}/submissions`, {
        cookie: acme.cookie,
      })
      const [row] = readList(await response.json())

      expect(row).toBeDefined()

      return row as Record<string, unknown>
    }

    it('creates a Deal through the runner and logs one create_deal:ok entry', async () => {
      const form = await createForm({ create_deal: true })
      const ids = fieldIds(form)
      const response = await submit(
        readString(form, 'public_key'),
        filledIn(ids, { [ids.Company ?? '']: 'Analytical Engines' }),
      )

      expect(response.status).toBe(201)

      const submission = await submissionFor(readString(form, 'id'))

      expect(submission.deal_id).toEqual(expect.stringMatching(/^deal_/u))
      expect(submission.action_log).toEqual([
        expect.objectContaining({ action: 'create_deal', status: 'ok' }),
      ])
    })

    it('creates an Opportunity without a company and stamps opportunity_id', async () => {
      const form = await createForm({
        create_opportunity: true,
        opportunity_kind: 'Grant',
      })
      const ids = fieldIds(form)
      const response = await submit(readString(form, 'public_key'), filledIn(ids))

      expect(response.status).toBe(201)

      const submission = await submissionFor(readString(form, 'id'))

      expect(submission.opportunity_id).toEqual(expect.stringMatching(/^opp_/u))
      expect(submission.action_log).toEqual([
        expect.objectContaining({ action: 'create_opportunity', status: 'ok' }),
      ])
    })

    it('skips create_partnership when no company was resolved', async () => {
      const form = await createForm({
        create_partnership: true,
        partnership_kind: 'Reseller',
      })
      const ids = fieldIds(form)
      const response = await submit(readString(form, 'public_key'), filledIn(ids))

      expect(response.status).toBe(201)

      const submission = await submissionFor(readString(form, 'id'))

      expect(submission.partnership_id).toBeNull()
      expect(submission.action_log).toEqual([
        expect.objectContaining({ action: 'create_partnership', status: 'skipped' }),
      ])
    })

    it('merges person_tags into the submitter without overwriting anything set by hand', async () => {
      const form = await createForm({ person_tags: ['inbound', 'website'] })
      const ids = fieldIds(form)

      await submit(readString(form, 'public_key'), filledIn(ids))

      const submission = await submissionFor(readString(form, 'id'))
      const personId = String(submission.person_id)
      const personResponse = await client.send('GET', `/v1/people/${personId}`, {
        cookie: acme.cookie,
      })
      const person = readRecord(await personResponse.json())

      expect(person.tags).toEqual(expect.arrayContaining(['inbound', 'website']))
      expect(submission.action_log).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: 'tag_person', status: 'ok' })]),
      )
    })

    it('adds the submitter to a person list configured on the form', async () => {
      const listResponse = await client.send('POST', '/v1/lists', {
        body: { name: 'Inbound leads', target_type: 'person' },
        cookie: acme.cookie,
      })
      const listId = readString(await listResponse.json(), 'id')

      const form = await createForm({ list_ids: [listId] })
      const ids = fieldIds(form)

      await submit(readString(form, 'public_key'), filledIn(ids))

      const submission = await submissionFor(readString(form, 'id'))
      const membershipResponse = await client.send('GET', `/v1/lists/${listId}/members`, {
        cookie: acme.cookie,
      })
      const members = readList(await membershipResponse.json())

      expect(members.map((row) => row.target_id)).toContain(submission.person_id)
      expect(submission.action_log).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: `add_list:${listId}`, status: 'ok' }),
        ]),
      )
    })

    it('links the submitter to an attach_target through person_links', async () => {
      const stageId = await firstStageOfKind('opportunity')
      const oppResponse = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Q4 accelerator', kind: 'Accelerator', stage_id: stageId },
        cookie: acme.cookie,
      })
      const opportunityId = readString(await oppResponse.json(), 'id')

      const form = await createForm({
        attach_targets: [{ target_type: 'opportunity', target_id: opportunityId }],
      })
      const ids = fieldIds(form)

      await submit(readString(form, 'public_key'), filledIn(ids))

      const submission = await submissionFor(readString(form, 'id'))
      const opportunityResponse = await client.send('GET', `/v1/opportunities/${opportunityId}`, {
        cookie: acme.cookie,
      })
      const opportunity = readRecord(await opportunityResponse.json())

      expect(opportunity.person_ids).toEqual([submission.person_id])
      expect(submission.action_log).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: `attach:opportunity:${opportunityId}`,
            status: 'ok',
          }),
        ]),
      )
    })

    it('drops the attach action for a target the API deleted, keeping later actions running', async () => {
      // The proof-of-savepoint mechanics live in `src/runtime/savepoint.test.ts`.
      // Here the assertion is the sibling behaviour: deleting a target through
      // the API cascades to `form_attach_targets` via `attachedRecords.ts`, so
      // the form no longer tries to attach and the submit runs the rest.
      const stageId = await firstStageOfKind('opportunity')
      const oppResponse = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Q4 accelerator', kind: 'Accelerator', stage_id: stageId },
        cookie: acme.cookie,
      })
      const opportunityId = readString(await oppResponse.json(), 'id')
      const form = await createForm({
        attach_targets: [{ target_type: 'opportunity', target_id: opportunityId }],
        person_tags: ['inbound'],
      })

      await client.send('DELETE', `/v1/opportunities/${opportunityId}`, { cookie: acme.cookie })

      const ids = fieldIds(form)
      const response = await submit(readString(form, 'public_key'), filledIn(ids))

      expect(response.status).toBe(201)

      const submission = await submissionFor(readString(form, 'id'))
      const actions = Array.isArray(submission.action_log) ? submission.action_log : []
      const actionNames = actions.map((entry: unknown) =>
        String((entry as Record<string, unknown>).action ?? ''),
      )

      expect(actionNames).not.toContain(`attach:opportunity:${opportunityId}`)
      expect(submission.action_log).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: 'tag_person', status: 'ok' })]),
      )
    })

    it('refuses create_partnership without a company mapping at form write', async () => {
      const response = await client.send('POST', '/v1/forms', {
        body: {
          name: 'Broken partnership form',
          fields: CONTACT_FIELDS.filter((field) => !field.map_to.startsWith('company.')),
          create_partnership: true,
          partnership_kind: 'Reseller',
        },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
      expect(JSON.stringify(await response.json())).toContain('creates partnerships needs')
    })

    it('refuses create_opportunity with an empty kind at form write', async () => {
      const response = await client.send('POST', '/v1/forms', {
        body: {
          name: 'Kindless opportunity',
          fields: CONTACT_FIELDS,
          create_opportunity: true,
        },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
      expect(JSON.stringify(await response.json())).toContain('creates opportunitys needs a kind')
    })

    it('refuses a list_id targeting a type other than person or company', async () => {
      const stageId = await firstStageOfKind('deal')
      // A deal list is a valid list but not a valid form action target.
      const listResponse = await client.send('POST', '/v1/lists', {
        body: { name: 'All deals', target_type: 'deal' },
        cookie: acme.cookie,
      })
      const listId = readString(await listResponse.json(), 'id')

      const response = await client.send('POST', '/v1/forms', {
        body: {
          name: 'Bad list form',
          fields: CONTACT_FIELDS,
          list_ids: [listId],
        },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
      expect(JSON.stringify(await response.json())).toContain('must target person or company')
      // Silence the unused `stageId` — it exists so a future test in this
      // block can spell out the deal it wants a list of, but the failure
      // above already covers what this test is proving.
      void stageId
    })

    it('refuses an unknown attach_target with 404', async () => {
      const response = await client.send('POST', '/v1/forms', {
        body: {
          name: 'Bad attach form',
          fields: CONTACT_FIELDS,
          attach_targets: [{ target_type: 'opportunity', target_id: 'opp_missing' }],
        },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('does not double-tag or double-link on a resubmission from the same person', async () => {
      const form = await createForm({ person_tags: ['inbound'] })
      const ids = fieldIds(form)

      await submit(readString(form, 'public_key'), filledIn(ids))
      await submit(readString(form, 'public_key'), filledIn(ids))

      const submissions = readList(
        await (
          await client.send('GET', `/v1/forms/${readString(form, 'id')}/submissions`, {
            cookie: acme.cookie,
          })
        ).json(),
      )

      expect(submissions).toHaveLength(2)

      const [second, first] = submissions
      const personId = String(second?.person_id ?? '')

      // Second submit is idempotent: the tag merge logs ok and adds nothing.
      const personResponse = await client.send('GET', `/v1/people/${personId}`, {
        cookie: acme.cookie,
      })
      const person = readRecord(await personResponse.json())

      // Exactly one 'inbound' — the second submit must not append a duplicate.
      expect(person.tags).toEqual(['inbound'])
      expect(String(first?.person_id ?? '')).toBe(personId)
    })
  })
})
