import { getTableName, is } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import * as coreSchema from '../../schema/index.ts'
import * as aiSchema from '../ai/schema.ts'
import { MEMBER_REFERENCE_COLUMNS } from './repository.ts'

/**
 * The guard on deleting a member, and so on deleting an account.
 *
 * A column that names a member with `ON DELETE RESTRICT` blocks the delete of
 * that member row, and the member row goes whenever its account does. One the
 * workspace module does not know about would turn every account deletion
 * that touches it into a `500`, and every member removal into a refusal the
 * admin cannot act on. The schema is the source of truth, so this fails the
 * day such a column is added rather than the day someone tries to leave.
 */

interface ForeignKeyRow {
  readonly column: string
  readonly target: string
  readonly onDelete: string
}

/** Every foreign key in core's schema and the optional `ai` module's. */
function foreignKeys(): readonly ForeignKeyRow[] {
  const rows: ForeignKeyRow[] = []

  // A for-loop rather than filter-then-map: the barrels export constants
  // beside their tables, and Drizzle's own `is` narrows in an if.
  for (const exported of [...Object.values(coreSchema), ...Object.values(aiSchema)]) {
    if (!is(exported, PgTable)) {
      continue
    }

    const table = exported

    for (const foreignKey of getTableConfig(table).foreignKeys) {
      const reference = foreignKey.reference()

      for (const column of reference.columns) {
        rows.push({
          column: `${getTableName(table)}.${column.name}`,
          target: getTableName(reference.foreignTable),
          // Drizzle leaves the action undefined when the schema names none,
          // which Postgres reads as `NO ACTION`: a refusal, like `RESTRICT`.
          onDelete: foreignKey.onDelete ?? 'no action',
        })
      }
    }
  }

  return rows
}

const REFUSING = new Set(['restrict', 'no action'])

describe('what refers to a member or an account', () => {
  const keys = foreignKeys()

  it('clears every column that would refuse the delete of a member', () => {
    const refusing = keys
      .filter((key) => key.target === 'workspace_members' && REFUSING.has(key.onDelete))
      .map((key) => key.column)

    expect(MEMBER_REFERENCE_COLUMNS.toSorted()).toEqual(refusing.toSorted())
  })

  it('lets every row that refers to an account go with it', () => {
    const refusing = keys.filter((key) => key.target === 'users' && REFUSING.has(key.onDelete))

    expect(refusing).toEqual([])
  })

  /** Guards the guard: a scan that matched nothing would pass forever. */
  it('finds the foreign keys it is scanning for', () => {
    const columns = keys.map((key) => key.column)

    expect(columns).toContain('deals.owner_id')
    expect(columns).toContain('workspace_members.user_id')
    expect(columns).toContain('sessions.user_id')
  })
})
