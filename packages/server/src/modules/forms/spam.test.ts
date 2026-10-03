import { formSubmissionSchema } from '@kelpie/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { CaptchaProvider } from '../../lib/captcha.ts'
import { createLogger } from '../../lib/logger.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT, TEST_SECRET_ENCRYPTION_KEY } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { people } from '../people/schema.ts'
import { formSubmissions } from './schema.ts'
import { SPAM_TOKEN_MAX_AGE_MS, createSpamCheck, createSpamTokens } from './spam.ts'

/**
 * The spam check on a public submit: the token, the honeypot, the CAPTCHA
 * port, the quarantine, and the release.
 *
 * The clock is the test's own, because two of the rules are about how long a
 * visitor took.
 */

const SECRETS = { SECRET_ENCRYPTION_KEY: TEST_SECRET_ENCRYPTION_KEY }
const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA='
const START = new Date('2026-10-02T09:00:00.000Z')

function clock(): { now: () => Date; advance: (ms: number) => void } {
  let current = START.getTime()

  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms
    },
  }
}

describe('spam tokens', () => {
  it('reads back when a token was issued, for the form it was issued for', () => {
    const tokens = createSpamTokens(SECRETS, () => START)
    const token = tokens.issue('form_1')

    expect(tokens.readIssuedAt('form_1', token)).toEqual(START)
    expect(tokens.readIssuedAt('form_2', token)).toBeUndefined()
  })

  it('refuses a token it did not sign', () => {
    const tokens = createSpamTokens(SECRETS, () => START)
    const forged = createSpamTokens({ SECRET_ENCRYPTION_KEY: OTHER_KEY }, () => START).issue('form_1')

    expect(tokens.readIssuedAt('form_1', forged)).toBeUndefined()
    expect(tokens.readIssuedAt('form_1', 'not-a-token')).toBeUndefined()
    expect(tokens.readIssuedAt('form_1', '')).toBeUndefined()
  })

  it('refuses a token whose time was changed', () => {
    const tokens = createSpamTokens(SECRETS, () => START)
    const [version, , signature] = tokens.issue('form_1').split('.')
    const earlier = (START.getTime() - 60_000).toString(36)

    expect(tokens.readIssuedAt('form_1', `${version ?? ''}.${earlier}.${signature ?? ''}`)).toBeUndefined()
  })

  it('accepts a token signed under the previous key, so a rotation holds nothing', () => {
    const before = createSpamTokens({ SECRET_ENCRYPTION_KEY: OTHER_KEY }, () => START)
    const after = createSpamTokens(
      { SECRET_ENCRYPTION_KEY: TEST_SECRET_ENCRYPTION_KEY, SECRET_ENCRYPTION_KEY_PREVIOUS: OTHER_KEY },
      () => START,
    )

    expect(after.readIssuedAt('form_1', before.issue('form_1'))).toEqual(START)
  })
})

