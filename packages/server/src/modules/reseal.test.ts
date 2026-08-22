import { randomBytes } from 'node:crypto'
import { Table, eq, getTableColumns, getTableName, is } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ConfigurationError, loadConfig } from '../lib/config.ts'
import type { KelpieConfig } from '../lib/config.ts'
import { createIdFactory } from '../lib/ids.ts'
import { createLogger } from '../lib/logger.ts'
import { SecretDecryptionError, createSecretCipher } from '../lib/secrets.ts'
import type { SecretCipher, SecretEncryptionConfig } from '../lib/secrets.ts'
import * as schema from '../schema/index.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { insertWorkspaceFixture } from '../testing/fixtures.ts'
import { RESEALED_COLUMNS, resealStoredSecrets, runReseal } from './reseal.ts'
import type { ResealOutcome, ResealPass } from './reseal.ts'
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

/**
 * The guard on the whole mechanism, and the reason it needs no database: a
 * sealed column missing from the pass costs nothing until a rotation a year
 * later reports success while stranding the value in it forever. That is far too
 * long a fuse to leave to a comment, so the schema is the source of truth and
 * this fails the day a column is added rather than the day it matters.
 */
describe('coverage of every sealed column', () => {
  /**
   * `_encrypted` is the convention every sealed column already follows. A column
   * sealed under another name would slip past, which is exactly what the message
   * on the failing assertion is for: it tells the next person the name matters.
   */
  const sealedInSchema: string[] = []

  // A for-loop rather than filter-then-map: the barrel exports plain string
  // constants alongside its tables, and no hand-written type predicate can
  // narrow that union to Table. Drizzle's own `is` narrows in an if.
  for (const exported of Object.values(schema)) {
    if (!is(exported, Table)) {
      continue
    }

    for (const column of Object.values(getTableColumns(exported))) {
      if (column.name.endsWith('_encrypted')) {
        sealedInSchema.push(`${getTableName(exported)}.${column.name}`)
      }
    }
  }

  it('re-seals every _encrypted column in the schema', () => {
    expect(RESEALED_COLUMNS.toSorted()).toEqual(sealedInSchema.toSorted())
  })

  /** Guards the guard: a scan that matched nothing would pass forever. */
  it('finds the columns it is scanning for', () => {
    expect(sealedInSchema).toContain('webhooks.secret_encrypted')
    expect(sealedInSchema.length).toBeGreaterThanOrEqual(3)
  })
})

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

  it('names every column, so a report says where the trouble is', async () => {
    await insertWebhook('whsec_rotate_me', underPrevious)

    const outcome = await resealStoredSecrets(database.db, rotating)

    expect(outcome.columns.map((column) => column.label)).toEqual(RESEALED_COLUMNS)
  })

  /**
   * Most sealed columns hold nothing yet: a webhook that has never rotated has
   * no previous secret, and two modules have the column but write no secret at
   * all. They must report zero rather than be skipped, because "examined 0" is
   * what tells an operator the column was covered.
   */
  it('reports a column whose rows all hold no secret', async () => {
    await insertWebhook('whsec_rotate_me', underPrevious)

    const outcome = await resealStoredSecrets(database.db, rotating)
    const empty = outcome.columns.filter((column) => column.label !== 'webhooks.secret_encrypted')

    // Derived, not a literal: adding a sealed column should not fail this test
    // for the wrong reason. `coverage of every sealed column` owns the count.
    expect(empty).toHaveLength(RESEALED_COLUMNS.length - 1)
    expect(empty.every((column) => column.examined === 0 && column.resealed === 0)).toBe(true)
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

  /**
   * A webhook mid-rotation holds two sealed secrets. Both have to survive a
   * `SECRET_ENCRYPTION_KEY` change, or the overlap window silently stops
   * covering the receiver it was opened for.
   */
  it('re-seals a previous secret alongside the current one', async () => {
    const id = await insertWebhook('whsec_current', underPrevious)

    await database.db
      .update(webhooks)
      .set({
        previousSecretEncrypted: underPrevious.seal('whsec_retired'),
        previousSecretExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(webhooks.id, id))

    const outcome = await resealStoredSecrets(database.db, rotating)

    expect(outcome.resealed).toBe(2)

    const [row] = await database.db
      .select({
        current: webhooks.secretEncrypted,
        previous: webhooks.previousSecretEncrypted,
      })
      .from(webhooks)
      .where(eq(webhooks.id, id))

    expect(settled.open(row?.current ?? '')).toBe('whsec_current')
    expect(settled.open(row?.previous ?? '')).toBe('whsec_retired')
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

/**
 * The script wrapper both assemblies (base and cloud) call.
 *
 * A separate describe rather than more assertions on the pass above: this
 * covers the config-branch logic, the pass composition, the exit code and
 * the printed report — everything the wrapper contributes on top of the
 * pass function.
 */
describe.skipIf(connectionString === undefined)('runReseal', () => {
  let database: TestDatabase
  const silentLogger = createLogger({ level: 'error', transports: [] })

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
  })

  /**
   * A minimal `KelpieConfig` for the wrapper. `loadConfig` needs a full env,
   * so the tests inline what would otherwise take a fixture: the fields
   * `runReseal` reads are `databaseUrl`, `secretEncryption`, and `env`; the
   * rest are supplied only to satisfy the shape.
   */
  function buildConfig(overrides: {
    readonly secretEncryption?: SecretEncryptionConfig
    readonly env?: Record<string, string | undefined>
  } = {}): KelpieConfig {
    if (connectionString === undefined) {
      throw new Error('unreachable: skipped without a connection string')
    }

    const base = loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: connectionString,
      LOG_LEVEL: 'error',
      EMAIL_PROVIDER: 'log',
      EMAIL_FROM: 'kelpie@example.test',
    })

    return {
      ...base,
      env: overrides.env ?? {},
      secretEncryption: overrides.secretEncryption,
    }
  }

  /** Captured stdout/stderr, so a test can assert against what the operator would see. */
  function makeSinks() {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      report: (message: string) => out.push(message),
      reportFatal: (message: string) => err.push(message),
    }
  }

  it('uses config.secretEncryption when set, and ignores config.env', async () => {
    const sinks = makeSinks()
    const config = buildConfig({
      secretEncryption: {
        SECRET_ENCRYPTION_KEY: CURRENT_KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
      },
      // Deliberately broken. The preferred branch means this is never read;
      // if it were, the schema would throw and the test would fail loudly.
      env: { SECRET_ENCRYPTION_KEY: 'not-a-base64-key' },
    })

    const exit = await runReseal({ config, logger: silentLogger, ...sinks })

    expect(exit).toBe(0)
    // The composed report starts with each column line, then a summary.
    expect(sinks.out.some((line) => line.includes('webhooks.secret_encrypted'))).toBe(true)
  })

  it('falls back to parsing config.env when config.secretEncryption is undefined', async () => {
    const sinks = makeSinks()
    const config = buildConfig({
      env: {
        SECRET_ENCRYPTION_KEY: CURRENT_KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
      },
    })

    const exit = await runReseal({ config, logger: silentLogger, ...sinks })

    expect(exit).toBe(0)
  })

  it('throws ConfigurationError listing every issue when neither source is valid', async () => {
    const config = buildConfig({ env: { SECRET_ENCRYPTION_KEY: 'not-a-base64-key' } })

    await expect(runReseal({ config, logger: silentLogger })).rejects.toBeInstanceOf(
      ConfigurationError,
    )
  })

  it('warns when SECRET_ENCRYPTION_KEY_PREVIOUS is unset', async () => {
    const sinks = makeSinks()
    const config = buildConfig({
      secretEncryption: { SECRET_ENCRYPTION_KEY: CURRENT_KEY },
    })

    await runReseal({ config, logger: silentLogger, ...sinks })

    expect(sinks.out.some((line) => line.includes('SECRET_ENCRYPTION_KEY_PREVIOUS is not set'))).toBe(
      true,
    )
  })

  it('runs extraPasses after core and sums their outcomes into the summary', async () => {
    const sinks = makeSinks()
    const config = buildConfig({
      secretEncryption: {
        SECRET_ENCRYPTION_KEY: CURRENT_KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
      },
    })

    // A pass that names one column with three examined and one re-sealed,
    // so the report line and totals can only come from summing across passes.
    const extraPass: ResealPass = async (): Promise<ResealOutcome> => ({
      columns: [{ label: 'made_up_module.made_up_column', examined: 3, resealed: 1, unreadable: [] }],
      examined: 3,
      resealed: 1,
      unreadable: 0,
    })

    const exit = await runReseal({
      config,
      logger: silentLogger,
      extraPasses: [extraPass],
      ...sinks,
    })

    expect(exit).toBe(0)
    expect(sinks.out.some((line) => line.includes('made_up_module.made_up_column: 3 examined, 1 re-sealed'))).toBe(true)
    // Every _encrypted column plus one extra: the totals summary is derived, so
    // an extra pass' `examined: 3` must surface in it.
    expect(sinks.out.some((line) => line.includes('Re-sealed 1 of 3'))).toBe(true)
  })

  it('returns 1 when any pass reports an unreadable row, and lists the ids', async () => {
    const sinks = makeSinks()
    const config = buildConfig({
      secretEncryption: {
        SECRET_ENCRYPTION_KEY: CURRENT_KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
      },
    })

    const failing: ResealPass = async (): Promise<ResealOutcome> => ({
      columns: [{ label: 'made_up.col', examined: 1, resealed: 0, unreadable: ['row_stranded'] }],
      examined: 1,
      resealed: 0,
      unreadable: 1,
    })

    const exit = await runReseal({
      config,
      logger: silentLogger,
      extraPasses: [failing],
      ...sinks,
    })

    expect(exit).toBe(1)
    expect(sinks.err.some((line) => line.includes('row_stranded'))).toBe(true)
  })

  it('returns 0 when every pass is clean', async () => {
    const sinks = makeSinks()
    const config = buildConfig({
      secretEncryption: {
        SECRET_ENCRYPTION_KEY: CURRENT_KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
      },
    })

    const exit = await runReseal({ config, logger: silentLogger, ...sinks })

    expect(exit).toBe(0)
    expect(sinks.err).toEqual([])
  })
})
