import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { KelpieEvent } from '@kelpie/schemas'

import { createIdFactory } from '../lib/ids.ts'
import { createLogger } from '../lib/logger.ts'
import { people } from '../modules/people/schema.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { insertWorkspaceFixture } from '../testing/fixtures.ts'
import type { WorkspaceFixture } from '../testing/fixtures.ts'
import { createEventBus } from './events.ts'
import type { EventBus } from './events.ts'
import { createTransactionScope } from './transaction.ts'
import type { TransactionScope } from './transaction.ts'

/**
 * The rule that makes the bus safe to consume: nothing is published until the
 * transaction that emitted it has committed. A consumer must never be told about
 * a record that does not exist.
 */

const connectionString = testDatabaseUrl(process.env)
const createId = createIdFactory()
const silentLogger = createLogger('error', () => undefined)
const TEST_EVENT_NAME = 'runtime.person.created'

describe.skipIf(connectionString === undefined)('createTransactionScope', () => {
  let database: TestDatabase
  let fixture: WorkspaceFixture
  let bus: EventBus
  let runInTransaction: TransactionScope
  let published: KelpieEvent<string, unknown>[]

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

    published = []
    bus = createEventBus(silentLogger)
    bus.registerCatalog({
      moduleId: 'runtime-test',
      events: { [TEST_EVENT_NAME]: z.object({}).strict() },
    })
    bus.subscribe(TEST_EVENT_NAME as never, (event) => {
      published.push(event as KelpieEvent<string, unknown>)
    })

    runInTransaction = createTransactionScope({
      db: database.db,
      bus,
      logger: silentLogger,
      createId,
      now: () => new Date('2026-08-21T00:00:00.000Z'),
    })
  })

  function personValues(id: string): typeof people.$inferInsert {
    return {
      id,
      workspaceId: fixture.workspaceId,
      name: 'Ada Lovelace',
      email: `${id}@example.com`,
      preferredChannel: 'email',
      influence: 'champion',
      relationship: 'warm',
    }
  }

  it('publishes buffered events after the transaction commits', async () => {
    const personId = createId('person')

    const returned = await runInTransaction(
      async ({ tx, events }) => {
        await tx.insert(people).values(personValues(personId))
        events.emit(TEST_EVENT_NAME as never, { type: 'person', id: personId }, {} as never)

        return 'done'
      },
      { workspaceId: fixture.workspaceId },
    )

    await bus.drain()

    expect(returned).toBe('done')
    expect(published.map((entry) => entry.target.id)).toEqual([personId])
    expect(await database.db.select().from(people).where(eq(people.id, personId))).toHaveLength(1)
  })

  it('publishes nothing when the transaction rolls back', async () => {
    const personId = createId('person')

    await expect(
      runInTransaction(
        async ({ tx, events }) => {
          await tx.insert(people).values(personValues(personId))
          events.emit(TEST_EVENT_NAME as never, { type: 'person', id: personId }, {} as never)

          throw new Error('service decided against it')
        },
        { workspaceId: fixture.workspaceId },
      ),
    ).rejects.toThrow('service decided against it')

    await bus.drain()

    expect(published).toEqual([])
    expect(await database.db.select().from(people)).toHaveLength(0)
  })

  it('does not publish while the transaction is still open', async () => {
    const personId = createId('person')
    let seenDuringTransaction = 0

    await runInTransaction(
      async ({ tx, events }) => {
        await tx.insert(people).values(personValues(personId))
        events.emit(TEST_EVENT_NAME as never, { type: 'person', id: personId }, {} as never)

        seenDuringTransaction = published.length
      },
      { workspaceId: fixture.workspaceId },
    )

    await bus.drain()

    expect(seenDuringTransaction).toBe(0)
    expect(published).toHaveLength(1)
  })

  it('commits and publishes even though a handler throws', async () => {
    bus.subscribe(TEST_EVENT_NAME as never, () => Promise.reject(new Error('consumer exploded')))
    const personId = createId('person')

    await runInTransaction(
      async ({ tx, events }) => {
        await tx.insert(people).values(personValues(personId))
        events.emit(TEST_EVENT_NAME as never, { type: 'person', id: personId }, {} as never)
      },
      { workspaceId: fixture.workspaceId },
    )

    await bus.drain()

    expect(published).toHaveLength(1)
    expect(await database.db.select().from(people).where(eq(people.id, personId))).toHaveLength(1)
  })

  it('stamps an envelope on emit with the workspace, actor, target and time', async () => {
    const personId = createId('person')

    await runInTransaction(
      async ({ tx, events }) => {
        await tx.insert(people).values(personValues(personId))
        events.emit(TEST_EVENT_NAME as never, { type: 'person', id: personId }, {} as never)
      },
      { workspaceId: fixture.workspaceId, actor: { kind: 'user', id: 'usr_1' } },
    )

    await bus.drain()

    expect(published).toHaveLength(1)
    const envelope = published[0]!
    expect(envelope.name).toBe(TEST_EVENT_NAME)
    expect(envelope.workspaceId).toBe(fixture.workspaceId)
    expect(envelope.actor).toEqual({ kind: 'user', id: 'usr_1' })
    expect(envelope.target).toEqual({ type: 'person', id: personId })
    expect(envelope.occurredAt).toBe('2026-08-21T00:00:00.000Z')
    expect(envelope.id.startsWith('ev_')).toBe(true)
  })

  it('throws when emit is called without a workspaceId', async () => {
    await expect(
      runInTransaction(async ({ events }) => {
        events.emit(
          TEST_EVENT_NAME as never,
          { type: 'person', id: 'per_x' },
          {} as never,
        )
      }),
    ).rejects.toThrow(/emitted without a workspaceId/)
  })

  it('publishes several events in the order they were emitted', async () => {
    const first = createId('person')
    const second = createId('person')

    await runInTransaction(
      async ({ tx, events }) => {
        await tx.insert(people).values(personValues(first))
        events.emit(TEST_EVENT_NAME as never, { type: 'person', id: first }, {} as never)
        await tx.insert(people).values(personValues(second))
        events.emit(TEST_EVENT_NAME as never, { type: 'person', id: second }, {} as never)
      },
      { workspaceId: fixture.workspaceId },
    )

    await bus.drain()

    expect(published.map((entry) => entry.target.id)).toEqual([first, second])
  })
})
