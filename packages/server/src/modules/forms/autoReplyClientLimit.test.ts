import { formSchema } from '@kelpie/schemas'
import type { Form } from '@kelpie/schemas'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { EmailMessage, EmailSender } from '../../lib/email.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_APP_BASE_URL, TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { rateLimitBuckets } from '../rate-limit/schema.ts'
import { SEND_FORM_EMAILS_JOB, sendFormEmails, sendFormEmailsDataSchema } from './emailJob.ts'
import type { SendFormEmailsData } from './emailJob.ts'
import { formEmailSends, formSubmissions } from './schema.ts'

/**
 * The daily limit on auto-replies one client address can cause, end to end:
 * the public submit counts, and the email job sends or skips.
 *
 * The suite has its own clock, because the limit is for a UTC day, and its own
 * client addresses, sent as `X-Forwarded-For` the way the test app reads them.
 */

const connectionString = testDatabaseUrl(process.env)
const START = new Date('2026-10-02T09:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
/** The default of `FORMS_AUTO_REPLY_CLIENT_DAILY_LIMIT`. */
const LIMIT = 5
const LIMIT_DETAIL = 'Daily auto-reply limit for one client address reached'

const FIELDS = [
  { label: 'Name', type: 'text', map_to: 'person.name', required: true },
  { label: 'Email', type: 'email', map_to: 'person.email', required: true },
]

describe.skipIf(connectionString === undefined)('the auto-reply limit for one client address', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let current: number
  let form: Form
  let visitor: number

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
    // A submit enqueues on its own transaction, which needs an open boss
    // instance. No worker starts: the handler is run directly below.
    await database.jobs.start()
  })

  afterAll(async () => {
    await database.close()
  })

  beforeEach(async () => {
    await database.truncateAll()
    current = START.getTime()
    visitor = 0
    harness = await createTestApp({
      modules: coreModules,
      // The spam check's minimum time is off: a submit only has to carry a token.
      environment: { ...TEST_ENVIRONMENT, FORMS_SPAM_MIN_SECONDS: '0' },
      services: createTestServices({
        db: database.db,
        enqueueOnTx: database.jobs.enqueueOnTx,
        now: () => new Date(current),
      }),
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()

    const created = await client.send('POST', '/v1/forms', {
      body: { name: 'Website contact', fields: FIELDS, auto_reply: true, require_spam_check: true },
      cookie: acme.cookie,
    })

    expect(created.status).toBe(201)
    form = formSchema.parse(await created.json())
  })

  function publicPath(suffix: string): string {
    return `/v1/public/workspaces/${acme.workspaceId}/forms/${suffix}`
  }

  /** A request as the client at `address` sends it. */
  function requestFrom(address: string, path: string, body?: unknown): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }

  /**
   * One submit from `address`, by a visitor with an address of their own.
   *
   * @param withToken False for a submit the spam check holds.
   * @returns The submit's response body, which is the same shape either way.
   */
  async function submitFrom(address: string, withToken = true): Promise<Record<string, unknown>> {
    visitor += 1

    const token = withToken
      ? readString(await (await requestFrom(address, publicPath(`${form.id}/token`))).json(), 'token')
      : undefined
    const answers = Object.fromEntries(
      form.fields.map((field) => [
        field.id,
        field.label === 'Email' ? `visitor${String(visitor)}@example.com` : 'A Visitor',
      ]),
    )
    const response = await requestFrom(address, publicPath(`${form.slug}/submit`), { answers, token })

    expect(response.status).toBe(201)
    expect(response.headers.get('Retry-After')).toBeNull()

    return readRecord(await response.json())
  }

  /** The payloads of every email job the queue holds, oldest first. */
  async function queuedJobs(): Promise<SendFormEmailsData[]> {
    const rows = await database.db.execute<{ data: unknown }>(
      sql`select data from pgboss.job where name = ${SEND_FORM_EMAILS_JOB} order by created_on`,
    )

    return [...rows].map((row) => sendFormEmailsDataSchema.parse(row.data))
  }

  /** Runs every queued job once and hands back what was sent. */
  async function sendQueued(): Promise<EmailMessage[]> {
    const sent: EmailMessage[] = []
    const sender: EmailSender = {
      send(message) {
        sent.push(message)

        return Promise.resolve()
      },
    }

    for (const data of await queuedJobs()) {
      await sendFormEmails(
        {
          db: database.db,
          email: sender,
          createId: harness.services.createId,
          now: () => new Date(current),
          appBaseUrl: TEST_APP_BASE_URL,
          entitlements: harness.contributions.entitlements,
          autoReplyDailyLimit: 500,
          externalNotificationDailyLimit: 500,
        },
        data,
      )
    }

    return sent
  }

  /** How many submits of the queue the limit stopped. */
  async function stoppedCount(): Promise<number> {
    return (await queuedJobs()).filter((job) => job.autoReplyOverClientLimit === true).length
  }

  it('sends no auto-reply for the sixth submit of a day, and still accepts it', async () => {
    const answers: Record<string, unknown>[] = []

    for (let index = 0; index < LIMIT + 1; index += 1) {
      answers.push(await submitFrom('198.51.100.7'))
    }

    // The visitor is told nothing: every response has the same fields.
    expect(answers.map((body) => Object.keys(body).sort())).toEqual(
      answers.map(() => ['form_id', 'id', 'submitted_at', 'thank_you_message']),
    )

    const sent = await sendQueued()

    expect(sent.map((message) => message.to)).toEqual(
      Array.from({ length: LIMIT }, (_unused, index) => `visitor${String(index + 1)}@example.com`),
    )

    // The sixth is a submission like the others, with its person.
    const sixthId = readString(answers[LIMIT], 'id')
    const [sixth] = await database.db
      .select()
      .from(formSubmissions)
      .where(eq(formSubmissions.id, sixthId))

    expect(sixth).toMatchObject({ status: 'accepted' })
    expect(sixth?.personId).not.toBeNull()
    expect(sixth?.actionLog).toContainEqual({
      action: 'email_auto_reply',
      status: 'skipped',
      detail: LIMIT_DETAIL,
    })

    const [send] = await database.db
      .select()
      .from(formEmailSends)
      .where(eq(formEmailSends.submissionId, sixthId))

    expect(send).toMatchObject({ kind: 'auto_reply', status: 'skipped', detail: LIMIT_DETAIL })
  })

  it('still sends one for another client address', async () => {
    for (let index = 0; index < LIMIT + 1; index += 1) {
      await submitFrom('198.51.100.7')
    }

    await submitFrom('198.51.100.8')

    const jobs = await queuedJobs()

    expect(jobs).toHaveLength(LIMIT + 2)
    expect(jobs.at(-1)?.autoReplyOverClientLimit).toBeUndefined()
    expect(await stoppedCount()).toBe(1)
  })

  it('does not take the stopped ones from what the workspace may send in a day', async () => {
    for (let index = 0; index < LIMIT + 3; index += 1) {
      await submitFrom('198.51.100.7')
    }

    await sendQueued()

    // The workspace limit counts `sent` rows, and a stopped auto-reply is `skipped`.
    const sent = await database.db
      .select()
      .from(formEmailSends)
      .where(and(eq(formEmailSends.kind, 'auto_reply'), eq(formEmailSends.status, 'sent')))

    expect(sent).toHaveLength(LIMIT)
  })

  it('does not count a submit the spam check held', async () => {
    for (let index = 0; index < LIMIT + 1; index += 1) {
      await submitFrom('198.51.100.7', false)
    }

    // Held submits enqueue nothing and count nothing.
    expect(await queuedJobs()).toEqual([])
    expect(await database.db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.scope, 'forms-auto-reply-client'))).toEqual([])

    await submitFrom('198.51.100.7')

    expect(await stoppedCount()).toBe(0)
    expect(await queuedJobs()).toHaveLength(1)
  })

  it('counts an IPv6 client by its /64', async () => {
    for (let index = 0; index < LIMIT + 1; index += 1) {
      await submitFrom(`2001:db8:1:2::${String(index + 1)}`)
    }

    expect(await stoppedCount()).toBe(1)
  })

  it('starts again with the next UTC day, and keeps one day of counts', async () => {
    for (let index = 0; index < LIMIT + 1; index += 1) {
      await submitFrom('198.51.100.7')
    }

    expect(await stoppedCount()).toBe(1)

    current += DAY_MS
    await submitFrom('198.51.100.7')

    expect(await stoppedCount()).toBe(1)
    expect((await queuedJobs()).at(-1)?.autoReplyOverClientLimit).toBeUndefined()

    // Yesterday's count is gone. Nothing keeps a client's key past its day.
    const buckets = await database.db
      .select()
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.scope, 'forms-auto-reply-client'))

    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ count: 1, windowStart: new Date(START.getTime() + DAY_MS - 9 * 60 * 60 * 1000) })
  })

  it('keeps the count while the request limiter sweeps its own short windows', async () => {
    for (let index = 0; index < LIMIT; index += 1) {
      await submitFrom('198.51.100.7')
    }

    // An hour on, every request budget has opened a new window and swept the old ones.
    current += 60 * 60 * 1000
    await submitFrom('198.51.100.7')

    expect(await stoppedCount()).toBe(1)
  })
})
