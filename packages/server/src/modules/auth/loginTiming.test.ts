import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { users } from './schema.ts'

/**
 * A login must do the same password work whether the address has an account
 * or not. A clock is not a reliable test of that, so this suite counts the
 * argon2 operations: the real ones run, and each call is recorded.
 */

const argon2Calls = vi.hoisted(() => ({ hash: 0, verify: 0 }))

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>()

  return {
    ...actual,
    hash: (...parameters: Parameters<typeof actual.hash>) => {
      argon2Calls.hash += 1

      return actual.hash(...parameters)
    },
    verify: (...parameters: Parameters<typeof actual.verify>) => {
      argon2Calls.verify += 1

      return actual.verify(...parameters)
    },
  }
})

const connectionString = testDatabaseUrl(process.env)

const EMAIL = 'ada@example.com'
const PASSWORD = 'correct horse battery staple'

describe.skipIf(connectionString === undefined)('login password work', () => {
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

  function post(path: string, body: unknown): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  beforeEach(async () => {
    await database.truncateAll()
    harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })

    const signup = await post('/v1/auth/signup', { email: EMAIL, name: 'Ada', password: PASSWORD })

    expect(signup.status).toBe(201)
  })

  /** The argon2 operations one login attempt runs. */
  async function workOf(email: string, password: string): Promise<{ status: number; hash: number; verify: number }> {
    argon2Calls.hash = 0
    argon2Calls.verify = 0

    const response = await post('/v1/auth/login', { email, password })

    return { status: response.status, hash: argon2Calls.hash, verify: argon2Calls.verify }
  }

  it('does one verify and no hash for a wrong password, an unknown address and an account with no password', async () => {
    const wrongPassword = await workOf(EMAIL, 'wrong password!')
    const unknownAddress = await workOf('nobody@example.com', 'wrong password!')

    await database.db.update(users).set({ passwordHash: null }).where(eq(users.email, EMAIL))

    const noPassword = await workOf(EMAIL, PASSWORD)

    const expected = { status: 401, hash: 0, verify: 1 }

    expect(wrongPassword).toEqual(expected)
    expect(unknownAddress).toEqual(expected)
    expect(noPassword).toEqual(expected)
  })

  it('does the same work for the right password', async () => {
    expect(await workOf(EMAIL, PASSWORD)).toEqual({ status: 200, hash: 0, verify: 1 })
  })
})
