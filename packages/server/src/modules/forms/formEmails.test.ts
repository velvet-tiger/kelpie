import { formSchema, formSubmissionSchema } from '@kelpie/schemas'
import type { Form, FormSubmission } from '@kelpie/schemas'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PermanentEmailError } from '../../lib/email.ts'
import type { EmailMessage, EmailSender } from '../../lib/email.ts'
import { createLogger } from '../../lib/logger.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_APP_BASE_URL, TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { SEND_FORM_EMAILS_JOB, sendFormEmails, sendFormEmailsDataSchema } from './emailJob.ts'
import type { FormEmailDependencies, SendFormEmailsData } from './emailJob.ts'
import { formEmailSends, formSubmissions } from './schema.ts'

/**
 * Form emails end to end: the settings on `/v1/forms`, the job a submit
 * enqueues, and what the job sends.
 *
 * The job's handler is run directly rather than by a worker polling the
 * queue, so a case never waits on a poll interval. That the submit really
 * enqueued it is asserted separately, against `pgboss.job`.
 */

const connectionString = testDatabaseUrl(process.env)
const silentLogger = createLogger({ level: 'error', transports: [] })

const CONTACT_FIELDS = [
  { label: 'Name', type: 'text', map_to: 'person.name', required: true },
  { label: 'Email', type: 'email', map_to: 'person.email', required: true },
  { label: 'Company', type: 'text', map_to: 'company.name' },
  { label: 'Message', type: 'textarea', map_to: 'submission' },
  {
    label: 'Topic',
    type: 'select',
    map_to: 'submission',
    options: [{ key: 'demo', value: 'Book a demo' }],
  },
]

/** The message of a thrown error and of each error in its `cause` chain. */
function messagesOf(thrown: unknown): string {
  const messages: string[] = []

  for (let error = thrown; error instanceof Error; error = error.cause) {
    messages.push(error.message)
  }

  return messages.join('\n')
}

/**
 * A sender that records what it was asked to send and refuses the addresses
 * in `failing`. An address in `refusing` is refused permanently. `tried` is
 * every address the sender was called for, sent or not.
 */
function controlledSender(
  failing: ReadonlySet<string>,
  refusing: ReadonlySet<string> = new Set(),
): { sender: EmailSender; sent: EmailMessage[]; tried: string[] } {
  const sent: EmailMessage[] = []
  const tried: string[] = []

  return {
    sent,
    tried,
    sender: {
      send(message) {
        tried.push(message.to)

        if (refusing.has(message.to)) {
          return Promise.reject(new PermanentEmailError(`550 no mailbox ${message.to}`))
        }

        if (failing.has(message.to)) {
          return Promise.reject(new Error(`mailbox ${message.to} refused the message`))
        }

        sent.push(message)

        return Promise.resolve()
      },
    },
  }
}

