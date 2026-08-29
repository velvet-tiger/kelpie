import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { people } from '../modules/people/schema.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { insertWorkspaceFixture } from '../testing/fixtures.ts'
import type { WorkspaceFixture } from '../testing/fixtures.ts'

/**
 * Pins the one drizzle behaviour Branch B's forms action runner depends on:
 * a nested `tx.transaction(...)` is a `SAVEPOINT`, and rolling it back leaves
 * the outer transaction alive to run the next statement.
 *
 * If the drizzle-orm postgres-js driver ever stops emitting SAVEPOINT for a
 * nested transaction, the forms runner would abort the whole submit on the
 * first per-action failure, dropping every later action and losing the lead.
 * Catching that here rather than in the forms tests keeps the failure signal
 * pointed at the driver behaviour it is really about.
 */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('nested transactions are savepoints', () => {
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

  it('rolls a nested transaction back on its own and leaves the outer live', async () => {
    let outerAliveAfter = false

    await database.db.transaction(async (outer) => {
      await outer.insert(people).values({
        id: 'per_outer_one',
        workspaceId: fixture.workspaceId,
        name: 'Ada Lovelace',
        preferredChannel: 'email',
        influence: 'influencer',
        relationship: 'cold',
      })

      try {
        await outer.transaction(async (inner) => {
          await inner.insert(people).values({
            id: 'per_inner_two',
            workspaceId: fixture.workspaceId,
            name: 'Charles Babbage',
            preferredChannel: 'email',
            influence: 'influencer',
            relationship: 'cold',
          })
          throw new Error('inner rolls back')
        })
      } catch {
        // Swallowed: what matters is that the outer keeps working.
      }

      const rows = await outer
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.workspaceId, fixture.workspaceId), eq(people.id, 'per_outer_one')))
      outerAliveAfter = rows.length === 1
    })

    expect(outerAliveAfter).toBe(true)

    const finalRows = await database.db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.workspaceId, fixture.workspaceId))
    const ids = finalRows.map((row) => row.id).sort()

    expect(ids).toEqual(['per_outer_one'])
  })

  it('lets the outer commit finish normally after a rolled-back savepoint', async () => {
    await database.db.transaction(async (outer) => {
      await outer.insert(people).values({
        id: 'per_kept_a',
        workspaceId: fixture.workspaceId,
        name: 'Grace Hopper',
        preferredChannel: 'email',
        influence: 'influencer',
        relationship: 'cold',
      })

      try {
        await outer.transaction(async (inner) => {
          await inner.insert(people).values({
            id: 'per_dropped_b',
            workspaceId: fixture.workspaceId,
            name: 'Katherine Johnson',
            preferredChannel: 'email',
            influence: 'influencer',
            relationship: 'cold',
          })
          throw new Error('savepoint reject')
        })
      } catch {
        // Same as above.
      }

      await outer.insert(people).values({
        id: 'per_kept_c',
        workspaceId: fixture.workspaceId,
        name: 'Margaret Hamilton',
        preferredChannel: 'email',
        influence: 'influencer',
        relationship: 'cold',
      })
    })

    const rows = await database.db.execute<{ id: string }>(sql`
      select "id" from ${people} where "workspace_id" = ${fixture.workspaceId} order by "id"
    `)
    const ids = [...rows].map((row) => row.id)

    expect(ids).toEqual(['per_kept_a', 'per_kept_c'])
  })
})
