import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createIdFactory } from '../lib/ids.ts'
import { SecretDecryptionError, createSecretCipher } from '../lib/secrets.ts'
import type { SecretCipher } from '../lib/secrets.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { insertWorkspaceFixture } from '../testing/fixtures.ts'
import { resealStoredSecrets } from './reseal.ts'
import { webhooks } from './webhooks/schema.ts'

/**
 * Rotating `SECRET_ENCRYPTION_KEY` against real rows.
 *
 * The unit tests in `lib/secrets.test.ts` cover the cipher. This covers what an
 * operator actually runs: reading every sealed column, rewriting what is stale,
 * and reporting what it could not open.
 */

const connectionString = testDatabaseUrl(process.env)
const createId = createIdFactory()

const CURRENT_KEY = randomBytes(32).toString('base64')
const PREVIOUS_KEY = randomBytes(32).toString('base64')
const STRANGER_KEY = randomBytes(32).toString('base64')

/** What the service runs as mid-rotation. */
const rotating = createSecretCipher({
  SECRET_ENCRYPTION_KEY: CURRENT_KEY,
  SECRET_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
})

/** What it runs as once the rotation is finished and the old key is removed. */
const settled = createSecretCipher({ SECRET_ENCRYPTION_KEY: CURRENT_KEY })

const underPrevious = createSecretCipher({ SECRET_ENCRYPTION_KEY: PREVIOUS_KEY })
const underStranger = createSecretCipher({ SECRET_ENCRYPTION_KEY: STRANGER_KEY })

describe.skipIf(connectionString === undefined)('re-sealing stored secrets', () => {
  let database: TestDatabase
  let workspaceId: string

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
    workspaceId = (await insertWorkspaceFixture(database.db)).workspaceId
  })

  /** @returns The webhook's id. */
  async function insertWebhook(secret: string, cipher: SecretCipher): Promise<string> {
    const id = createId('webhook')

    await database.db.insert(webhooks).values({
      id,
      workspaceId,
      url: 'https://example.com/hooks/kelpie',
      events: ['record.created'],
      secretEncrypted: cipher.seal(secret),
      secretPrefix: `whsec_…${secret.slice(-4)}`,
    })

    return id
  }

  async function storedSecret(id: string): Promise<string> {
    const [row] = await database.db
      .select({ sealed: webhooks.secretEncrypted })
      .from(webhooks)
      .where(eq(webhooks.id, id))

    if (row === undefined) {
      throw new Error(`No webhook ${id}`)
    }

    return row.sealed
  }

  it('rewrites a secret sealed under the previous key, and keeps the plaintext', async () => {
    const id = await insertWebhook('whsec_rotate_me', underPrevious)

    const outcome = await resealStoredSecrets(database.db, rotating)

    expect(outcome.examined).toBe(1)
    expect(outcome.resealed).toBe(1)
    expect(outcome.unreadable).toBe(0)

    // The whole point: readable with the current key alone, so the previous one
    // can come out of the environment. And it is the same secret, or every
    // receiver's signature check would start failing.
    expect(settled.open(await storedSecret(id))).toBe('whsec_rotate_me')
  })

  it('writes nothing for a secret already under the current key', async () => {
    const id = await insertWebhook('whsec_already_current', settled)
    const before = await storedSecret(id)

    const outcome = await resealStoredSecrets(database.db, rotating)

    expect(outcome.examined).toBe(1)
    expect(outcome.resealed).toBe(0)
    // Byte-identical, not merely equivalent: a rewrite would mean a fresh IV.
    expect(await storedSecret(id)).toBe(before)
  })

  /** An operator who is unsure whether it ran should be able to just run it. */
  it('is idempotent: a second pass has nothing to do', async () => {
    await insertWebhook('whsec_rotate_me', underPrevious)

    const first = await resealStoredSecrets(database.db, rotating)
    const second = await resealStoredSecrets(database.db, rotating)

    expect(first.resealed).toBe(1)
    expect(second.resealed).toBe(0)
    expect(second.examined).toBe(1)
  })

  /**
   * One unrecoverable row must not strand every other one. The pass reports it
   * and carries on, because re-running would otherwise hit the same row first
   * and never reach the rest.
   */
  it('reports a secret it cannot open and still re-seals the others', async () => {
    const lost = await insertWebhook('whsec_lost', underStranger)
    const recoverable = await insertWebhook('whsec_rotate_me', underPrevious)

    const outcome = await resealStoredSecrets(database.db, rotating)

    expect(outcome.examined).toBe(2)
    expect(outcome.resealed).toBe(1)
    expect(outcome.columns[0]?.unreadable).toEqual([lost])
    expect(settled.open(await storedSecret(recoverable))).toBe('whsec_rotate_me')
  })

  it('does not touch a row it cannot open', async () => {
    const lost = await insertWebhook('whsec_lost', underStranger)
    const before = await storedSecret(lost)

    await resealStoredSecrets(database.db, rotating)

    expect(await storedSecret(lost)).toBe(before)
  })

  it('names the column, so a report says where the trouble is', async () => {
    await insertWebhook('whsec_rotate_me', underPrevious)

    const outcome = await resealStoredSecrets(database.db, rotating)

    expect(outcome.columns.map((column) => column.label)).toEqual(['webhooks.secret_encrypted'])
  })

  /**
   * Running with no previous key configured is the accident worth surviving: it
   * must report the problem rather than rewrite anything under a key that
   * cannot open it.
   */
  it('reports everything unreadable when the previous key is missing', async () => {
    await insertWebhook('whsec_rotate_me', underPrevious)

    const outcome = await resealStoredSecrets(database.db, settled)

    expect(outcome.resealed).toBe(0)
    expect(outcome.unreadable).toBe(1)
  })

  it('handles an empty table', async () => {
    const outcome = await resealStoredSecrets(database.db, rotating)

    expect(outcome).toMatchObject({ examined: 0, resealed: 0, unreadable: 0 })
  })

  /** A row corrupted in the database is not a wrong-key problem, and says so. */
  it('reports an altered row rather than throwing out of the pass', async () => {
    const id = await insertWebhook('whsec_rotate_me', underPrevious)

    await database.db
      .update(webhooks)
      .set({ secretEncrypted: 'not-a-sealed-value' })
      .where(eq(webhooks.id, id))

    const outcome = await resealStoredSecrets(database.db, rotating)

    expect(outcome.unreadable).toBe(1)
    expect(() => rotating.open('not-a-sealed-value')).toThrow(SecretDecryptionError)
  })
})
