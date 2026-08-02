import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

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

describe.skipIf(connectionString === undefined)('createTransactionScope', () => {
  let database: TestDatabase
  let fixture: WorkspaceFixture
  let bus: EventBus
  let runInTransaction: TransactionScope
  let published: { name: string; recordId: string }[]

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
    bus.subscribe('record.created', async (payload) => {
      published.push({ name: 'record.created', recordId: payload.recordId })
    })

    runInTransaction = createTransactionScope({ db: database.db, bus, logger: silentLogger })
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

    const returned = await runInTransaction(async ({ tx, events }) => {
      await tx.insert(people).values(personValues(personId))
      events.emit('record.created', {
        workspaceId: fixture.workspaceId,
        objectType: 'person',
        recordId: personId,
      })

      return 'done'
    })

    await bus.drain()

    expect(returned).toBe('done')
    expect(published).toEqual([{ name: 'record.created', recordId: personId }])
    expect(await database.db.select().from(people).where(eq(people.id, personId))).toHaveLength(1)
  })

  it('publishes nothing when the transaction rolls back', async () => {
    const personId = createId('person')

    await expect(
      runInTransaction(async ({ tx, events }) => {
        await tx.insert(people).values(personValues(personId))
        events.emit('record.created', {
          workspaceId: fixture.workspaceId,
          objectType: 'person',
          recordId: personId,
        })

        throw new Error('service decided against it')
      }),
    ).rejects.toThrow('service decided against it')

    await bus.drain()

    expect(published).toEqual([])
    expect(await database.db.select().from(people)).toHaveLength(0)
  })

  it('does not publish while the transaction is still open', async () => {
    const personId = createId('person')
    let seenDuringTransaction = 0

    await runInTransaction(async ({ tx, events }) => {
      await tx.insert(people).values(personValues(personId))
      events.emit('record.created', {
        workspaceId: fixture.workspaceId,
        objectType: 'person',
        recordId: personId,
      })

      seenDuringTransaction = published.length
    })

    await bus.drain()

    expect(seenDuringTransaction).toBe(0)
    expect(published).toHaveLength(1)
  })

  it('commits and publishes even though a handler throws', async () => {
    bus.subscribe('record.created', () => Promise.reject(new Error('consumer exploded')))
    const personId = createId('person')

    await runInTransaction(async ({ tx, events }) => {
      await tx.insert(people).values(personValues(personId))
      events.emit('record.created', {
        workspaceId: fixture.workspaceId,
        objectType: 'person',
        recordId: personId,
      })
    })

    await bus.drain()

    expect(published).toHaveLength(1)
    expect(await database.db.select().from(people).where(eq(people.id, personId))).toHaveLength(1)
  })

  it('publishes several events in the order they were emitted', async () => {
    const first = createId('person')
    const second = createId('person')

    await runInTransaction(async ({ tx, events }) => {
      await tx.insert(people).values(personValues(first))
      events.emit('record.created', {
        workspaceId: fixture.workspaceId,
        objectType: 'person',
        recordId: first,
      })
      await tx.insert(people).values(personValues(second))
      events.emit('record.created', {
        workspaceId: fixture.workspaceId,
        objectType: 'person',
        recordId: second,
      })
    })

    await bus.drain()

    expect(published.map((entry) => entry.recordId)).toEqual([first, second])
  })
})