describe('spam check', () => {
  const log = createLogger({ level: 'error', transports: [] })
  const on = { id: 'form_1', requireSpamCheck: true }

  function build(provider?: CaptchaProvider): {
    check: ReturnType<typeof createSpamCheck>['check']
    token: () => string
    advance: (ms: number) => void
  } {
    const time = clock()
    const tokens = createSpamTokens(SECRETS, time.now)
    const spamCheck = createSpamCheck({
      tokens,
      captcha: { current: () => provider },
      now: time.now,
      minimumSeconds: 2,
      log,
    })

    return { check: spamCheck.check, token: () => tokens.issue('form_1'), advance: time.advance }
  }

  it('checks nothing on a form that does not require it', async () => {
    const { check } = build()

    expect(await check({ id: 'form_1', requireSpamCheck: false }, { trap: 'filled' })).toBeNull()
  })

  it('passes a submit that took a person-sized time', async () => {
    const { check, token, advance } = build()
    const issued = token()

    advance(5000)

    expect(await check(on, { token: issued })).toBeNull()
  })

  it('names each way a submit fails', async () => {
    const { check, token, advance } = build()
    const issued = token()

    expect(await check(on, {})).toBe('token_missing')
    expect(await check(on, { token: 'v1.abc.def' })).toBe('token_invalid')
    expect(await check(on, { token: issued })).toBe('too_fast')

    advance(5000)
    expect(await check(on, { token: issued, trap: 'https://spam.example' })).toBe('honeypot')

    advance(SPAM_TOKEN_MAX_AGE_MS)
    expect(await check(on, { token: issued })).toBe('token_expired')
  })

  it('asks the CAPTCHA provider, when there is one', async () => {
    const asked: string[] = []
    const provider: CaptchaProvider = {
      widget: {
        scriptUrl: 'https://captcha.test/api.js',
        globalName: 'testcaptcha',
        siteKey: 'site-key',
        contentSecurityPolicy: { scriptSrc: [], frameSrc: [], connectSrc: [] },
      },
      verify(response) {
        asked.push(response)

        if (response === 'down') {
          return Promise.reject(new Error('vendor unreachable'))
        }

        return Promise.resolve(response === 'solved')
      },
    }
    const { check, token, advance } = build(provider)
    const issued = token()

    advance(5000)

    expect(await check(on, { token: issued })).toBe('captcha_missing')
    expect(await check(on, { token: issued, captchaResponse: 'wrong' })).toBe('captcha_failed')
    expect(await check(on, { token: issued, captchaResponse: 'solved' })).toBeNull()
    // An outage is not the visitor's fault: the token already passed.
    expect(await check(on, { token: issued, captchaResponse: 'down' })).toBeNull()
    // A submit the token condemns never reaches the vendor.
    expect(await check(on, { token: 'v1.abc.def', captchaResponse: 'solved' })).toBe('token_invalid')
    expect(asked).toEqual(['wrong', 'solved', 'down'])
  })
})

const connectionString = testDatabaseUrl(process.env)

const CONTACT_FIELDS = [
  { label: 'Name', type: 'text', map_to: 'person.name', required: true },
  { label: 'Email', type: 'email', map_to: 'person.email', required: true },
  { label: 'Company', type: 'text', map_to: 'company.name' },
]

const TEST_CAPTCHA: CaptchaProvider = {
  widget: {
    scriptUrl: 'https://captcha.test/api.js?render=explicit',
    globalName: 'testcaptcha',
    siteKey: 'site-key-123',
    contentSecurityPolicy: {
      scriptSrc: ['https://captcha.test'],
      frameSrc: ['https://captcha.test'],
      connectSrc: ['https://captcha.test'],
    },
  },
  verify: (response) => Promise.resolve(response === 'solved'),
}

const captchaModule: KelpieModule = {
  id: 'test-captcha',
  register(context) {
    context.provideCaptcha('test', () => TEST_CAPTCHA)

    return Promise.resolve()
  },
}

