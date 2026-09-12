import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createIdFactory } from '../lib/ids.ts'
import { createLogger } from '../lib/logger.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { insertWorkspaceFixture } from '../testing/fixtures.ts'
import type { WorkspaceFixture } from '../testing/fixtures.ts'
import { createJobsRuntime } from './jobs.ts'
import type { JobsRuntime } from './jobs.ts'
import { createEventBus } from './events.ts'
import { createTransactionScope } from './transaction.ts'

/**
 * End-to-end tests for the pg-boss-backed jobs port. Each test builds a
 * fresh runtime and closes it before the next one runs, so a handler
 * defined by one test never fires against another test's rows.
 *
 * The shared `TestDatabase` migrates pg-boss's schema once at suite start,
 * so per-test setup is limited to `truncateAll` (which clears `pgboss.job`
 * too).
 */

const connectionString = testDatabaseUrl(process.env)
const silentLogger = createLogger({ level: 'error', transports: [] })
const createId = createIdFactory()

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { budgetMs = 5_000, intervalMs = 50 } = {},
): Promise<void> {
  const started = Date.now()

  while (Date.now() - started < budgetMs) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`predicate never became true within ${budgetMs}ms`)
}

describe.skipIf(connectionString === undefined)('jobs runtime (pg-boss)', () => {
  let database: TestDatabase
  let fixture: WorkspaceFixture

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
    fixture = await insertWorkspaceFixture(database.db)
  })

  function buildRuntime(): JobsRuntime {
    if (connectionString === undefined) {
      throw new Error('unreachable: suite skips when no connection string')
    }
    return createJobsRuntime({
      connectionString,
      logger: silentLogger,
      pollingIntervalSeconds: 0.5,
    })
  }

  function scopeFor(runtime: JobsRuntime): ReturnType<typeof createTransactionScope> {
    return createTransactionScope({
      db: database.db,
      bus: createEventBus(silentLogger),
      logger: silentLogger,
      createId,
      enqueueOnTx: runtime.enqueueOnTx,
    })
  }

  it('rejects a second define of the same name', () => {
    const runtime = buildRuntime()

    const definition = {
      name: 'jobs.define-twice',
      schema: z.object({}).strict(),
      handler: async () => undefined,
    }

    runtime.registry.define(definition)
    expect(() => runtime.registry.define(definition)).toThrow(/defined twice/)
  })

  it('commits the job with the surrounding transaction', async () => {
    const runtime = buildRuntime()
    const handle = runtime.registry.define({
      name: 'jobs.commit',
      schema: z.object({ workspaceId: z.string() }).strict(),
      handler: async () => undefined,
    })

    await runtime.start()

    try {
      const scope = scopeFor(runtime)

      await scope(
        async ({ jobs }) => {
          await jobs.enqueue(handle, { workspaceId: fixture.workspaceId })
        },
        { workspaceId: fixture.workspaceId },
      )

      const rows = await database.db.execute<{ count: string }>(
        sql`select count(*)::text as count from pgboss.job where name = 'jobs.commit'`,
      )
      expect(rows[0]?.count).toBe('1')
    } finally {
      await runtime.stop()
    }
  })

  it('rolls the enqueue back with the transaction', async () => {
    const runtime = buildRuntime()
    const handle = runtime.registry.define({
      name: 'jobs.rollback',
      schema: z.object({}).strict(),
      handler: async () => undefined,
    })

    await runtime.start()

    try {
      const scope = scopeFor(runtime)

      await expect(
        scope(
          async ({ jobs }) => {
            await jobs.enqueue(handle, {})
            throw new Error('rollback me')
          },
          { workspaceId: fixture.workspaceId },
        ),
      ).rejects.toThrow('rollback me')

      const rows = await database.db.execute<{ count: string }>(
        sql`select count(*)::text as count from pgboss.job where name = 'jobs.rollback'`,
      )
      expect(rows[0]?.count).toBe('0')
    } finally {
      await runtime.stop()
    }
  })

  it('runs the handler once per enqueued job', async () => {
    const runtime = buildRuntime()
    const seen: unknown[] = []
    const handle = runtime.registry.define({
      name: 'jobs.happy',
      schema: z.object({ note: z.string() }).strict(),
      handler: async ({ data }) => {
        seen.push(data)
      },
    })

    await runtime.start()
    await runtime.startWorking()

    try {
      const scope = scopeFor(runtime)

      await scope(
        async ({ jobs }) => {
          await jobs.enqueue(handle, { note: 'hello' })
        },
        { workspaceId: fixture.workspaceId },
      )

      await waitFor(() => seen.length === 1)
      expect(seen).toEqual([{ note: 'hello' }])
    } finally {
      await runtime.stop()
    }
  })

  it('retries a failing job then routes it to the dead-letter queue', async () => {
    const runtime = buildRuntime()
    let attempts = 0
    const handle = runtime.registry.define({
      name: 'jobs.retry',
      schema: z.object({}).strict(),
      handler: async () => {
        attempts += 1
        throw new Error('always fails')
      },
      // retryLimit: 1 means one retry after the first try — up to 2 runs.
      defaults: { retryLimit: 1, retryDelay: 0 },
    })

    await runtime.start()
    await runtime.startWorking()

    try {
      const scope = scopeFor(runtime)

      await scope(
        async ({ jobs }) => {
          await jobs.enqueue(handle, {})
        },
        { workspaceId: fixture.workspaceId },
      )

      await waitFor(
        async () => {
          const rows = await database.db.execute<{ count: string }>(
            sql`select count(*)::text as count from pgboss.job where name = 'jobs.retry.dead'`,
          )
          return rows[0]?.count === '1'
        },
        { budgetMs: 10_000 },
      )

      expect(attempts).toBe(2)
    } finally {
      await runtime.stop()
    }
  })

  it('drains in-flight work when stop() is called', async () => {
    const runtime = buildRuntime()

    let released: (() => void) | undefined
    const handlerStarted = new Promise<void>((resolve) => {
      released = resolve
    })
    let handlerFinished = false

    const handle = runtime.registry.define({
      name: 'jobs.drain',
      schema: z.object({}).strict(),
      handler: async () => {
        released?.()
        await new Promise((resolve) => setTimeout(resolve, 200))
        handlerFinished = true
      },
    })

    await runtime.start()
    await runtime.startWorking()

    const scope = scopeFor(runtime)
    await scope(
      async ({ jobs }) => {
        await jobs.enqueue(handle, {})
      },
      { workspaceId: fixture.workspaceId },
    )

    // Wait until the handler has actually started before stopping.
    await handlerStarted
    await runtime.stop()

    expect(handlerFinished).toBe(true)
  })
})
