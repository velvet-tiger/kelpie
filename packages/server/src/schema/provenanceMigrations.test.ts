import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { coreMigrationsDirectory } from '../modules/core.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { insertWorkspaceFixture } from '../testing/fixtures.ts'
import type { WorkspaceFixture } from '../testing/fixtures.ts'

/**
 * What migrations 0063 and 0064 do to rows that were there before them.
 *
 * The test database is already migrated, so each test takes the columns off
 * again inside a transaction, writes rows as the older schema held them, runs
 * the migration file as it is on disk, and reads the result. The transaction is
 * always rolled back, so no other test sees a table without its columns.
 */

/** Thrown to end the transaction once the rows have been read. Never a failure. */
class RolledBackOnPurpose extends Error {}

/** A migration file, as one script. The breakpoint marker is a SQL comment line ending. */
function migrationSql(name: string): string {
  return readFileSync(join(coreMigrationsDirectory, name), 'utf8').replaceAll('--> statement-breakpoint', '')
}

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('the origin and confirmation migrations', () => {
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

  /** Runs `work` in a transaction that is rolled back, and hands back what it read. */
  async function inRolledBackTransaction<T>(
    work: (tx: Parameters<Parameters<TestDatabase['db']['transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    let result: { readonly value: T } | undefined

    try {
      await database.db.transaction(async (tx) => {
        result = { value: await work(tx) }

        throw new RolledBackOnPurpose()
      })
    } catch (thrown: unknown) {
      if (!(thrown instanceof RolledBackOnPurpose)) {
        throw thrown
      }
    }

    if (result === undefined) {
      throw new Error('The transaction ended before it read anything')
    }

    return result.value
  }

  it('0063 gives every existing note and decision the origin unknown, with or without a member on it', async () => {
    const rows = await inRolledBackTransaction(async (tx) => {
      await tx.execute(sql`alter table decisions drop column confirmed_by_id, drop column confirmed_at, drop column origin`)
      await tx.execute(sql`alter table notes drop column origin`)
      await tx.execute(sql`
        insert into notes (id, workspace_id, target_type, target_id, body, author_id) values
          ('note_old_member', ${fixture.workspaceId}, 'person', 'per_old', 'Has an author', ${fixture.memberId}),
          ('note_old_key', ${fixture.workspaceId}, 'person', 'per_old', 'Has no author', null)
      `)
      await tx.execute(sql`
        insert into decisions (id, workspace_id, target_type, target_id, body, owner_id) values
          ('dec_old_member', ${fixture.workspaceId}, 'person', 'per_old', 'Has an owner', ${fixture.memberId}),
          ('dec_old_key', ${fixture.workspaceId}, 'person', 'per_old', 'Has no owner', null)
      `)

      await tx.execute(sql.raw(migrationSql('0063_note_and_decision_origin.sql')))

      // A writer from before the migration names no origin. The default answers for it.
      await tx.execute(sql`
        insert into notes (id, workspace_id, target_type, target_id, body)
        values ('note_old_code', ${fixture.workspaceId}, 'person', 'per_old', 'Written by old code')
      `)

      const noteRows = await tx.execute<{ id: string; origin: string }>(
        sql`select id, origin from notes order by id`,
      )
      const decisionRows = await tx.execute<{ id: string; origin: string }>(
        sql`select id, origin from decisions order by id`,
      )

      return { notes: [...noteRows], decisions: [...decisionRows] }
    })

    expect(rows.notes).toEqual([
      { id: 'note_old_code', origin: 'unknown' },
      { id: 'note_old_key', origin: 'unknown' },
      { id: 'note_old_member', origin: 'unknown' },
    ])
    expect(rows.decisions).toEqual([
      { id: 'dec_old_key', origin: 'unknown' },
      { id: 'dec_old_member', origin: 'unknown' },
    ])
  })

  it('0064 leaves every existing decision confirmed at the time it was created, with no member named', async () => {
    const rows = await inRolledBackTransaction(async (tx) => {
      await tx.execute(sql`alter table decisions drop column confirmed_by_id, drop column confirmed_at`)
      await tx.execute(sql`
        insert into decisions (id, workspace_id, target_type, target_id, body, owner_id, origin, created_at) values
          ('dec_old_member', ${fixture.workspaceId}, 'person', 'per_old', 'Has an owner', ${fixture.memberId}, 'unknown', '2026-01-02T03:04:05Z'),
          ('dec_old_key', ${fixture.workspaceId}, 'person', 'per_old', 'Has no owner', null, 'unknown', '2026-02-03T04:05:06Z')
      `)

      await tx.execute(sql.raw(migrationSql('0064_decision_confirmation.sql')))

      // A writer that does not say whether a decision is confirmed makes a proposal.
      await tx.execute(sql`
        insert into decisions (id, workspace_id, target_type, target_id, body, origin)
        values ('dec_no_value', ${fixture.workspaceId}, 'person', 'per_old', 'Does not say', 'ai')
      `)

      const decisionRows = await tx.execute<{ id: string; confirmed_at: string | null; confirmed_by_id: string | null }>(
        sql`select id, to_char(confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as confirmed_at, confirmed_by_id from decisions order by id`,
      )

      return [...decisionRows]
    })

    expect(rows).toEqual([
      { id: 'dec_no_value', confirmed_at: null, confirmed_by_id: null },
      { id: 'dec_old_key', confirmed_at: '2026-02-03T04:05:06Z', confirmed_by_id: null },
      { id: 'dec_old_member', confirmed_at: '2026-01-02T03:04:05Z', confirmed_by_id: null },
    ])
  })

  it('leaves the tables as they were', async () => {
    const columns = await database.db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name = 'decisions' and column_name in ('origin', 'confirmed_at', 'confirmed_by_id')
      order by column_name
    `)

    expect([...columns].map((row) => row.column_name)).toEqual(['confirmed_at', 'confirmed_by_id', 'origin'])
  })
})
