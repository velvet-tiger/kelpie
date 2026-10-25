import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ExternalSignInError } from '../../lib/errors.ts'
import type { AnyEventEnvelope } from '../../runtime/events.ts'
import type { KelpieModule, SignUpAttempt, SignUpVerdict, VerifiedIdentity } from '../../runtime/module.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { users } from './schema.ts'

/**
 * The two account extension points a module gets from core: the sign-up
 * guard, and the account events on the bus. Driven through HTTP and a
 * fixture module, the way a real module (the cloud's account router) reaches
 * them.
 */

const connectionString = testDatabaseUrl(process.env)

const SIGNUP = {
  email: 'Ada@Example.com',
  name: 'Ada Lovelace',
  password: 'correct horse battery staple',
}

const IDENTITY: VerifiedIdentity = {
  email: 'Grace@Example.com',
  emailVerified: true,
  name: 'Grace Hopper',
  verifiedBy: 'test-identity:acme',
  provision: 'create',
}

describe.skipIf(connectionString === undefined)('account lifecycle', () => {
  let database: TestDatabase
  let harness: TestApp
  /** What each test's guards answer, in registration order. */
  let verdicts: SignUpVerdict[]
  /** When set, the first guard waits on it before answering. */
  let holdGuard: Promise<void> | undefined
  /** Every attempt each guard saw, tagged with the guard. */
  let seen: { readonly guard: string; readonly attempt: SignUpAttempt }[]
  let published: AnyEventEnvelope[]

  function guardModule(id: string, index: number): KelpieModule {
    return {
      id,
      structural: true,

      register(context) {
        context.guardSignUp(async (attempt) => {
          seen.push({ guard: id, attempt })

          if (index === 0 && holdGuard !== undefined) {
            await holdGuard
          }

          return verdicts[index] ?? { allowed: true }
        })

        return Promise.resolve()
      },
    }
  }

  /** Stands in for a provider module, as in `externalSignIn.test.ts`. */
  const identityModule: KelpieModule = {
    id: 'test-identity',
    structural: true,

    register(context) {
      context.appRoute('POST', '/test-identity/complete', async (honoContext) => {
        const identity = (await honoContext.req.json()) as VerifiedIdentity
        const completed = await context.completeExternalSignIn(honoContext, identity)

        return honoContext.json({ user_id: completed.account.id, created: completed.created }, 200)
      })

      // The same, for a provider that catches the refusal to redirect on its reason.
      context.appRoute('POST', '/test-identity/complete-caught', async (honoContext) => {
        const identity = (await honoContext.req.json()) as VerifiedIdentity

        try {
          await context.completeExternalSignIn(honoContext, identity)
        } catch (error: unknown) {
          if (error instanceof ExternalSignInError) {
            return honoContext.json({ reason: error.reason, message: error.message }, 200)
          }

          throw error
        }

        return honoContext.json({ reason: null }, 200)
      })

      return Promise.resolve()
    },
  }

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
    verdicts = []
    holdGuard = undefined
    seen = []
    published = []

    const services = createTestServices({ db: database.db })
    services.events.subscribePrefix('auth.', (event) => {
      published.push(event)
    })

    harness = await createTestApp({
      modules: [...coreModules, guardModule('first-guard', 0), guardModule('second-guard', 1), identityModule],
      environment: TEST_ENVIRONMENT,
      services,
    })
  })

  function send(method: 'POST' | 'PATCH', path: string, body: unknown, cookie?: string): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Vitest',
          ...(cookie === undefined ? {} : { Cookie: cookie }),
        },
        body: JSON.stringify(body),
      }),
    )
  }

  function sessionCookieFrom(response: Response): string {
    const header = response.headers.get('Set-Cookie')

    if (header === null) {
      throw new Error('Expected a session cookie on the response')
    }

    return header.split(';')[0] ?? ''
  }

  async function accountEvents(): Promise<readonly AnyEventEnvelope[]> {
    await harness.services.events.drain()

    return published
  }

  async function userCount(): Promise<number> {
    return (await database.db.select({ id: users.id }).from(users)).length
  }

  describe('sign-up guard', () => {
    it('sees a password sign-up with the normalised address and never the password', async () => {
      const response = await send('POST', '/v1/auth/signup', SIGNUP)

      expect(response.status).toBe(201)
      expect(seen).toEqual([
        {
          guard: 'first-guard',
          attempt: { email: 'ada@example.com', name: 'Ada Lovelace', method: 'password', verifiedBy: null },
        },
        {
          guard: 'second-guard',
          attempt: { email: 'ada@example.com', name: 'Ada Lovelace', method: 'password', verifiedBy: null },
        },
      ])
      expect(JSON.stringify(seen)).not.toContain(SIGNUP.password)
    })

    it('refuses a password sign-up with the guard message and creates nothing', async () => {
      verdicts = [{ allowed: false, message: 'Try again in a minute' }]

      const response = await send('POST', '/v1/auth/signup', SIGNUP)

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: { code: 'forbidden', message: 'Try again in a minute' },
      })
      expect(response.headers.get('Set-Cookie')).toBeNull()
      expect(await userCount()).toBe(0)
      expect(harness.services.queuedJobs).toHaveLength(0)
      expect(await accountEvents()).toEqual([])
    })

    it('stops at the first rejection, so later guards do not run', async () => {
      verdicts = [{ allowed: false, message: 'First says no' }, { allowed: false, message: 'Second says no' }]

      const response = await send('POST', '/v1/auth/signup', SIGNUP)

      expect((await response.json()) as unknown).toMatchObject({ error: { message: 'First says no' } })
      expect(seen.map((entry) => entry.guard)).toEqual(['first-guard'])
    })

    it('lets a later guard refuse after an earlier one allowed', async () => {
      verdicts = [{ allowed: true }, { allowed: false, message: 'Second says no' }]

      const response = await send('POST', '/v1/auth/signup', SIGNUP)

      expect(response.status).toBe(403)
      expect(await userCount()).toBe(0)
    })

    it('runs after core refuses a short password, so it never sees that attempt', async () => {
      const response = await send('POST', '/v1/auth/signup', { ...SIGNUP, password: 'short' })

      expect(response.status).toBe(422)
      expect(seen).toEqual([])
    })

    it('sees a provisioning external sign-in with the verifying module', async () => {
      const response = await send('POST', '/test-identity/complete', IDENTITY)

      expect(response.status).toBe(200)
      expect(seen[0]?.attempt).toEqual({
        email: 'grace@example.com',
        name: 'Grace Hopper',
        method: 'external',
        verifiedBy: 'test-identity:acme',
      })
    })

    it('refuses a provisioning external sign-in with signup_refused and the guard message', async () => {
      verdicts = [{ allowed: false, message: 'Try again in a minute' }]

      const response = await send('POST', '/test-identity/complete', IDENTITY)

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: { code: 'forbidden', message: 'Try again in a minute' },
      })
      expect(await userCount()).toBe(0)
      expect(await accountEvents()).toEqual([])
    })

    it('hands a provider module the signup_refused reason and the guard message', async () => {
      verdicts = [{ allowed: false, message: 'Try again in a minute' }]

      const response = await send('POST', '/test-identity/complete-caught', IDENTITY)

      expect(await response.json()).toEqual({ reason: 'signup_refused', message: 'Try again in a minute' })
    })

    it('does not run for an external sign-in to an existing account, or for a login', async () => {
      await send('POST', '/test-identity/complete', IDENTITY)
      await send('POST', '/v1/auth/signup', SIGNUP)
      seen = []
      verdicts = [{ allowed: false, message: 'No new accounts' }]

      const linked = await send('POST', '/test-identity/complete', IDENTITY)
      const loggedIn = await send('POST', '/v1/auth/login', { email: SIGNUP.email, password: SIGNUP.password })

      expect(linked.status).toBe(200)
      expect(loggedIn.status).toBe(200)
      expect(seen).toEqual([])
    })

    it('turns a guard that throws into a 500 and creates nothing', async () => {
      const throwing: KelpieModule = {
        id: 'broken-guard',
        structural: true,
        register(context) {
          context.guardSignUp(() => Promise.reject(new Error('directory unreachable')))

          return Promise.resolve()
        },
      }

      harness = await createTestApp({
        modules: [...coreModules, throwing, identityModule],
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db }),
      })

      const response = await send('POST', '/v1/auth/signup', SIGNUP)
      const external = await send('POST', '/test-identity/complete', IDENTITY)

      expect(response.status).toBe(500)
      expect(external.status).toBe(500)
      expect(await userCount()).toBe(0)
      expect(harness.logLines.join('\n')).toContain('sign-up guard of module \\"broken-guard\\" failed')
    })
  })

  describe('account events', () => {
    it('publishes auth.user.created for a password sign-up, with no workspace', async () => {
      const response = await send('POST', '/v1/auth/signup', SIGNUP)
      const [user] = await database.db.select().from(users)

      expect(response.status).toBe(201)
      expect(await accountEvents()).toEqual([
        expect.objectContaining({
          name: 'auth.user.created',
          workspaceId: null,
          actor: { kind: 'user', id: user?.id },
          target: { type: 'user', id: user?.id },
          data: {
            userId: user?.id,
            email: 'ada@example.com',
            emailVerified: false,
            method: 'password',
            verifiedBy: null,
          },
        }),
      ])
    })

    it('publishes auth.user.created for a provisioning external sign-in only', async () => {
      await send('POST', '/test-identity/complete', IDENTITY)
      await send('POST', '/test-identity/complete', IDENTITY)

      const [user] = await database.db.select().from(users)

      expect(await accountEvents()).toEqual([
        expect.objectContaining({
          name: 'auth.user.created',
          workspaceId: null,
          data: {
            userId: user?.id,
            email: 'grace@example.com',
            emailVerified: true,
            method: 'external',
            verifiedBy: 'test-identity:acme',
          },
        }),
      ])
    })

    it('links the loser of two concurrent first external sign-ins, publishing one creation', async () => {
      let release: () => void = () => undefined
      holdGuard = new Promise<void>((resolve) => {
        release = resolve
      })

      // Both requests pass the lookup and reach the guard before either inserts.
      const first = send('POST', '/test-identity/complete', IDENTITY)
      const second = send('POST', '/test-identity/complete', IDENTITY)

      await expect.poll(() => seen.filter((entry) => entry.guard === 'first-guard').length).toBe(2)
      release()

      const responses = await Promise.all([first, second])
      const bodies = (await Promise.all(responses.map((response) => response.json()))) as {
        readonly user_id: string
        readonly created: boolean
      }[]

      expect(responses.map((response) => response.status)).toEqual([200, 200])
      expect(bodies.map((body) => body.created).sort()).toEqual([false, true])
      expect(bodies[0]?.user_id).toBe(bodies[1]?.user_id)
      expect(await userCount()).toBe(1)
      expect((await accountEvents()).map((event) => event.name)).toEqual(['auth.user.created'])
    })

    it('publishes nothing when a sign-up fails on an address already registered', async () => {
      await send('POST', '/v1/auth/signup', SIGNUP)
      await accountEvents()
      published = []

      const response = await send('POST', '/v1/auth/signup', SIGNUP)

      expect(response.status).toBe(409)
      expect(await accountEvents()).toEqual([])
    })

    it('publishes auth.user.email_changed when the address changes', async () => {
      const cookie = sessionCookieFrom(await send('POST', '/v1/auth/signup', SIGNUP))
      const [user] = await database.db.select().from(users)
      await accountEvents()
      published = []

      const response = await send(
        'PATCH',
        '/v1/account',
        { email: 'Ada.King@Example.com', current_password: SIGNUP.password },
        cookie,
      )

      expect(response.status).toBe(200)
      expect(await accountEvents()).toEqual([
        expect.objectContaining({
          name: 'auth.user.email_changed',
          workspaceId: null,
          actor: { kind: 'user', id: user?.id },
          target: { type: 'user', id: user?.id },
          data: {
            userId: user?.id,
            previousEmail: 'ada@example.com',
            email: 'ada.king@example.com',
            emailVerified: false,
          },
        }),
      ])
    })

    it('publishes nothing for the address already on file, or a name change', async () => {
      const cookie = sessionCookieFrom(await send('POST', '/v1/auth/signup', SIGNUP))
      await accountEvents()
      published = []

      const sameAddress = await send(
        'PATCH',
        '/v1/account',
        { email: 'ADA@example.com', current_password: SIGNUP.password },
        cookie,
      )
      const rotatedCookie = sessionCookieFrom(sameAddress)
      const renamed = await send('PATCH', '/v1/account', { name: 'Ada King' }, rotatedCookie)

      expect(sameAddress.status).toBe(200)
      expect(renamed.status).toBe(200)
      expect(await accountEvents()).toEqual([])
    })

    it('publishes nothing when the address change is refused', async () => {
      const cookie = sessionCookieFrom(await send('POST', '/v1/auth/signup', SIGNUP))
      await accountEvents()
      published = []

      const response = await send(
        'PATCH',
        '/v1/account',
        { email: 'ada.king@example.com', current_password: 'not it' },
        cookie,
      )

      expect(response.status).toBe(401)
      expect(await accountEvents()).toEqual([])

      const [stored] = await database.db.select().from(users).where(eq(users.email, 'ada@example.com'))
      expect(stored).toBeDefined()
    })
  })
})