describe.skipIf(connectionString === undefined)('form emails', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let ownerMemberId: string

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
    // A submit enqueues on its own transaction, which needs an open boss
    // instance. No worker starts: handlers run directly below.
    await database.jobs.start()
  })

  afterAll(async () => {
    await database.close()
  })

  beforeEach(async () => {
    await database.truncateAll()
    harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db, enqueueOnTx: database.jobs.enqueueOnTx }),
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()

    const members = await client.send('GET', `/v1/workspaces/${acme.workspaceId}/members`, {
      cookie: acme.cookie,
    })
    ownerMemberId = readString(readList(await members.json())[0], 'id')
  })

  async function createForm(body: Record<string, unknown>): Promise<Form> {
    const response = await client.send('POST', '/v1/forms', {
      body: { name: 'Website contact', fields: CONTACT_FIELDS, ...body },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(201)

    return formSchema.parse(await response.json())
  }

  async function refusal(
    method: 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
  ): Promise<readonly { field: string; message: string }[]> {
    const response = await client.send(method, path, { body, cookie: acme.cookie })

    expect(response.status).toBe(422)

    const error = readRecord(readRecord(await response.json()).error)

    return (Array.isArray(error.details) ? error.details : []) as { field: string; message: string }[]
  }

  function fieldId(form: Form, label: string): string {
    const field = form.fields.find((candidate) => candidate.label === label)

    if (field === undefined) {
      throw new Error(`no field ${label}`)
    }

    return field.id
  }

  async function submit(form: Form, answers: Record<string, string>): Promise<string> {
    const response = await client.send(
      'POST',
      `/v1/public/workspaces/${acme.workspaceId}/forms/${form.slug}/submit`,
      { body: { answers } },
    )

    expect(response.status).toBe(201)

    return readString(await response.json(), 'id')
  }

  function contactAnswers(form: Form, email = 'Alex@Example.com'): Record<string, string> {
    return {
      [fieldId(form, 'Name')]: 'Alex Rivera',
      [fieldId(form, 'Email')]: email,
      [fieldId(form, 'Company')]: 'Example Co',
      [fieldId(form, 'Message')]: 'Hello <script>alert(1)</script>',
      [fieldId(form, 'Topic')]: 'demo',
    }
  }

  /** The payloads of every email job the queue holds, oldest first. */
  async function queuedJobs(): Promise<SendFormEmailsData[]> {
    const rows = await database.db.execute<{ data: unknown }>(
      sql`select data from pgboss.job where name = ${SEND_FORM_EMAILS_JOB} order by created_on`,
    )

    return [...rows].map((row) => sendFormEmailsDataSchema.parse(row.data))
  }

  /** Runs the handler the forms module registered, as a worker would. */
  async function runRegisteredJob(data: SendFormEmailsData): Promise<void> {
    const definition = harness.jobs?.definitions.get(SEND_FORM_EMAILS_JOB)

    if (definition === undefined) {
      throw new Error('the forms module registered no email job')
    }

    await definition.handler({
      id: 'job_test',
      data,
      log: silentLogger,
      signal: new AbortController().signal,
    })
  }

  async function readSubmission(form: Form, submissionId: string): Promise<FormSubmission> {
    const response = await client.send('GET', `/v1/forms/${form.id}/submissions/${submissionId}`, {
      cookie: acme.cookie,
    })

    return formSubmissionSchema.parse(await response.json())
  }

  function directDependencies(sender: EmailSender, overrides: Partial<FormEmailDependencies> = {}): FormEmailDependencies {
    return {
      db: database.db,
      email: sender,
      createId: harness.services.createId,
      now: () => new Date(),
      appBaseUrl: TEST_APP_BASE_URL,
      entitlements: harness.contributions.entitlements,
      autoReplyDailyLimit: 500,
      ...overrides,
    }
  }

  describe('settings', () => {
    it('stores both recipient kinds, lowercases an address, and reads them back in order', async () => {
      const form = await createForm({
        notify_email: true,
        notify_recipients: [
          { kind: 'address', address: '  Sales@Example.COM ' },
          { kind: 'member', member_id: ownerMemberId },
        ],
        auto_reply: true,
        auto_reply_reply_to: { kind: 'address', address: 'Hello@Example.com' },
      })

      expect(form.notifyRecipients).toEqual([
        { kind: 'address', address: 'sales@example.com' },
        { kind: 'member', memberId: ownerMemberId },
      ])
      expect(form.autoReplyReplyTo).toEqual({ kind: 'address', address: 'hello@example.com' })
      expect(form.notifySubject).toBe('New submission: {{form.name}}')
      expect(form.autoReplyBody.length).toBeGreaterThan(0)
    })

    it('refuses the notification on with no recipients, also when a PATCH only turns it on', async () => {
      expect(await refusal('POST', '/v1/forms', { name: 'x', fields: CONTACT_FIELDS, notify_email: true })).toEqual([
        { field: 'notify_recipients', message: 'Add at least one recipient' },
      ])

      const form = await createForm({})

      expect(await refusal('PATCH', `/v1/forms/${form.id}`, { notify_email: true })).toEqual([
        { field: 'notify_recipients', message: 'Add at least one recipient' },
      ])
    })

    it('refuses an address that is not an email address', async () => {
      const details = await refusal('POST', '/v1/forms', {
        name: 'x',
        fields: CONTACT_FIELDS,
        notify_recipients: [{ kind: 'address', address: 'not an address' }],
      })

      expect(details.map((detail) => detail.field)).toEqual(['notify_recipients.0.address'])
    })

    it("refuses another workspace's member as a recipient or as the Reply-To", async () => {
      const other = await client.owner('grace@example.com')
      const members = await client.send('GET', `/v1/workspaces/${other.workspaceId}/members`, {
        cookie: other.cookie,
      })
      const strangerId = readString(readList(await members.json())[0], 'id')

      expect(
        await refusal('POST', '/v1/forms', {
          name: 'x',
          fields: CONTACT_FIELDS,
          notify_recipients: [{ kind: 'member', member_id: strangerId }],
          auto_reply_reply_to: { kind: 'member', member_id: strangerId },
        }),
      ).toEqual([
        { field: 'notify_recipients.0', message: `No member ${strangerId} in this workspace` },
        { field: 'auto_reply_reply_to', message: `No member ${strangerId} in this workspace` },
      ])
    })

    it('refuses visitor text in the auto-reply and an unknown placeholder anywhere', async () => {
      expect(
        await refusal('POST', '/v1/forms', {
          name: 'x',
          fields: CONTACT_FIELDS,
          notify_body: '{{answers}} {{nonsense}}',
          auto_reply_body: 'Hi {{person.name}}',
        }),
      ).toEqual([
        { field: 'notify_body', message: '{{nonsense}} is not a placeholder' },
        {
          field: 'auto_reply_body',
          message: '{{person.name}} is text the visitor typed, which an auto-reply cannot include',
        },
      ])
    })

    it('refuses an empty template while its email is on', async () => {
      const form = await createForm({})

      expect(
        await refusal('PATCH', `/v1/forms/${form.id}`, { auto_reply: true, auto_reply_subject: '  ' }),
      ).toEqual([{ field: 'auto_reply_subject', message: 'Required while this email is on' }])
    })

    it('treats a resent identical recipient list as no write', async () => {
      const form = await createForm({ notify_recipients: [{ kind: 'address', address: 'a@example.com' }] })
      const response = await client.send('PATCH', `/v1/forms/${form.id}`, {
        body: { notify_recipients: [{ kind: 'address', address: 'a@example.com' }] },
        cookie: acme.cookie,
      })

      expect(formSchema.parse(await response.json()).updatedAt).toEqual(form.updatedAt)
    })
  })

  describe('submit', () => {
    it('enqueues one job naming the emails that are on', async () => {
      const form = await createForm({
        auto_reply: true,
      })
      const submissionId = await submit(form, contactAnswers(form))

      expect(await queuedJobs()).toEqual([
        { workspaceId: acme.workspaceId, submissionId, kinds: ['auto_reply'] },
      ])
    })

    it('enqueues nothing when both emails are off', async () => {
      const form = await createForm({})

      await submit(form, contactAnswers(form))

      expect(await queuedJobs()).toEqual([])
    })

    it('enqueues nothing when the submit is refused', async () => {
      const form = await createForm({ auto_reply: true })
      const response = await client.send(
        'POST',
        `/v1/public/workspaces/${acme.workspaceId}/forms/${form.slug}/submit`,
        { body: { answers: { [fieldId(form, 'Email')]: 'alex@example.com' } } },
      )

      expect(response.status).toBe(422)
      expect(await queuedJobs()).toEqual([])
    })

    /**
     * The submit route is public, so the embed script's own check proves
     * nothing. A mail library reads a list as several recipients: one
     * auto-reply, counted once against the limits, would go to all of them.
     */
    it.each([
      ['a list', 'alex@example.com, sam@example.com'],
      ['a semicolon list', 'alex@example.com;sam@example.com'],
      ['the display-name form', 'Alex <alex@example.com>'],
      ['markup', '<script>alert(1)</script>@example.com'],
      ['a line break', 'alex@example.com\nBcc: sam@example.com'],
    ])('refuses %s as the email answer, and stores and enqueues nothing', async (_label, email) => {
      const form = await createForm({ auto_reply: true })
      const response = await client.send(
        'POST',
        `/v1/public/workspaces/${acme.workspaceId}/forms/${form.slug}/submit`,
        { body: { answers: contactAnswers(form, email) } },
      )

      expect(response.status).toBe(422)
      expect(await database.db.select().from(formSubmissions)).toHaveLength(0)
      expect(await queuedJobs()).toEqual([])
    })
  })

  describe('the job', () => {
    it('sends the notification to each recipient once, filled, escaped, with the lead as Reply-To', async () => {
      const form = await createForm({
        notify_email: true,
        notify_recipients: [
          { kind: 'member', member_id: ownerMemberId },
          { kind: 'address', address: 'sales@example.com' },
          // The owner's own address a second time: one message, not two.
          { kind: 'address', address: 'ada@example.com' },
        ],
        notify_subject: 'Lead from {{company.name}}\nBcc: x@example.com',
        notify_body: '{{person.name}} <{{person.email}}> wrote:\n{{answers}}',
      })
      const submissionId = await submit(form, contactAnswers(form))
      const [job] = await queuedJobs()

      if (job === undefined) {
        throw new Error('no job queued')
      }

      // Sign-up already sent the owner a verification email.
      const before = harness.services.sentEmails.length

      await runRegisteredJob(job)

      const sent = harness.services.sentEmails.slice(before)

      expect(sent.map((message) => message.to)).toEqual(['ada@example.com', 'sales@example.com'])

      const message = sent[0]

      expect(message?.subject).toBe('Lead from Example Co Bcc: x@example.com')
      expect(message?.replyTo).toBe('alex@example.com')
      expect(message?.fromName).toBe('Acme via Kelpie')
      // Automatic mail, and not an answer: a member's out-of-office system
      // must not answer it, because the answer goes to the submitter.
      expect(message?.headers).toMatchObject({ 'Auto-Submitted': 'auto-generated' })
      expect(message?.body).toContain(
        'Alex Rivera <alex@example.com> wrote:\n' +
          'Name: Alex Rivera\nEmail: Alex@Example.com\nCompany: Example Co\n' +
          'Message: Hello <script>alert(1)</script>\nTopic: Book a demo',
      )
      expect(message?.body).toContain(`${TEST_APP_BASE_URL}/forms/${form.id}/submissions/${submissionId}`)
      expect(message?.html).not.toContain('<script>')
      expect(message?.html).toContain('Hello &lt;script&gt;alert(1)&lt;/script&gt;')
      // The notification goes to the people the form names, so the workspace
      // name in its header links to the deployment.
      expect(message?.html).toMatch(
        new RegExp(`<a class="email-masthead_name" href="${TEST_APP_BASE_URL}"[^>]*>\\s*Acme\\s*</a>`, 'u'),
      )

      const stored = await readSubmission(form, submissionId)

      expect(stored.actionLog.filter((entry) => entry.action.startsWith('email_'))).toEqual([
        { action: 'email_notification', status: 'ok', detail: 'Sent to 2 of 2 recipients' },
      ])
    })

    it('sends the auto-reply to the submitter with no answers in it, once per address per day', async () => {
      const form = await createForm({
        auto_reply: true,
        auto_reply_subject: 'Thanks from {{workspace.name}}',
        auto_reply_body: 'We received your {{form.name}} message.',
        auto_reply_reply_to: { kind: 'member', member_id: ownerMemberId },
      })
      const first = await submit(form, contactAnswers(form))
      const second = await submit(form, contactAnswers(form, 'alex@example.com'))
      const jobs = await queuedJobs()
      // Sign-up already sent the owner a verification email.
      const before = harness.services.sentEmails.length

      for (const job of jobs) {
        await runRegisteredJob(job)
      }

      const sent = harness.services.sentEmails.slice(before)

      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({
        to: 'alex@example.com',
        subject: 'Thanks from Acme',
        body: 'We received your Website contact message.',
        replyTo: 'ada@example.com',
        fromName: 'Acme via Kelpie',
        // An out-of-office answer to this goes to the Reply-To member.
        headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
      })
      // The header names the workspace, not Kelpie. The submitter is outside
      // the workspace, so the name is text: nothing in the message links to
      // the deployment, which would give the submitter a sign-in page.
      expect(sent[0]?.html).toMatch(/<span class="email-masthead_name"[^>]*>\s*Acme\s*<\/span>/u)
      expect(sent[0]?.html).not.toContain('<a ')
      expect(sent[0]?.html).not.toContain(TEST_APP_BASE_URL)
      expect(sent[0]?.body).not.toContain(TEST_APP_BASE_URL)
      expect((await readSubmission(form, first)).actionLog).toContainEqual({
        action: 'email_auto_reply',
        status: 'ok',
        detail: 'Sent to the submitter',
      })
      expect((await readSubmission(form, second)).actionLog).toContainEqual({
        action: 'email_auto_reply',
        status: 'skipped',
        detail: 'Sent to this address in the last 24 hours',
      })
    })

    /** A submission stored before the submit refused such an answer. */
    it('sends no auto-reply, and sets no Reply-To, for a stored answer that is not one address', async () => {
      const form = await createForm({
        auto_reply: true,
        notify_email: true,
        notify_recipients: [{ kind: 'member', member_id: ownerMemberId }],
      })
      const submissionId = await submit(form, contactAnswers(form))

      await database.db
        .update(formSubmissions)
        .set({ answers: contactAnswers(form, 'alex@example.com, sam@example.com') })
        .where(eq(formSubmissions.id, submissionId))

      const before = harness.services.sentEmails.length

      for (const job of await queuedJobs()) {
        await runRegisteredJob(job)
      }

      const sent = harness.services.sentEmails.slice(before)

      expect(sent).toHaveLength(1)
      expect(sent[0]?.to).toBe('ada@example.com')
      expect(sent[0]?.replyTo).toBeUndefined()
      expect((await readSubmission(form, submissionId)).actionLog).toContainEqual({
        action: 'email_auto_reply',
        status: 'skipped',
        detail: 'No submitter email',
      })
    })

    it('stops at the daily auto-reply limit', async () => {
      const form = await createForm({ auto_reply: true })
      const first = await submit(form, contactAnswers(form, 'one@example.com'))
      const second = await submit(form, contactAnswers(form, 'two@example.com'))
      const { sender, sent } = controlledSender(new Set())
      const dependencies = directDependencies(sender, { autoReplyDailyLimit: 1 })

      await sendFormEmails(dependencies, { workspaceId: acme.workspaceId, submissionId: first, kinds: ['auto_reply'] })
      await sendFormEmails(dependencies, { workspaceId: acme.workspaceId, submissionId: second, kinds: ['auto_reply'] })

      expect(sent.map((message) => message.to)).toEqual(['one@example.com'])
      expect((await readSubmission(form, second)).actionLog).toContainEqual({
        action: 'email_auto_reply',
        status: 'skipped',
        detail: 'Daily auto-reply limit reached',
      })
    })

    it('records a failure, throws so the queue retries, and a retry sends only what failed', async () => {
      const form = await createForm({
        notify_email: true,
        notify_recipients: [
          { kind: 'address', address: 'works@example.com' },
          { kind: 'address', address: 'broken@example.com' },
        ],
      })
      const submissionId = await submit(form, contactAnswers(form))
      const data: SendFormEmailsData = {
        workspaceId: acme.workspaceId,
        submissionId,
        kinds: ['notification'],
      }
      const failing = controlledSender(new Set(['broken@example.com']))

      await expect(sendFormEmails(directDependencies(failing.sender), data)).rejects.toThrow(
        /broken@example.com/u,
      )
      expect(failing.sent.map((message) => message.to)).toEqual(['works@example.com'])

      const failed = await readSubmission(form, submissionId)
      const failedEntry = failed.actionLog.find((entry) => entry.action === 'email_notification')

      expect(failedEntry?.status).toBe('error')
      expect(failedEntry?.detail).toContain('Sent to 1 of 2 recipients')

      const working = controlledSender(new Set())

      await sendFormEmails(directDependencies(working.sender), data)

      expect(working.sent.map((message) => message.to)).toEqual(['broken@example.com'])

      const retried = await readSubmission(form, submissionId)

      expect(retried.actionLog.filter((entry) => entry.action === 'email_notification')).toEqual([
        { action: 'email_notification', status: 'ok', detail: 'Sent to 2 of 2 recipients' },
      ])

      const sends = await database.db
        .select()
        .from(formEmailSends)
        .where(eq(formEmailSends.submissionId, submissionId))

      expect(sends.map((row) => [row.recipient, row.status]).sort()).toEqual([
        ['broken@example.com', 'sent'],
        ['works@example.com', 'sent'],
      ])
    })

    it('does not retry a permanent failure, and still sends the other email', async () => {
      const form = await createForm({
        notify_email: true,
        notify_recipients: [{ kind: 'address', address: 'sales@example.com' }],
        auto_reply: true,
      })
      const submissionId = await submit(form, contactAnswers(form))
      const data: SendFormEmailsData = {
        workspaceId: acme.workspaceId,
        submissionId,
        kinds: ['notification', 'auto_reply'],
      }
      // The notification is refused for good. It goes first, so the auto-reply
      // shows that a refusal does not stop the message after it.
      const sender = controlledSender(new Set(), new Set(['sales@example.com']))

      // No throw: the job completes, so the queue does not run it again.
      await sendFormEmails(directDependencies(sender.sender), data)

      expect(sender.sent.map((message) => message.to)).toEqual(['alex@example.com'])

      const stored = await readSubmission(form, submissionId)
      const notification = stored.actionLog.find((entry) => entry.action === 'email_notification')

      // `refused`, not `error`: no retry follows. The detail is the reason
      // alone, with no words in front of it that tell the job what to do.
      expect(notification?.status).toBe('refused')
      expect(notification?.detail).toBe(
        'Sent to 0 of 1 recipients. sales@example.com: PermanentEmailError: 550 no mailbox sales@example.com',
      )
      expect(stored.actionLog).toContainEqual({
        action: 'email_auto_reply',
        status: 'ok',
        detail: 'Sent to the submitter',
      })

      const sends = await database.db
        .select()
        .from(formEmailSends)
        .where(eq(formEmailSends.submissionId, submissionId))

      expect(sends.map((row) => [row.recipient, row.status, row.detail]).sort()).toEqual([
        ['alex@example.com', 'sent', ''],
        ['sales@example.com', 'refused', 'PermanentEmailError: 550 no mailbox sales@example.com'],
      ])

      // A second run, as a redelivery of the job would be: neither message is
      // sent again, and the recorded outcome stays.
      await sendFormEmails(directDependencies(sender.sender), data)

      expect(sender.tried).toEqual(['sales@example.com', 'alex@example.com'])
      expect((await readSubmission(form, submissionId)).actionLog).toEqual(stored.actionLog)
    })

    it('does not retry a permanent failure of the auto-reply, and still sends the notification', async () => {
      const form = await createForm({
        notify_email: true,
        notify_recipients: [{ kind: 'address', address: 'sales@example.com' }],
        auto_reply: true,
      })
      const submissionId = await submit(form, contactAnswers(form))
      const sender = controlledSender(new Set(), new Set(['alex@example.com']))

      await sendFormEmails(directDependencies(sender.sender), {
        workspaceId: acme.workspaceId,
        submissionId,
        kinds: ['notification', 'auto_reply'],
      })

      expect(sender.sent.map((message) => message.to)).toEqual(['sales@example.com'])
      expect((await readSubmission(form, submissionId)).actionLog.filter((entry) => entry.action.startsWith('email_'))).toEqual([
        { action: 'email_notification', status: 'ok', detail: 'Sent to 1 of 1 recipients' },
        {
          action: 'email_auto_reply',
          status: 'refused',
          detail: 'PermanentEmailError: 550 no mailbox alex@example.com',
        },
      ])
    })

    it('retries for a failure a later try can clear, and does not send a refused message again', async () => {
      const form = await createForm({
        notify_email: true,
        notify_recipients: [
          { kind: 'address', address: 'gone@example.com' },
          { kind: 'address', address: 'busy@example.com' },
        ],
      })
      const submissionId = await submit(form, contactAnswers(form))
      const data: SendFormEmailsData = {
        workspaceId: acme.workspaceId,
        submissionId,
        kinds: ['notification'],
      }
      const first = controlledSender(new Set(['busy@example.com']), new Set(['gone@example.com']))

      // The throw names only the message a retry can help.
      const thrown: unknown = await sendFormEmails(directDependencies(first.sender), data).catch(
        (error: unknown) => error,
      )

      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('busy@example.com')

      const readSends = async (): Promise<string[][]> =>
        (await database.db.select().from(formEmailSends).where(eq(formEmailSends.submissionId, submissionId)))
          .map((row) => [row.recipient, row.status])
          .sort()

      // One message waits for a retry, so the entry is an `error`. The rows
      // tell the two failures apart by status.
      expect(await readSends()).toEqual([
        ['busy@example.com', 'error'],
        ['gone@example.com', 'refused'],
      ])
      expect(
        (await readSubmission(form, submissionId)).actionLog.find(
          (candidate) => candidate.action === 'email_notification',
        )?.status,
      ).toBe('error')

      const retry = controlledSender(new Set(), new Set(['gone@example.com']))

      await sendFormEmails(directDependencies(retry.sender), data)

      expect(retry.tried).toEqual(['busy@example.com'])
      expect(await readSends()).toEqual([
        ['busy@example.com', 'sent'],
        ['gone@example.com', 'refused'],
      ])

      const entry = (await readSubmission(form, submissionId)).actionLog.find(
        (candidate) => candidate.action === 'email_notification',
      )

      // Nothing waits for a retry now. The only message not sent is refused.
      expect(entry?.status).toBe('refused')
      expect(entry?.detail).toBe(
        'Sent to 1 of 2 recipients. gone@example.com: PermanentEmailError: 550 no mailbox gone@example.com',
      )
    })

    it('decides from the status, not from the text of the detail', async () => {
      const form = await createForm({
        notify_email: true,
        notify_recipients: [{ kind: 'address', address: 'sales@example.com' }],
      })
      const submissionId = await submit(form, contactAnswers(form))
      const data: SendFormEmailsData = {
        workspaceId: acme.workspaceId,
        submissionId,
        kinds: ['notification'],
      }
      const row = {
        workspaceId: acme.workspaceId,
        formId: form.id,
        submissionId,
        kind: 'notification',
        recipient: 'sales@example.com',
      }

      // An `error` whose detail starts with words that say "not retried" is
      // still an error: the job sends the message again.
      await database.db
        .insert(formEmailSends)
        .values({ ...row, id: 'fes_text', status: 'error', detail: 'Not retried: 550 no mailbox' })

      const working = controlledSender(new Set())

      await sendFormEmails(directDependencies(working.sender), data)

      expect(working.tried).toEqual(['sales@example.com'])

      // A `refused` row with an empty detail stops the message.
      await database.db
        .update(formEmailSends)
        .set({ status: 'refused', detail: '' })
        .where(eq(formEmailSends.submissionId, submissionId))

      const idle = controlledSender(new Set())

      await sendFormEmails(directDependencies(idle.sender), data)

      expect(idle.tried).toEqual([])
    })

    it('has a status check that accepts `refused` and refuses a value it does not list', async () => {
      const form = await createForm({
        notify_email: true,
        notify_recipients: [{ kind: 'address', address: 'sales@example.com' }],
      })
      const submissionId = await submit(form, contactAnswers(form))
      const row = {
        workspaceId: acme.workspaceId,
        formId: form.id,
        submissionId,
        kind: 'notification',
        detail: '',
      }

      await database.db
        .insert(formEmailSends)
        .values({ ...row, id: 'fes_refused', recipient: 'one@example.com', status: 'refused' })

      const stored = await database.db
        .select()
        .from(formEmailSends)
        .where(eq(formEmailSends.id, 'fes_refused'))

      expect(stored.map((send) => send.status)).toEqual(['refused'])

      const thrown: unknown = await database.db
        .insert(formEmailSends)
        .values({ ...row, id: 'fes_bounced', recipient: 'two@example.com', status: 'bounced' })
        .catch((error: unknown) => error)

      expect(messagesOf(thrown)).toContain('form_email_sends_status_check')
    })

    it('sends nothing for a form paused or an email turned off before the job ran', async () => {
      const form = await createForm({
        notify_email: true,
        notify_recipients: [{ kind: 'address', address: 'sales@example.com' }],
        auto_reply: true,
      })
      const submissionId = await submit(form, contactAnswers(form))
      const data: SendFormEmailsData = {
        workspaceId: acme.workspaceId,
        submissionId,
        kinds: ['notification', 'auto_reply'],
      }

      await client.send('PATCH', `/v1/forms/${form.id}`, { body: { auto_reply: false }, cookie: acme.cookie })

      const { sender, sent } = controlledSender(new Set())

      await sendFormEmails(directDependencies(sender), data)

      expect(sent.map((message) => message.to)).toEqual(['sales@example.com'])
      expect((await readSubmission(form, submissionId)).actionLog).toContainEqual({
        action: 'email_auto_reply',
        status: 'skipped',
        detail: 'Turned off before it was sent',
      })

      await client.send('PATCH', `/v1/forms/${form.id}`, { body: { status: 'paused' }, cookie: acme.cookie })

      const later = await createForm({ auto_reply: true })
      const laterId = await submit(later, contactAnswers(later, 'later@example.com'))

      await client.send('PATCH', `/v1/forms/${later.id}`, { body: { status: 'paused' }, cookie: acme.cookie })
      await sendFormEmails(directDependencies(sender), {
        workspaceId: acme.workspaceId,
        submissionId: laterId,
        kinds: ['auto_reply'],
      })

      expect(sent.map((message) => message.to)).toEqual(['sales@example.com'])
      expect((await readSubmission(later, laterId)).actionLog).toContainEqual({
        action: 'email_auto_reply',
        status: 'skipped',
        detail: 'The form was paused before the email was sent',
      })
    })
  })
})
