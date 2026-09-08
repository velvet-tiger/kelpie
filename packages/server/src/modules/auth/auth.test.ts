import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { verifyPassword } from '../../lib/passwords.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_APP_BASE_URL, TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { userPreferences, users } from './schema.ts'

/**
 * The auth surface against real Postgres. These assert behaviour a stranger can
 * observe, because that is where the security properties live.
 */

const connectionString = testDatabaseUrl(process.env)

const SIGNUP = {
  email: 'Ada@Example.com',
  name: 'Ada Lovelace',
  password: 'correct horse battery staple',
}

describe.skipIf(connectionString === undefined)('auth', () => {
  let database: TestDatabase
  let harness: TestApp

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
  })

  function post(path: string, body: unknown, cookie?: string): Promise<Response> {
    return Promise.resolve(harness.app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Vitest',
        ...(cookie === undefined ? {} : { Cookie: cookie }),
      },
      body: JSON.stringify(body),
    }))
  }

  function patch(path: string, body: unknown, cookie?: string): Promise<Response> {
    return Promise.resolve(harness.app.request(path, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie === undefined ? {} : { Cookie: cookie }),
      },
      body: JSON.stringify(body),
    }))
  }

  function get(path: string, cookie?: string): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, {
        headers: cookie === undefined ? {} : { Cookie: cookie },
      }),
    )
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  /** Reads a `{ data, next_cursor }` page of sessions without casting past the boundary. */
  async function readSessionPage(
    response: Response,
  ): Promise<{ sessions: { id: string; current: boolean }[]; nextCursor: unknown; lastActiveAt: unknown }> {
    const payload: unknown = await response.json()

    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error(`Expected a session page, got ${JSON.stringify(payload)}`)
    }

    const [first] = payload.data

    return {
      nextCursor: payload.next_cursor,
      lastActiveAt: isRecord(first) ? first.last_active_at : undefined,
      sessions: payload.data.map((entry: unknown) => {
        if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.current !== 'boolean') {
          throw new Error(`Expected a session, got ${JSON.stringify(entry)}`)
        }

        return { id: entry.id, current: entry.current }
      }),
    }
  }

  /** The Set-Cookie value a browser would send back. */
  function sessionCookieFrom(response: Response): string {
    const header = response.headers.get('Set-Cookie')

    if (header === null) {
      throw new Error('Expected a session cookie on the response')
    }

    return header.split(';')[0] ?? ''
  }

  /** The token from the most recently sent verification email. */
  function verificationTokenFromEmail(): string {
    const message = harness.services.sentEmails.at(-1)

    if (message === undefined) {
      throw new Error('Expected a verification email to have been sent')
    }

    const match = /token=([^\s]+)/u.exec(message.body)

    if (match?.[1] === undefined) {
      throw new Error(`No token in the verification email: ${message.body}`)
    }

    return match[1]
  }

  async function signUp(): Promise<string> {
    const response = await post('/v1/auth/signup', SIGNUP)
    expect(response.status).toBe(201)

    return sessionCookieFrom(response)
  }

  describe('signup', () => {
    it('creates the account, returns a session, and creates no workspace', async () => {
      const response = await post('/v1/auth/signup', SIGNUP)

      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({
        account: {
          id: expect.stringMatching(/^usr_/u),
          email: 'ada@example.com',
          name: 'Ada Lovelace',
          email_verified: false,
        },
        active_workspace_id: null,
      })
    })

    it('sets an HttpOnly session cookie', async () => {
      const response = await post('/v1/auth/signup', SIGNUP)
      const header = response.headers.get('Set-Cookie') ?? ''

      expect(header).toContain('kelpie_session=')
      expect(header).toContain('HttpOnly')
      expect(header).toContain('SameSite=Lax')
    })

    it('stores an argon2id hash, never the password', async () => {
      await post('/v1/auth/signup', SIGNUP)

      const [user] = await database.db.select().from(users).where(eq(users.email, 'ada@example.com'))

      expect(user?.passwordHash).toMatch(/^\$argon2id\$/u)
      expect(user?.passwordHash).not.toContain(SIGNUP.password)
      expect(await verifyPassword(user?.passwordHash ?? '', SIGNUP.password)).toBe(true)
    })

    it('rejects a second account on the same address, case-insensitively', async () => {
      await post('/v1/auth/signup', SIGNUP)

      const response = await post('/v1/auth/signup', { ...SIGNUP, email: 'ADA@example.com' })

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'conflict' } })
    })

    it('rejects a password shorter than the minimum', async () => {
      const response = await post('/v1/auth/signup', { ...SIGNUP, password: 'short' })

      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        error: { code: 'validation_failed', details: [{ field: 'password' }] },
      })
    })

    it('rejects a body missing required fields', async () => {
      const response = await post('/v1/auth/signup', { email: 'someone@example.com' })

      expect(response.status).toBe(422)
    })
  })

  describe('signups closed', () => {
    beforeEach(async () => {
      harness = await createTestApp({
        modules: coreModules,
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db }),
        signupsEnabled: false,
      })
    })

    it('refuses a new account with a clear error', async () => {
      const response = await post('/v1/auth/signup', SIGNUP)

      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        error: { code: 'forbidden', message: 'Signups are closed on this instance' },
      })
    })

    it('creates no account and sets no cookie', async () => {
      const response = await post('/v1/auth/signup', SIGNUP)

      expect(response.headers.get('Set-Cookie')).toBeNull()

      const [user] = await database.db.select().from(users).where(eq(users.email, 'ada@example.com'))
      expect(user).toBeUndefined()
    })
  })

  describe('login', () => {
    beforeEach(async () => {
      await post('/v1/auth/signup', SIGNUP)
    })

    it('accepts the right password and matches on address case-insensitively', async () => {
      const response = await post('/v1/auth/login', {
        email: 'ADA@EXAMPLE.COM',
        password: SIGNUP.password,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ account: { email: 'ada@example.com' } })
    })

    it('answers 401 for a wrong password', async () => {
      const response = await post('/v1/auth/login', { email: SIGNUP.email, password: 'wrong password!' })

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        error: { code: 'unauthorized', message: 'Email or password is incorrect' },
      })
    })

    it('answers the same for an unknown address as for a wrong password', async () => {
      const unknown = await post('/v1/auth/login', {
        email: 'nobody@example.com',
        password: SIGNUP.password,
      })
      const wrong = await post('/v1/auth/login', { email: SIGNUP.email, password: 'wrong password!' })

      expect(unknown.status).toBe(401)
      expect(await unknown.json()).toEqual(await wrong.json())
    })
  })

  describe('the session', () => {
    it('identifies the caller through /auth/me', async () => {
      const cookie = await signUp()

      const response = await harness.app.request('/v1/auth/me', { headers: { Cookie: cookie } })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        user_id: expect.stringMatching(/^usr_/u),
        workspace_id: null,
        role: null,
      })
    })

    it('answers 401 without a cookie', async () => {
      const response = await harness.app.request('/v1/auth/me')

      expect(response.status).toBe(401)
    })

    it('answers 401 for a token that was never issued', async () => {
      const response = await harness.app.request('/v1/auth/me', {
        headers: { Cookie: 'kelpie_session=not-a-real-token' },
      })

      expect(response.status).toBe(401)
    })

    it('stops working after logout', async () => {
      const cookie = await signUp()

      expect((await post('/v1/auth/logout', {}, cookie)).status).toBe(204)
      expect((await harness.app.request('/v1/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
    })
  })

  describe('session management', () => {
    it('lists sessions and marks the caller as current', async () => {
      const first = await signUp()
      await post('/v1/auth/login', { email: SIGNUP.email, password: SIGNUP.password })

      const response = await harness.app.request('/v1/auth/sessions', { headers: { Cookie: first } })
      const page = await readSessionPage(response)

      expect(response.status).toBe(200)
      expect(page.sessions).toHaveLength(2)
      expect(page.sessions.filter((session) => session.current)).toHaveLength(1)
      expect(page.nextCursor).toBeNull()
      expect(page.lastActiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    })

    it('revokes another session', async () => {
      const keep = await signUp()
      const other = sessionCookieFrom(
        await post('/v1/auth/login', { email: SIGNUP.email, password: SIGNUP.password }),
      )

      const listed = await readSessionPage(
        await harness.app.request('/v1/auth/sessions', { headers: { Cookie: keep } }),
      )
      const target = listed.sessions.find((session) => !session.current)

      if (target === undefined) {
        throw new Error('Expected a session other than the caller\'s')
      }

      const revoked = await harness.app.request(`/v1/auth/sessions/${target.id}`, {
        method: 'DELETE',
        headers: { Cookie: keep },
      })

      expect(revoked.status).toBe(204)
      expect((await harness.app.request('/v1/auth/me', { headers: { Cookie: other } })).status).toBe(401)
      expect((await harness.app.request('/v1/auth/me', { headers: { Cookie: keep } })).status).toBe(200)
    })

    it('answers 404 for a session belonging to someone else', async () => {
      const mine = await signUp()
      const theirs = sessionCookieFrom(
        await post('/v1/auth/signup', {
          email: 'grace@example.com',
          name: 'Grace Hopper',
          password: 'another long enough password',
        }),
      )
      const theirSessions = await readSessionPage(
        await harness.app.request('/v1/auth/sessions', { headers: { Cookie: theirs } }),
      )

      const response = await harness.app.request(`/v1/auth/sessions/${theirSessions.sessions[0]?.id}`, {
        method: 'DELETE',
        headers: { Cookie: mine },
      })

      expect(response.status).toBe(404)
    })
  })

  describe('the account', () => {
    const OTHER = {
      email: 'grace@example.com',
      name: 'Grace Hopper',
      password: 'another long enough password',
    }

    it('answers with the signed-in account', async () => {
      const cookie = await signUp()

      const response = await get('/v1/account', cookie)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        id: expect.stringMatching(/^usr_/u),
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        email_verified: false,
      })
    })

    it('answers 401 without a cookie', async () => {
      expect((await get('/v1/account')).status).toBe(401)
      expect((await patch('/v1/account', { name: 'Nobody' })).status).toBe(401)
    })

    it('changes the name and leaves the address alone', async () => {
      const cookie = await signUp()

      const response = await patch('/v1/account', { name: 'Ada King' }, cookie)

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ name: 'Ada King', email: 'ada@example.com' })
      expect(await (await get('/v1/account', cookie)).json()).toMatchObject({ name: 'Ada King' })
    })

    it('stores a new address lowercase and moves the login to it', async () => {
      const cookie = await signUp()

      const response = await patch(
        '/v1/account',
        { email: 'Ada.King@Example.com', current_password: SIGNUP.password },
        cookie,
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ email: 'ada.king@example.com' })
      expect(
        (await post('/v1/auth/login', { email: 'ada.king@example.com', password: SIGNUP.password }))
          .status,
      ).toBe(200)
      expect(
        (await post('/v1/auth/login', { email: SIGNUP.email, password: SIGNUP.password })).status,
      ).toBe(401)
    })

    it('answers 409 for an address another account holds', async () => {
      const cookie = await signUp()
      await post('/v1/auth/signup', OTHER)

      const response = await patch(
        '/v1/account',
        { email: 'GRACE@example.com', current_password: SIGNUP.password },
        cookie,
      )

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: { code: 'conflict', details: [{ field: 'email' }] },
      })
    })

    it('answers 422 for an email change with no current password', async () => {
      const cookie = await signUp()

      const response = await patch('/v1/account', { email: 'ada.king@example.com' }, cookie)

      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        error: { code: 'validation_failed', details: [{ field: 'current_password' }] },
      })
    })

    it('answers 401 for an email change with the wrong current password', async () => {
      const cookie = await signUp()

      const response = await patch(
        '/v1/account',
        { email: 'ada.king@example.com', current_password: 'not it' },
        cookie,
      )

      expect(response.status).toBe(401)
      expect(await (await get('/v1/account', cookie)).json()).toMatchObject({
        email: 'ada@example.com',
      })
    })

    it('does not require a password when the email is not part of the change', async () => {
      const cookie = await signUp()

      const response = await patch('/v1/account', { name: 'Ada King' }, cookie)

      expect(response.status).toBe(200)
    })

    it('keeps the caller signed in, signs every other device out, and tells the old address', async () => {
      const keep = await signUp()
      const other = sessionCookieFrom(
        await post('/v1/auth/login', { email: SIGNUP.email, password: SIGNUP.password }),
      )
      // Signing up already sent one verification email; the change notice and a
      // fresh verification token for the new address come next.
      const sentBeforeChange = harness.services.sentEmails.length

      const response = await patch(
        '/v1/account',
        { email: 'ada.king@example.com', current_password: SIGNUP.password },
        keep,
      )

      expect(response.status).toBe(200)
      expect((await harness.app.request('/v1/auth/me', { headers: { Cookie: keep } })).status).toBe(200)
      expect((await harness.app.request('/v1/auth/me', { headers: { Cookie: other } })).status).toBe(401)

      const [changeNotice, verification] = harness.services.sentEmails.slice(sentBeforeChange)
      expect(harness.services.sentEmails).toHaveLength(sentBeforeChange + 2)
      expect(changeNotice).toMatchObject({ to: 'ada@example.com' })
      expect(changeNotice?.body).toContain('ada.king@example.com')
      expect(verification).toMatchObject({ to: 'ada.king@example.com' })
    })

    it('resets verification on a real address change, and a no-op change resets nothing', async () => {
      const cookie = await signUp()
      await post('/v1/auth/verify-email/confirm', { token: verificationTokenFromEmail() })
      expect(await (await get('/v1/account', cookie)).json()).toMatchObject({ email_verified: true })

      // Submitting the address already on file is not a change.
      const unchanged = await patch(
        '/v1/account',
        { email: SIGNUP.email, current_password: SIGNUP.password },
        cookie,
      )
      expect(unchanged.status).toBe(200)
      expect(await (await get('/v1/account', cookie)).json()).toMatchObject({ email_verified: true })

      const changed = await patch(
        '/v1/account',
        { email: 'ada.king@example.com', current_password: SIGNUP.password },
        cookie,
      )
      expect(changed.status).toBe(200)
      expect(await changed.json()).toMatchObject({ email: 'ada.king@example.com', email_verified: false })
      expect(await (await get('/v1/account', cookie)).json()).toMatchObject({ email_verified: false })

      const confirmed = await post('/v1/auth/verify-email/confirm', {
        token: verificationTokenFromEmail(),
      })
      expect(confirmed.status).toBe(204)
      expect(await (await get('/v1/account', cookie)).json()).toMatchObject({ email_verified: true })
    })

    it('refuses a name that is only whitespace', async () => {
      const cookie = await signUp()

      const response = await patch('/v1/account', { name: '   ' }, cookie)

      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        error: { code: 'validation_failed', details: [{ field: 'name' }] },
      })
    })

    it('refuses a field it does not define', async () => {
      const cookie = await signUp()

      const response = await patch('/v1/account', { role: 'owner' }, cookie)

      expect(response.status).toBe(422)
    })

    it('leaves another account untouched', async () => {
      const mine = await signUp()
      const theirs = sessionCookieFrom(await post('/v1/auth/signup', OTHER))

      expect((await patch('/v1/account', { name: 'Renamed' }, mine)).status).toBe(200)

      expect(await (await get('/v1/account', theirs)).json()).toMatchObject({
        name: 'Grace Hopper',
        email: 'grace@example.com',
      })
    })
  })

  describe('account preferences', () => {
    const DEFAULTS = {
      timezone: 'UTC',
      theme: 'system',
      email_digest: true,
      mention_emails: true,
      product_updates: false,
      list_views: {},
    }

    it('answers defaults for an account that has never saved any, and stores no row', async () => {
      const cookie = await signUp()

      const response = await get('/v1/account/preferences', cookie)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(DEFAULTS)
      expect(await database.db.select().from(userPreferences)).toHaveLength(0)
    })

    it('answers 401 without a cookie', async () => {
      expect((await get('/v1/account/preferences')).status).toBe(401)
      expect((await patch('/v1/account/preferences', { theme: 'dark' })).status).toBe(401)
    })

    it('saves the fields it was given and defaults the rest', async () => {
      const cookie = await signUp()

      const response = await patch(
        '/v1/account/preferences',
        { timezone: 'Australia/Sydney', product_updates: true },
        cookie,
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        ...DEFAULTS,
        timezone: 'Australia/Sydney',
        product_updates: true,
      })
    })

    it('merges a later change onto what is stored', async () => {
      const cookie = await signUp()
      await patch('/v1/account/preferences', { timezone: 'Australia/Sydney' }, cookie)

      const response = await patch('/v1/account/preferences', { theme: 'dark' }, cookie)

      expect(await response.json()).toEqual({
        ...DEFAULTS,
        timezone: 'Australia/Sydney',
        theme: 'dark',
      })
      expect(await (await get('/v1/account/preferences', cookie)).json()).toMatchObject({
        timezone: 'Australia/Sydney',
        theme: 'dark',
      })
    })

    it('turns a toggle off, rather than reading false as an absent field', async () => {
      const cookie = await signUp()

      const response = await patch('/v1/account/preferences', { email_digest: false }, cookie)

      expect(await response.json()).toMatchObject({ email_digest: false })
    })

    it('writes one row however many times the same save is repeated', async () => {
      const cookie = await signUp()
      const body = { timezone: 'Europe/London', theme: 'light' }

      const first = await patch('/v1/account/preferences', body, cookie)
      const second = await patch('/v1/account/preferences', body, cookie)

      expect(second.status).toBe(200)
      expect(await second.json()).toEqual(await first.json())
      expect(await database.db.select().from(userPreferences)).toHaveLength(1)
    })

    it('refuses a timezone the platform cannot resolve', async () => {
      const cookie = await signUp()

      const response = await patch('/v1/account/preferences', { timezone: 'Mars/Olympus' }, cookie)

      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        error: { code: 'validation_failed', details: [{ field: 'timezone' }] },
      })
    })

    it('refuses a theme outside the documented set', async () => {
      const cookie = await signUp()

      const response = await patch('/v1/account/preferences', { theme: 'sepia' }, cookie)

      expect(response.status).toBe(422)
    })

    it('saves a list_views map and reads the same one back', async () => {
      const cookie = await signUp()

      const first = await patch(
        '/v1/account/preferences',
        { list_views: { people: { columns: ['name', 'tags'] } } },
        cookie,
      )

      expect(first.status).toBe(200)
      expect(await first.json()).toMatchObject({
        list_views: { people: { columns: ['name', 'tags'] } },
      })

      // A later change to another view id replaces the whole map, per
      // applyPreferenceChanges. The client merges before it PATCHes.
      const second = await patch(
        '/v1/account/preferences',
        {
          list_views: {
            people: { columns: ['name', 'tags'] },
            companies: { columns: ['name', 'stage'] },
          },
        },
        cookie,
      )

      expect(await second.json()).toMatchObject({
        list_views: {
          people: { columns: ['name', 'tags'] },
          companies: { columns: ['name', 'stage'] },
        },
      })
    })

    it('refuses a list_views entry with an unknown field', async () => {
      const cookie = await signUp()

      const response = await patch(
        '/v1/account/preferences',
        { list_views: { people: { columns: ['name'], sneaky: true } } },
        cookie,
      )

      expect(response.status).toBe(422)
    })

    it('keeps one account\'s preferences out of another\'s', async () => {
      const mine = await signUp()
      const theirs = sessionCookieFrom(
        await post('/v1/auth/signup', {
          email: 'grace@example.com',
          name: 'Grace Hopper',
          password: 'another long enough password',
        }),
      )

      await patch('/v1/account/preferences', { theme: 'dark', timezone: 'Europe/London' }, mine)

      expect(await (await get('/v1/account/preferences', theirs)).json()).toEqual(DEFAULTS)
    })
  })

  describe('changing a password while signed in', () => {
    it('keeps the caller signed in and signs every other device out', async () => {
      const keep = await signUp()
      const other = sessionCookieFrom(
        await post('/v1/auth/login', { email: SIGNUP.email, password: SIGNUP.password }),
      )

      const response = await harness.app.request('/v1/auth/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: keep },
        body: JSON.stringify({
          current_password: SIGNUP.password,
          new_password: 'a completely different password',
        }),
      })

      expect(response.status).toBe(204)
      expect((await harness.app.request('/v1/auth/me', { headers: { Cookie: keep } })).status).toBe(200)
      expect((await harness.app.request('/v1/auth/me', { headers: { Cookie: other } })).status).toBe(401)
      expect(
        (await post('/v1/auth/login', { email: SIGNUP.email, password: 'a completely different password' }))
          .status,
      ).toBe(200)
    })

    it('answers 401 when the current password is wrong', async () => {
      const cookie = await signUp()

      const response = await harness.app.request('/v1/auth/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ current_password: 'not it', new_password: 'a long enough new password' }),
      })

      expect(response.status).toBe(401)
    })
  })

  describe('password reset', () => {
    function tokenFromEmail(): string {
      const message = harness.services.sentEmails.at(-1)

      if (message === undefined) {
        throw new Error('Expected the reset email to have been sent')
      }

      const match = /token=([^\s]+)/u.exec(message.body)

      if (match?.[1] === undefined) {
        throw new Error(`No token in the reset email: ${message.body}`)
      }

      return match[1]
    }

    it('emails a link to a registered address', async () => {
      await signUp()
      // Signing up already sent one verification email; only the reset link comes next.
      const sentBeforeReset = harness.services.sentEmails.length

      const response = await post('/v1/auth/password-reset', { email: SIGNUP.email })

      expect(response.status).toBe(202)
      expect(harness.services.sentEmails).toHaveLength(sentBeforeReset + 1)
      expect(harness.services.sentEmails.at(-1)?.to).toBe('ada@example.com')
      // The link is built server-side from APP_BASE_URL, not from anything the
      // caller sent, which is the whole point of the change.
      expect(harness.services.sentEmails.at(-1)?.body).toContain(
        `${TEST_APP_BASE_URL}/reset-password?token=`,
      )
    })

    it('answers 202 for an unknown address and sends nothing', async () => {
      const response = await post('/v1/auth/password-reset', { email: 'nobody@example.com' })

      expect(response.status).toBe(202)
      expect(harness.services.sentEmails).toHaveLength(0)
    })

    it('sets the new password and ends every session', async () => {
      const cookie = await signUp()
      await post('/v1/auth/password-reset', { email: SIGNUP.email })

      const confirmed = await post('/v1/auth/password-reset/confirm', {
        token: tokenFromEmail(),
        password: 'a brand new long password',
      })

      expect(confirmed.status).toBe(204)
      expect((await harness.app.request('/v1/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
      expect(
        (await post('/v1/auth/login', { email: SIGNUP.email, password: 'a brand new long password' })).status,
      ).toBe(200)
    })

    it('refuses a token that has already been used', async () => {
      await signUp()
      await post('/v1/auth/password-reset', { email: SIGNUP.email })
      const token = tokenFromEmail()

      await post('/v1/auth/password-reset/confirm', { token, password: 'a brand new long password' })
      const replay = await post('/v1/auth/password-reset/confirm', {
        token,
        password: 'yet another long password',
      })

      expect(replay.status).toBe(401)
    })

    it('refuses an expired token', async () => {
      const past = new Date('2026-08-02T00:00:00.000Z')
      const expired = await createTestApp({
        modules: coreModules,
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db, now: () => past }),
      })

      await expired.app.request('/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...SIGNUP, email: 'expiry@example.com' }),
      })
      await expired.app.request('/v1/auth/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'expiry@example.com' }),
      })

      const issuedToken = /token=([^\s]+)/u.exec(expired.services.sentEmails.at(-1)?.body ?? '')?.[1] ?? ''

      // The default harness clock is now, which is hours past the one-hour window.
      const response = await post('/v1/auth/password-reset/confirm', {
        token: issuedToken,
        password: 'a brand new long password',
      })

      expect(response.status).toBe(401)
    })

    it('builds the reset link from services.appBaseUrl when set, ignoring APP_BASE_URL in the environment', async () => {
      // The assembly's `kelpie.config.ts` supplies `appBaseUrl` through
      // services. The env var still holds a different value, so the assertion
      // proves services wins — the two values are picked to be visibly
      // different in the emailed link.
      const SERVICES_URL = 'https://services-wins.example'
      const overridden = await createTestApp({
        modules: coreModules,
        environment: { ...TEST_ENVIRONMENT, APP_BASE_URL: 'https://env-loses.example' },
        services: createTestServices({ db: database.db, appBaseUrl: SERVICES_URL }),
      })

      const signupResponse = await overridden.app.request('/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...SIGNUP, email: 'precedence-reset@example.com' }),
      })
      expect(signupResponse.status).toBe(201)

      const resetResponse = await overridden.app.request('/v1/auth/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'precedence-reset@example.com' }),
      })
      expect(resetResponse.status).toBe(202)

      const body = overridden.services.sentEmails.at(-1)?.body ?? ''
      expect(body).toContain(`${SERVICES_URL}/reset-password?token=`)
      expect(body).not.toContain('env-loses.example')
    })

  })

  describe('email verification', () => {
    it('emails a link at signup, and leaves the account unverified', async () => {
      const response = await post('/v1/auth/signup', SIGNUP)
      const cookie = sessionCookieFrom(response)

      expect(harness.services.sentEmails).toHaveLength(1)
      expect(harness.services.sentEmails[0]?.to).toBe('ada@example.com')
      expect(await response.json()).toMatchObject({ account: { email_verified: false } })
      expect(await (await get('/v1/account', cookie)).json()).toMatchObject({ email_verified: false })
      expect(
        await (await harness.app.request('/v1/auth/me', { headers: { Cookie: cookie } })).json(),
      ).toMatchObject({ email_verified: false })
    })

    it('confirms a valid token, verifies the account, and ends no session', async () => {
      const cookie = await signUp()

      const confirmed = await post('/v1/auth/verify-email/confirm', {
        token: verificationTokenFromEmail(),
      })

      expect(confirmed.status).toBe(204)
      expect(await (await get('/v1/account', cookie)).json()).toMatchObject({ email_verified: true })
      expect((await harness.app.request('/v1/auth/me', { headers: { Cookie: cookie } })).status).toBe(200)
    })

    it('refuses a token that has already been used', async () => {
      await signUp()
      const token = verificationTokenFromEmail()

      await post('/v1/auth/verify-email/confirm', { token })
      const replay = await post('/v1/auth/verify-email/confirm', { token })

      expect(replay.status).toBe(401)
    })

    it('refuses an expired token', async () => {
      const past = new Date('2026-08-02T00:00:00.000Z')
      const expired = await createTestApp({
        modules: coreModules,
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db, now: () => past }),
      })

      await expired.app.request('/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...SIGNUP, email: 'expiry@example.com' }),
      })

      const issuedToken = /token=([^\s]+)/u.exec(expired.services.sentEmails[0]?.body ?? '')?.[1] ?? ''

      // The default harness clock is now, which is a day past the 24-hour window.
      const response = await post('/v1/auth/verify-email/confirm', { token: issuedToken })

      expect(response.status).toBe(401)
    })

    it('resends a fresh, working link on request', async () => {
      const cookie = await signUp()

      const response = await post('/v1/auth/verify-email', {}, cookie)

      expect(response.status).toBe(202)
      expect(harness.services.sentEmails).toHaveLength(2)

      const confirmed = await post('/v1/auth/verify-email/confirm', {
        token: verificationTokenFromEmail(),
      })

      expect(confirmed.status).toBe(204)
    })

    it('is a no-op, and sends nothing, once already verified', async () => {
      const cookie = await signUp()
      await post('/v1/auth/verify-email/confirm', { token: verificationTokenFromEmail() })

      const response = await post('/v1/auth/verify-email', {}, cookie)

      expect(response.status).toBe(202)
      expect(harness.services.sentEmails).toHaveLength(1)
    })

    it('answers 401 without a cookie', async () => {
      const response = await post('/v1/auth/verify-email', {})

      expect(response.status).toBe(401)
    })
  })

  describe('workspace switching', () => {
    async function verifiedCookie(email = SIGNUP.email): Promise<string> {
      const response = await post('/v1/auth/signup', { ...SIGNUP, email })
      expect(response.status).toBe(201)
      const cookie = sessionCookieFrom(response)
      const confirmed = await post('/v1/auth/verify-email/confirm', { token: verificationTokenFromEmail() })
      expect(confirmed.status).toBe(204)

      return cookie
    }

    async function createWorkspace(cookie: string, slug: string, name: string): Promise<string> {
      const response = await post(
        '/v1/workspaces',
        { name, slug, timezone: 'UTC' },
        cookie,
      )
      expect(response.status).toBe(201)
      const payload: unknown = await response.json()

      if (!isRecord(payload) || typeof payload.id !== 'string') {
        throw new Error(`Expected a workspace, got ${JSON.stringify(payload)}`)
      }

      return payload.id
    }

    it('lists nothing before the account has a workspace', async () => {
      const cookie = await verifiedCookie()

      const response = await get('/v1/auth/workspaces', cookie)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: [], next_cursor: null })
    })

    it('lists every membership and moves the session into another one', async () => {
      const cookie = await verifiedCookie()
      const acme = await createWorkspace(cookie, 'acme-switch', 'Acme')
      const globex = await createWorkspace(cookie, 'globex-switch', 'Globex')

      const listed = await get('/v1/auth/workspaces', cookie)
      expect(listed.status).toBe(200)
      const page: unknown = await listed.json()
      expect(isRecord(page) && Array.isArray(page.data) ? page.data.map((row) => {
        if (!isRecord(row)) {
          throw new Error('Expected a workspace row')
        }

        return { id: row.id, name: row.name, role: row.role }
      }) : []).toEqual([
        { id: acme, name: 'Acme', role: 'owner' },
        { id: globex, name: 'Globex', role: 'owner' },
      ])

      const meBefore = await harness.app.request('/v1/auth/me', { headers: { Cookie: cookie } })
      expect(await meBefore.json()).toMatchObject({ workspace_id: globex })

      const switched = await post('/v1/auth/workspace', { workspace_id: acme }, cookie)
      expect(switched.status).toBe(200)
      expect(await switched.json()).toMatchObject({
        workspace_id: acme,
        role: 'owner',
        email_verified: true,
      })

      const meAfter = await harness.app.request('/v1/auth/me', { headers: { Cookie: cookie } })
      expect(await meAfter.json()).toMatchObject({ workspace_id: acme })
    })

    it('answers 404 for a workspace the account does not belong to', async () => {
      const cookie = await verifiedCookie('ada-miss@example.com')
      await createWorkspace(cookie, 'acme-miss', 'Acme')
      const other = await verifiedCookie('grace-miss@example.com')
      const outsiderWorkspace = await createWorkspace(other, 'globex-miss', 'Globex')

      const response = await post('/v1/auth/workspace', { workspace_id: outsiderWorkspace }, cookie)

      expect(response.status).toBe(404)
    })

    it('needs a session, not an API key', async () => {
      const cookie = await verifiedCookie()
      await createWorkspace(cookie, 'acme-key', 'Acme')
      const minted = await post('/v1/api-keys', { name: 'agent', kind: 'workspace' }, cookie)
      expect(minted.status).toBe(201)
      const payload: unknown = await minted.json()
      const secret = isRecord(payload) && typeof payload.secret === 'string' ? payload.secret : ''

      const listed = await harness.app.request('/v1/auth/workspaces', {
        headers: { Authorization: `Bearer ${secret}` },
      })
      const switched = await harness.app.request('/v1/auth/workspace', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ workspace_id: 'ws_nope' }),
      })

      expect(listed.status).toBe(403)
      expect(switched.status).toBe(403)
    })

    it('answers 401 without a cookie', async () => {
      expect((await get('/v1/auth/workspaces')).status).toBe(401)
      expect((await post('/v1/auth/workspace', { workspace_id: 'ws_nope' })).status).toBe(401)
    })
  })
})
