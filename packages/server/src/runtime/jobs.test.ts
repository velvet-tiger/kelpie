import { sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
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
      superviseIntervalSeconds: 1,
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

  it('tells the handler which run is the last one', async () => {
    const runtime = buildRuntime()
    const seen: (boolean | undefined)[] = []
    const handle = runtime.registry.define({
      name: 'jobs.last-attempt',
      schema: z.object({}).strict(),
      handler: async ({ lastAttempt }) => {
        seen.push(lastAttempt)
        throw new Error('always fails')
      },
      // Two retries after the first run: three runs.
      defaults: { retryLimit: 2, retryDelay: 0 },
    })
    const once = runtime.registry.define({
      name: 'jobs.last-attempt-no-retry',
      schema: z.object({}).strict(),
      handler: async ({ lastAttempt }) => {
        seen.push(lastAttempt)
      },
      defaults: { retryLimit: 0 },
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
            sql`select count(*)::text as count from pgboss.job where name = 'jobs.last-attempt.dead'`,
          )
          return rows[0]?.count === '1'
        },
        { budgetMs: 10_000 },
      )

      // Only the run after which the queue gave up was the last one.
      expect(seen).toEqual([false, false, true])

      // A job with no retry: its first run is its last.
      seen.length = 0
      await scope(
        async ({ jobs }) => {
          await jobs.enqueue(once, {})
        },
        { workspaceId: fixture.workspaceId },
      )
      await waitFor(() => seen.length === 1)

      expect(seen).toEqual([true])
    } finally {
      await runtime.stop()
    }
  })

  it('counts the runs of a job in attempt, from 1', async () => {
    const runtime = buildRuntime()
    const seen: (number | undefined)[] = []
    const handle = runtime.registry.define({
      name: 'jobs.attempt',
      schema: z.object({}).strict(),
      handler: async ({ attempt }) => {
        seen.push(attempt)
        throw new Error('always fails')
      },
      defaults: { retryLimit: 2, retryDelay: 0 },
    })

    await runtime.start()
    await runtime.startWorking()

    try {
      await scopeFor(runtime)(
        async ({ jobs }) => {
          await jobs.enqueue(handle, {})
        },
        { workspaceId: fixture.workspaceId },
      )

      await waitFor(() => seen.length === 3, { budgetMs: 10_000 })

      expect(seen).toEqual([1, 2, 3])
    } finally {
      await runtime.stop()
    }
  })

  it('stores the group a job is enqueued with', async () => {
    const runtime = buildRuntime()
    const handle = runtime.registry.define({
      name: 'jobs.group',
      schema: z.object({}).strict(),
      handler: async () => undefined,
    })

    await runtime.start()

    try {
      await scopeFor(runtime)(
        async ({ jobs }) => {
          await jobs.enqueue(handle, {}, { group: { id: 'ws_a', tier: 'gold' } })
          await jobs.enqueue(handle, {}, { group: { id: 'ws_b' } })
          await jobs.enqueue(handle, {})
        },
        { workspaceId: fixture.workspaceId },
      )

      const rows = await database.db.execute<{ group_id: string | null; group_tier: string | null }>(
        sql`select group_id, group_tier from pgboss.job where name = 'jobs.group' order by group_id nulls last`,
      )

      expect([...rows]).toEqual([
        { group_id: 'ws_a', group_tier: 'gold' },
        { group_id: 'ws_b', group_tier: null },
        { group_id: null, group_tier: null },
      ])
    } finally {
      await runtime.stop()
    }
  })

  it('runs no more than groupConcurrency jobs of one group, and the other groups beside them', async () => {
    const runtime = buildRuntime()
    const active = new Map<string, number>()
    const peak = new Map<string, number>()
    const finished: string[] = []
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const handle = runtime.registry.define({
      name: 'jobs.group-concurrency',
      schema: z.object({ group: z.string() }).strict(),
      handler: async ({ data }) => {
        const now = (active.get(data.group) ?? 0) + 1
        active.set(data.group, now)
        peak.set(data.group, Math.max(peak.get(data.group) ?? 0, now))

        // The busy group's jobs wait, so they hold their slots while the
        // test looks; the quiet group's job returns at once.
        if (data.group === 'busy') {
          await held
        }

        active.set(data.group, (active.get(data.group) ?? 1) - 1)
        finished.push(data.group)
      },
      defaults: { localConcurrency: 3, groupConcurrency: 1 },
    })

    await runtime.start()

    try {
      await scopeFor(runtime)(
        async ({ jobs }) => {
          for (let index = 0; index < 3; index += 1) {
            await jobs.enqueue(handle, { group: 'busy' }, { group: { id: 'busy' } })
          }
          await jobs.enqueue(handle, { group: 'quiet' }, { group: { id: 'quiet' } })
        },
        { workspaceId: fixture.workspaceId },
      )

      await runtime.startWorking()

      // The quiet group's job was enqueued last and still runs while the
      // busy group holds its one slot.
      await waitFor(() => finished.includes('quiet'), { budgetMs: 10_000 })
      // More than one poll: two workers are free, and neither takes a
      // second job of the busy group.
      await new Promise((resolve) => setTimeout(resolve, 1_200))

      expect(active.get('busy')).toBe(1)
      expect(peak.get('busy')).toBe(1)

      release?.()
      await waitFor(() => finished.filter((group) => group === 'busy').length === 3, { budgetMs: 10_000 })

      expect(peak.get('busy')).toBe(1)
    } finally {
      release?.()
      await runtime.stop()
    }
  }, 20_000)

  it('runs no more than a groupConcurrency above 1 of one group at a time', async () => {
    // pg-boss counts active jobs per group with other SQL for a limit of 1,
    // so a limit above 1 needs its own test.
    //
    // The jobs arrive one at a time, as events do. A burst of jobs that idle
    // workers fetch at the same instant can pass the limit, because each
    // fetch reads the count before the others claim (see
    // `JobDefaults.groupConcurrency`); with six workers and five jobs at once
    // this test saw four run.
    const runtime = buildRuntime()
    let active = 0
    let peak = 0
    let finished = 0
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const handle = runtime.registry.define({
      name: 'jobs.group-concurrency-3',
      schema: z.object({}).strict(),
      handler: async () => {
        active += 1
        peak = Math.max(peak, active)
        await held
        active -= 1
        finished += 1
      },
      defaults: { localConcurrency: 6, groupConcurrency: 3 },
    })

    await runtime.start()
    await runtime.startWorking()

    try {
      for (let index = 0; index < 5; index += 1) {
        await scopeFor(runtime)(
          async ({ jobs }) => {
            await jobs.enqueue(handle, {}, { group: { id: 'busy' } })
          },
          { workspaceId: fixture.workspaceId },
        )
        // Long enough for a free worker to take the job when the group has room.
        await new Promise((resolve) => setTimeout(resolve, 700))
      }

      await waitFor(() => active === 3, { budgetMs: 10_000 })
      // More than one poll: three workers are free, and none takes a fourth job.
      await new Promise((resolve) => setTimeout(resolve, 1_200))

      expect(peak).toBe(3)

      release?.()
      await waitFor(() => finished === 5, { budgetMs: 10_000 })

      expect(peak).toBe(3)
    } finally {
      release?.()
      await runtime.stop()
    }
  }, 30_000)

  it('brings the settings of an existing queue to what the definition says, on each start', async () => {
    // A new name each run: `truncateAll` empties `pgboss.job` but keeps
    // `pgboss.queue`, and a queue left by an earlier run would hide the bug.
    const name = `jobs.queue-settings-${createId('event')}`
    const first = buildRuntime()

    first.registry.define({
      name,
      schema: z.object({}).strict(),
      handler: async () => undefined,
      defaults: { retryLimit: 1, retryDelay: 5, retryBackoff: true, retryDelayMax: 10, expireInSeconds: 30 },
    })
    await first.start()
    await first.stop()

    // A later release: new limit, and the other settings gone.
    const second = buildRuntime()

    second.registry.define({
      name,
      schema: z.object({}).strict(),
      handler: async () => undefined,
      defaults: { retryLimit: 4 },
    })
    await second.start()

    try {
      const rows = await database.db.execute<{
        retry_limit: number
        retry_delay: number
        retry_backoff: boolean
        retry_delay_max: number | null
        expire_seconds: number
        dead_letter: string | null
      }>(
        sql`select retry_limit, retry_delay, retry_backoff, retry_delay_max, expire_seconds, dead_letter
            from pgboss.queue where name = ${name}`,
      )

      expect([...rows]).toEqual([
        {
          retry_limit: 4,
          // pg-boss's defaults, back in place of the settings the definition dropped.
          retry_delay: 0,
          retry_backoff: false,
          retry_delay_max: null,
          expire_seconds: 900,
          dead_letter: `${name}.dead`,
        },
      ])
    } finally {
      await second.stop()
    }
  })

  it('retries a job that a dead worker left active past expireInSeconds', async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: suite skips when no connection string')
    }

    const runtime = buildRuntime()
    const seen: unknown[] = []
    const handle = runtime.registry.define({
      name: 'jobs.expire',
      schema: z.object({ note: z.string() }).strict(),
      handler: async ({ data }) => {
        seen.push(data)
      },
      defaults: { retryLimit: 1, retryDelay: 0, expireInSeconds: 1 },
    })

    await runtime.start()

    // The dead worker: a second instance takes the job, which makes it
    // `active`, and never completes it. A handler that hangs on a live
    // worker would not do: that worker fails its own job at
    // `expireInSeconds`, with no supervision.
    const deadWorker = new PgBoss({
      connectionString,
      schema: 'pgboss',
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    })
    deadWorker.on('error', () => undefined)
    await deadWorker.start()

    try {
      const scope = scopeFor(runtime)

      await scope(
        async ({ jobs }) => {
          await jobs.enqueue(handle, { note: 'held' })
        },
        { workspaceId: fixture.workspaceId },
      )

      const taken = await deadWorker.fetch('jobs.expire')
      expect(taken).toHaveLength(1)

      await runtime.startWorking()

      await waitFor(() => seen.length === 1, { budgetMs: 15_000 })
      expect(seen).toEqual([{ note: 'held' }])

      const rows = await database.db.execute<{ retry_count: number }>(
        sql`select retry_count from pgboss.job where name = 'jobs.expire'`,
      )
      expect(rows.map((row) => row.retry_count)).toEqual([1])
    } finally {
      await deadWorker.stop({ graceful: false, close: true, timeout: 5_000 })
      await runtime.stop()
    }
  }, 20_000)

  it('gives a job that failed on its last run to onDeadLetter, one time', async () => {
    const runtime = buildRuntime()
    let attempts = 0
    const dead: { readonly id: string; readonly data: unknown }[] = []
    const handle = runtime.registry.define({
      name: 'jobs.dead-letter',
      schema: z.object({ note: z.string() }).strict(),
      handler: async () => {
        attempts += 1
        throw new Error('always fails')
      },
      defaults: { retryLimit: 1, retryDelay: 0 },
      onDeadLetter: async ({ id, data }) => {
        dead.push({ id, data })
      },
    })

    await runtime.start()
    await runtime.startWorking()

    try {
      const scope = scopeFor(runtime)

      await scope(
        async ({ jobs }) => {
          await jobs.enqueue(handle, { note: 'gave up' })
        },
        { workspaceId: fixture.workspaceId },
      )

      await waitFor(() => dead.length === 1, { budgetMs: 10_000 })

      // Only after the queue gave up: both runs came first.
      expect(attempts).toBe(2)
      expect(dead.map((job) => job.data)).toEqual([{ note: 'gave up' }])

      // The job in the dead-letter queue completes, and the row stays.
      await waitFor(async () => {
        const rows = await database.db.execute<{ id: string; state: string }>(
          sql`select id::text as id, state::text as state from pgboss.job where name = 'jobs.dead-letter.dead'`,
        )
        return rows.length === 1 && rows[0]?.state === 'completed' && rows[0].id === dead[0]?.id
      })
      expect(dead).toHaveLength(1)
    } finally {
      await runtime.stop()
    }
  })

  it('gives onDeadLetter the job a dead worker held on its last run', async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: suite skips when no connection string')
    }

    const runtime = buildRuntime()
    let attempts = 0
    const dead: unknown[] = []
    const handle = runtime.registry.define({
      name: 'jobs.dead-worker',
      schema: z.object({ note: z.string() }).strict(),
      handler: async () => {
        attempts += 1
      },
      // No retry: the run the dead worker takes is the last one.
      defaults: { retryLimit: 0, expireInSeconds: 1 },
      onDeadLetter: async ({ data }) => {
        dead.push(data)
      },
    })

    await runtime.start()

    // The dead worker, as in the test of `expireInSeconds` above.
    const deadWorker = new PgBoss({
      connectionString,
      schema: 'pgboss',
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    })
    deadWorker.on('error', () => undefined)
    await deadWorker.start()

    try {
      const scope = scopeFor(runtime)

      await scope(
        async ({ jobs }) => {
          await jobs.enqueue(handle, { note: 'held' })
        },
        { workspaceId: fixture.workspaceId },
      )

      const taken = await deadWorker.fetch('jobs.dead-worker')
      expect(taken).toHaveLength(1)

      await runtime.startWorking()

      await waitFor(() => dead.length === 1, { budgetMs: 15_000 })

      // No handler ran: supervision ended the job, and only onDeadLetter saw it.
      expect(attempts).toBe(0)
      expect(dead).toEqual([{ note: 'held' }])
    } finally {
      await deadWorker.stop({ graceful: false, close: true, timeout: 5_000 })
      await runtime.stop()
    }
  }, 20_000)

  it('leaves a dead-letter job untouched for a definition with no onDeadLetter', async () => {
    const runtime = buildRuntime()
    const handle = runtime.registry.define({
      name: 'jobs.dead-untouched',
      schema: z.object({}).strict(),
      handler: async () => {
        throw new Error('always fails')
      },
      defaults: { retryLimit: 0 },
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

      const states = async (): Promise<string[]> => {
        const rows = await database.db.execute<{ state: string }>(
          sql`select state::text as state from pgboss.job where name = 'jobs.dead-untouched.dead'`,
        )
        return [...rows].map((row) => row.state)
      }

      await waitFor(async () => (await states()).length === 1, { budgetMs: 10_000 })
      // More than one poll of the worker: nothing takes the job.
      await new Promise((resolve) => setTimeout(resolve, 1_200))

      expect(await states()).toEqual(['created'])
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
