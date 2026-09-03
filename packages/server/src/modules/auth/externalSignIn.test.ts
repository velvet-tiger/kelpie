import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { KelpieModule, VerifiedIdentity } from '../../runtime/module.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import type { TestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { sessions, users } from './schema.ts'

/**
 * `completeExternalSignIn`, the way a provider module reaches it.
 *
 * Driven through a fixture module rather than by calling the service, because
 * the point of the extension point is the whole path: a module's own route,
 * core minting the session, and the browser leaving with a working cookie.
 * Core carries no identity provider of its own, so the fixture stands in for
 * the cloud's.
 */

const connectionString = testDatabaseUrl(process.env)

const IDENTITY: VerifiedIdentity = {
  email: 'Ada@Example.com',
  emailVerified: true,
  name: 'Ada Lovelace',
  verifiedBy: 'test-identity:acme',
  provision: 'create',
}

const PASSWORD = 'correct horse battery staple'

/** What `logIn` hashes when it has no stored hash to compare against. */
const TIMING_PLACEHOLDER = 'not-a-real-password-placeholder'

/**
 * Stands in for a provider module: takes an identity as a body and hands it
 * straight to core, exactly as an OAuth callback would once it has verified one.
 */
const identityModule: KelpieModule = {
  id: 'test-identity',
  structural: true,

  register(context) {
    context.appRoute('POST', '/test-identity/complete', async (honoContext) => {
      const identity = (await honoContext.req.json()) as VerifiedIdentity
      const completed = await context.completeExternalSignIn(honoContext, identity)

      return honoContext.json(
        { user_id: completed.account.id, created: completed.created },
        200,
      )
    })

    return Promise.resolve()
  },
}