describe.skipIf(connectionString === undefined)('forms spam check', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let time: ReturnType<typeof clock>

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
  })

  afterAll(async () => {
    await database.close()
  })

  async function boot(options: { readonly captcha?: boolean } = {}): Promise<void> {
    await database.truncateAll()
    time = clock()
    harness = await createTestApp({
      modules: options.captcha === true ? [...coreModules, captchaModule] : coreModules,
      environment:
        options.captcha === true ? { ...TEST_ENVIRONMENT, CAPTCHA_PROVIDER: 'test' } : TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db, now: time.now }),
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()
  }

  beforeEach(async () => {
    await boot()
  })

  async function createForm(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/forms', {
      body: { name: 'Website contact', fields: CONTACT_FIELDS, require_spam_check: true, ...body },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  function publicBase(form: Record<string, unknown>): string {
    return `/v1/public/workspaces/${acme.workspaceId}/forms/${readString(form, 'id')}`
  }

  function answersFor(form: Record<string, unknown>, email = 'alex@example.com'): Record<string, string> {
    const fields = Array.isArray(form.fields) ? form.fields : []
    const [name, address] = fields.map((field) => readString(field, 'id'))

    return { [name ?? '']: 'Alex Rivera', [address ?? '']: email }
  }

  async function fetchToken(form: Record<string, unknown>): Promise<string> {
    const response = await client.send('GET', `${publicBase(form)}/token`)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')

    return readString(readRecord(await response.json()), 'token')
  }

  function submit(form: Record<string, unknown>, body: Record<string, unknown>): Promise<Response> {
    return client.send(
      'POST',
      `/v1/public/workspaces/${acme.workspaceId}/forms/${readString(form, 'slug')}/submit`,
      { body },
    )
  }

  async function listSubmissions(
    form: Record<string, unknown>,
    query = '',
  ): Promise<readonly Record<string, unknown>[]> {
    const response = await client.send('GET', `/v1/forms/${readString(form, 'id')}/submissions${query}`, {
      cookie: acme.cookie,
    })

    expect(response.status).toBe(200)

    return readList(await response.json())
  }

  it('is off for a form made over the API unless asked for, and on when asked', async () => {
    const response = await client.send('POST', '/v1/forms', {
      body: { name: 'JSON form', fields: CONTACT_FIELDS },
      cookie: acme.cookie,
    })

    expect(readRecord(await response.json()).require_spam_check).toBe(false)
    expect((await createForm()).require_spam_check).toBe(true)
  })

  it('accepts a submit that carries a token and took a person-sized time', async () => {
    const form = await createForm()
    const token = await fetchToken(form)

    time.advance(5000)

    const response = await submit(form, { answers: answersFor(form), token })

    expect(response.status).toBe(201)

    const [submission] = await listSubmissions(form)

    expect(formSubmissionSchema.parse(submission)).toMatchObject({ status: 'accepted', spamReason: null })
    expect(submission?.person_id).not.toBeNull()
  })

  it('holds a submit with no token: same 201, no person, and its own list', async () => {
    const form = await createForm()
    const response = await submit(form, { answers: answersFor(form) })
    const body = readRecord(await response.json())

    expect(response.status).toBe(201)
    // Nothing on the public response says the submit was held.
    expect(Object.keys(body).sort()).toEqual(['form_id', 'id', 'submitted_at', 'thank_you_message'])

    expect(await harness.services.db.select().from(people)).toHaveLength(0)
    expect(await listSubmissions(form)).toHaveLength(0)

    const [held] = await listSubmissions(form, '?status=spam')

    expect(held).toMatchObject({
      id: body.id,
      status: 'spam',
      spam_reason: 'token_missing',
      person_id: null,
      action_log: [],
    })
    expect(held?.answers).toEqual(answersFor(form))
  })

  it('holds a submit that is too quick, and one with the honeypot filled', async () => {
    const form = await createForm()
    const token = await fetchToken(form)

    await submit(form, { answers: answersFor(form, 'quick@example.com'), token })
    time.advance(5000)
    await submit(form, { answers: answersFor(form, 'bot@example.com'), token, trap: 'https://spam.example' })

    const reasons = (await listSubmissions(form, '?status=spam')).map((row) => row.spam_reason)

    expect(reasons.sort()).toEqual(['honeypot', 'too_fast'])
  })

  it('still answers 422 for unusable answers, whatever the check would say', async () => {
    const form = await createForm()
    const response = await submit(form, { answers: {} })

    expect(response.status).toBe(422)
    expect(await listSubmissions(form, '?status=spam')).toHaveLength(0)
  })

  it('still answers 409 for answers from a stale page, whatever the check would say', async () => {
    const form = await createForm()
    const response = await submit(form, { answers: { unknown_field: 'x' } })

    expect(response.status).toBe(409)
    expect(await listSubmissions(form, '?status=spam')).toHaveLength(0)
  })

  it('refuses an unknown submission status filter', async () => {
    const form = await createForm()
    const response = await client.send(
      'GET',
      `/v1/forms/${readString(form, 'id')}/submissions?status=junk`,
      { cookie: acme.cookie },
    )

    expect(response.status).toBe(422)
  })

  it('releases a held submission: the submit rules run on the stored answers', async () => {
    const form = await createForm()
    const submitted = readRecord(await (await submit(form, { answers: answersFor(form) })).json())
    const path = `/v1/forms/${readString(form, 'id')}/submissions/${readString(submitted, 'id')}/release`

    const response = await client.send('POST', path, { cookie: acme.cookie })
    const released = readRecord(await response.json())

    expect(response.status).toBe(200)
    expect(released).toMatchObject({
      id: submitted.id,
      status: 'accepted',
      // Kept, as the record of why the row was once held.
      spam_reason: 'token_missing',
      submitted_at: submitted.submitted_at,
    })
    expect(released.person_id).not.toBeNull()

    const stored = await harness.services.db.select().from(people)

    expect(stored.map((person) => person.email)).toEqual(['alex@example.com'])
    expect(await listSubmissions(form)).toHaveLength(1)
    expect(await listSubmissions(form, '?status=spam')).toHaveLength(0)

    // A second release finds nothing held, and writes nothing twice.
    expect((await client.send('POST', path, { cookie: acme.cookie })).status).toBe(409)
    expect(await harness.services.db.select().from(formSubmissions)).toHaveLength(1)
  })

  it('refuses a release from another workspace, and one with no credentials', async () => {
    const form = await createForm()
    const submitted = readRecord(await (await submit(form, { answers: answersFor(form) })).json())
    const path = `/v1/forms/${readString(form, 'id')}/submissions/${readString(submitted, 'id')}/release`
    const other = await client.owner('other@example.com')

    expect((await client.send('POST', path, { cookie: other.cookie })).status).toBe(404)
    expect((await client.send('POST', path)).status).toBe(401)
    expect(await harness.services.db.select().from(people)).toHaveLength(0)
  })

  /**
   * A field list change gives every field a new id, so a submission held
   * before it names fields the form no longer has. The member releasing it
   * gets a message about the submission, not the visitor's "reload the page".
   */
  it('refuses a release whose answers name fields the form no longer has, and keeps it held', async () => {
    const form = await createForm()
    const answers = answersFor(form)
    const submitted = readRecord(await (await submit(form, { answers })).json())
    const path = `/v1/forms/${readString(form, 'id')}/submissions/${readString(submitted, 'id')}/release`
    const changed = await client.send('PATCH', `/v1/forms/${readString(form, 'id')}`, {
      body: {
        fields: [
          { label: 'Work email', type: 'email', map_to: 'person.email', required: true },
          { label: 'Message', type: 'textarea', map_to: 'submission' },
        ],
      },
      cookie: acme.cookie,
    })

    expect(changed.status).toBe(200)

    const response = await client.send('POST', path, { cookie: acme.cookie })
    const error = readRecord(readRecord(await response.json()).error)
    // The stored answers are jsonb, which does not keep key order.
    const details = (Array.isArray(error.details) ? error.details : [])
      .map((detail) => readRecord(detail))
      .sort((a, b) => readString(a, 'field').localeCompare(readString(b, 'field')))

    expect(response.status).toBe(409)
    expect(error.code).toBe('conflict')
    expect(error.message).toBe('This submission has answers for fields the form no longer has')
    expect(details).toEqual(
      Object.keys(answers)
        .sort()
        .map((id) => ({ field: `answers.${id}`, message: 'This form no longer has this field' })),
    )

    expect(await harness.services.db.select().from(people)).toHaveLength(0)
    expect(await listSubmissions(form)).toHaveLength(0)
    expect(await listSubmissions(form, '?status=spam')).toMatchObject([
      { id: submitted.id, status: 'spam', person_id: null },
    ])
  })

  /** An edited field keeps its id, so the stored answers still name fields the form has. */
  it('releases a held submission after its fields were edited', async () => {
    const form = await createForm()
    const submitted = readRecord(await (await submit(form, { answers: answersFor(form) })).json())
    const fields = (Array.isArray(form.fields) ? form.fields : []).map((field) => readRecord(field))
    const changed = await client.send('PATCH', `/v1/forms/${readString(form, 'id')}`, {
      body: {
        fields: [
          ...fields.map((field) => ({
            id: field.id,
            label: `Your ${readString(field, 'label').toLowerCase()}`,
            type: field.type,
            required: field.required,
            map_to: field.map_to,
          })),
          { label: 'Message', type: 'textarea', map_to: 'submission' },
        ],
      },
      cookie: acme.cookie,
    })

    expect(changed.status).toBe(200)

    const response = await client.send(
      'POST',
      `/v1/forms/${readString(form, 'id')}/submissions/${readString(submitted, 'id')}/release`,
      { cookie: acme.cookie },
    )

    expect(response.status).toBe(200)
    expect(await listSubmissions(form)).toMatchObject([{ id: submitted.id, status: 'accepted' }])
  })

  it('deletes held submissions older than the retention when the next one arrives', async () => {
    const form = await createForm()

    await submit(form, { answers: answersFor(form, 'old@example.com') })
    time.advance(31 * 24 * 60 * 60 * 1000)
    await submit(form, { answers: answersFor(form, 'new@example.com') })

    const rows = await harness.services.db
      .select()
      .from(formSubmissions)
      .where(eq(formSubmissions.formId, readString(form, 'id')))

    expect(rows).toHaveLength(1)
    expect(Object.values(rows[0]?.answers ?? {})).toContain('new@example.com')
  })

  it('puts the honeypot and the token URL in the embed only when the form requires the check', async () => {
    const on = await createForm()
    const off = await createForm({ name: 'No check', require_spam_check: false })
    const pageOn = await (await client.send('GET', `${publicBase(on)}/embed`)).text()
    const pageOff = await (await client.send('GET', `${publicBase(off)}/embed`)).text()

    expect(pageOn).toContain('id="kelpie-trap"')
    expect(pageOn).toContain(`/forms/${readString(on, 'id')}/token`)
    expect(pageOff).not.toContain('id="kelpie-trap"')
    expect(pageOff).not.toContain('"tokenUrl"')
  })

  it('answers 404 for a token of an unknown form', async () => {
    const response = await client.send(
      'GET',
      `/v1/public/workspaces/${acme.workspaceId}/forms/form_missing/token`,
    )

    expect(response.status).toBe(404)
  })

  describe('with a CAPTCHA provider', () => {
    beforeEach(async () => {
      await boot({ captcha: true })
    })

    it('draws the widget and widens the policy by the provider origins only', async () => {
      const form = await createForm()
      const response = await client.send('GET', `${publicBase(form)}/embed`)
      const page = await response.text()
      const policy = response.headers.get('Content-Security-Policy') ?? ''

      expect(page).toContain('id="kelpie-captcha"')
      expect(page).toContain('site-key-123')
      expect(policy).toContain("default-src 'none'")
      expect(policy).toMatch(/script-src 'nonce-[^']+' https:\/\/captcha\.test;/u)
      expect(policy).toContain('frame-src https://captcha.test')
      expect(policy).toContain("connect-src 'self' https://captcha.test")
    })

    it('leaves the widget off a form that does not require the check', async () => {
      const form = await createForm({ require_spam_check: false })
      const response = await client.send('GET', `${publicBase(form)}/embed`)

      expect(await response.text()).not.toContain('id="kelpie-captcha"')
      expect(response.headers.get('Content-Security-Policy')).not.toContain('captcha.test')
    })

    it('holds a submit without a solved CAPTCHA and accepts one with it', async () => {
      const form = await createForm()
      const token = await fetchToken(form)

      time.advance(5000)
      await submit(form, { answers: answersFor(form, 'none@example.com'), token })
      await submit(form, { answers: answersFor(form, 'wrong@example.com'), token, captcha_response: 'no' })
      await submit(form, { answers: answersFor(form, 'right@example.com'), token, captcha_response: 'solved' })

      const reasons = (await listSubmissions(form, '?status=spam')).map((row) => row.spam_reason)

      expect(reasons.sort()).toEqual(['captcha_failed', 'captcha_missing'])
      expect(await listSubmissions(form)).toHaveLength(1)
    })
  })

  it('fails boot when CAPTCHA_PROVIDER names a provider no module registered', async () => {
    await expect(
      createTestApp({
        modules: coreModules,
        environment: { ...TEST_ENVIRONMENT, CAPTCHA_PROVIDER: 'turnstile' },
        services: createTestServices({ db: database.db }),
      }),
    ).rejects.toThrow(/CAPTCHA_PROVIDER is "turnstile", which no module registered/u)
  })
})