describe.skipIf(connectionString === undefined)('external sign-in', () => {
  let database: TestDatabase
  let harness: TestApp
  let services: TestServices

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
    services = createTestServices({ db: database.db })
    harness = await createTestApp({
      modules: [...coreModules, identityModule],
      environment: TEST_ENVIRONMENT,
      services,
    })
  })

  function post(path: string, body: unknown, cookie?: string): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Vitest',
          ...(cookie === undefined ? {} : { Cookie: cookie }),
        },
        body: JSON.stringify(body),
      }),
    )
  }

  function patch(path: string, body: unknown, cookie?: string): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(cookie === undefined ? {} : { Cookie: cookie }),
        },
        body: JSON.stringify(body),
      }),
    )
  }

  function get(path: string, cookie?: string): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, { headers: cookie === undefined ? {} : { Cookie: cookie } }),
    )
  }

  function sessionCookieFrom(response: Response): string {
    const header = response.headers.get('Set-Cookie')

    if (header === null) {
      throw new Error('Expected a session cookie on the response')
    }

    return header.split(';')[0] ?? ''
  }

  function signIn(identity: Partial<VerifiedIdentity> = {}): Promise<Response> {
    return post('/test-identity/complete', { ...IDENTITY, ...identity })
  }

  async function readBody(response: Response): Promise<Record<string, unknown>> {
    const payload: unknown = await response.json()

    if (typeof payload !== 'object' || payload === null) {
      throw new Error(`Expected an object body, got ${JSON.stringify(payload)}`)
    }

    return payload as Record<string, unknown>
  }

  async function userRow(email = 'ada@example.com'): Promise<typeof users.$inferSelect> {
    const [row] = await database.db.select().from(users).where(eq(users.email, email))

    if (row === undefined) {
      throw new Error(`No user row for ${email}`)
    }

    return row
  }

  describe('an address core has never seen', () => {
    it('provisions a verified account with no password and signs the browser in', async () => {
      const before = services.sentEmails.length
      const response = await signIn()

      expect(response.status).toBe(200)
      expect((await readBody(response)).created).toBe(true)

      const user = await userRow()
      expect(user.passwordHash).toBeNull()
      expect(user.emailVerifiedAt).not.toBeNull()
      expect(user.name).toBe('Ada Lovelace')
      // The provider proved control of the address, so there is nothing to confirm.
      expect(services.sentEmails.length).toBe(before)
    })

    it('issues a session the rest of the API accepts', async () => {
      const cookie = sessionCookieFrom(await signIn())
      const me = await get('/v1/auth/me', cookie)

      expect(me.status).toBe(200)
      expect((await readBody(me)).workspace_id).toBeNull()
    })

    it('records which module signed the session in', async () => {
      const cookie = sessionCookieFrom(await signIn())
      const listed = await get('/v1/auth/sessions', cookie)
      const body = await readBody(listed)
      const [first] = body.data as Record<string, unknown>[]

      expect(first?.signed_in_via).toBe('test-identity:acme')
    })

    // The local part of the stored address, so lowercase: guessing at
    // capitalisation would be inventing a name rather than falling back to one.
    it('falls back to the local part of the address when the provider sends no name', async () => {
      await signIn({ name: null })

      expect((await userRow()).name).toBe('ada')
    })

    it('is refused when the module asks for provision: refuse', async () => {
      const response = await signIn({ provision: 'refuse' })

      expect(response.status).toBe(403)
      expect(response.headers.get('Set-Cookie')).toBeNull()
    })
  })

  describe('an identity the provider did not verify', () => {
    it('is refused whatever the module asked for', async () => {
      const response = await signIn({ emailVerified: false })

      expect(response.status).toBe(401)
      expect(response.headers.get('Set-Cookie')).toBeNull()
    })
  })

  describe('an address that already has an account', () => {
    async function signUpWithPassword(): Promise<string> {
      const response = await post('/v1/auth/signup', {
        email: IDENTITY.email,
        name: IDENTITY.name,
        password: PASSWORD,
      })
      expect(response.status).toBe(201)

      return sessionCookieFrom(response)
    }

    it('signs in to the same account rather than making a second one', async () => {
      await signUpWithPassword()
      const existing = await userRow()

      const response = await signIn()
      const body = await readBody(response)

      expect(body.created).toBe(false)
      expect(body.user_id).toBe(existing.id)
    })

    it('verifies the address, because the provider proved control of it', async () => {
      await signUpWithPassword()
      await signIn()

      expect((await userRow()).emailVerifiedAt).not.toBeNull()
    })

    /**
     * The pre-registration takeover case: somebody registered this address with
     * a password and never proved they own it. Signing in through the provider
     * proves the opposite, so that password and its sessions go.
     */
    it('clears the password and every session of an unverified account', async () => {
      const attackerCookie = await signUpWithPassword()

      await signIn()

      expect((await userRow()).passwordHash).toBeNull()
      expect((await get('/v1/auth/me', attackerCookie)).status).toBe(401)
    })

    it('leaves a verified account its password', async () => {
      const cookie = await signUpWithPassword()
      // Verify it the way the API does, so this is a genuinely verified account.
      const [token] = await database.db
        .select()
        .from(users)
        .where(eq(users.email, 'ada@example.com'))
      expect(token).toBeDefined()
      await database.db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.email, 'ada@example.com'))

      await signIn()

      expect((await userRow()).passwordHash).not.toBeNull()
      // The original session survives: nothing about this sign-in was suspicious.
      expect((await get('/v1/auth/me', cookie)).status).toBe(200)
    })
  })

  describe('an account with no password', () => {
    async function provision(): Promise<string> {
      return sessionCookieFrom(await signIn())
    }

    it('refuses password sign-in', async () => {
      await provision()

      const response = await post('/v1/auth/login', {
        email: IDENTITY.email,
        password: PASSWORD,
      })

      expect(response.status).toBe(401)
    })

    /**
     * The guard is the null check, not the placeholder hash `logIn` compares
     * against when it has none. Without it, whoever knew that string would sign
     * in to every passwordless account.
     */
    it('refuses the placeholder the timing-safe path hashes', async () => {
      await provision()

      const response = await post('/v1/auth/login', {
        email: IDENTITY.email,
        password: TIMING_PLACEHOLDER,
      })

      expect(response.status).toBe(401)
    })

    it('refuses a password change, because there is no current password to check', async () => {
      const cookie = await provision()

      const response = await patch(
        '/v1/auth/password',
        { current_password: TIMING_PLACEHOLDER, new_password: 'a brand new long password' },
        cookie,
      )

      expect(response.status).toBe(401)
    })

    it('refuses an email change for the same reason', async () => {
      const cookie = await provision()

      const response = await patch(
        '/v1/account',
        { email: 'ada@other.test', current_password: TIMING_PLACEHOLDER },
        cookie,
      )

      expect(response.status).toBe(401)
    })

    it('can set a first password through the reset flow, and then sign in with it', async () => {
      await provision()

      const requested = await post('/v1/auth/password-reset', { email: IDENTITY.email })
      expect(requested.status).toBe(202)

      const sent = services.sentEmails.at(-1)
      const token = /token=([\w-]+)/u.exec(sent?.body ?? '')?.[1]
      expect(token).toBeDefined()

      const confirmed = await post('/v1/auth/password-reset/confirm', {
        token,
        password: 'a first password at last',
      })
      expect(confirmed.status).toBe(204)

      const signedIn = await post('/v1/auth/login', {
        email: IDENTITY.email,
        password: 'a first password at last',
      })
      expect(signedIn.status).toBe(200)
    })
  })

  describe('a password sign-in', () => {
    it('records no module on its session', async () => {
      const response = await post('/v1/auth/signup', {
        email: 'grace@example.com',
        name: 'Grace Hopper',
        password: PASSWORD,
      })
      const cookie = sessionCookieFrom(response)

      const [row] = await database.db.select().from(sessions)
      expect(row?.signedInVia).toBeNull()

      // And the wire says so too, so the page has something to branch on.
      const listed = await get('/v1/auth/sessions', cookie)
      const [first] = (await readBody(listed)).data as Record<string, unknown>[]
      expect(first?.signed_in_via).toBeNull()
    })
  })
})
