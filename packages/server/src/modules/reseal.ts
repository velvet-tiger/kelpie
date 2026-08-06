import { eq } from 'drizzle-orm'

import type { Database } from '../lib/database.ts'
import { SecretDecryptionError } from '../lib/secrets.ts'
import type { SecretCipher } from '../lib/secrets.ts'
import { webhooks } from './webhooks/schema.ts'

/**
 * Re-seals every stored secret under the current `SECRET_ENCRYPTION_KEY`.
 *
 * Rotating that key makes everything sealed under the old one unreadable, and
 * the failure is loud but unactionable: the delivery engine logs a
 * `SecretDecryptionError` naming the webhook and stops signing for it. The way
 * out is to set `SECRET_ENCRYPTION_KEY_PREVIOUS` to the old key, deploy, and run
 * this. Deliveries keep working throughout, because `open` falls back to the
 * previous key while this pass catches up.
 *
 * Lives beside `attachedRecords.ts` and `recordTargets.ts` rather than in `lib/`
 * for the reason those do: it has to read module tables, and `lib` is below
 * `modules` in the dependency order.
 *
 * Idempotent, and deliberately not one transaction. Each row is independent, so
 * a run that dies halfway leaves the rows it finished already current and the
 * rest still readable under the previous key. Re-running finishes the job.
 * Wrapping fifty thousand rows in one transaction would buy nothing and hold a
 * write lock across the lot.
 */

/**
 * Every column holding a value sealed by `lib/secrets.ts`.
 *
 * One entry today. `schema.md` reserves `agent_registrations.auth_header_encrypted`
 * and `modules.md` reserves integration connection records for the same cipher;
 * each lands here when it lands, and a rotation that missed one would leave a
 * customer's stored OAuth credential unreadable with no way back. There is no
 * registry for modules to declare these through, on purpose: one caller does not
 * need an extension point, and a sealed column that nothing re-seals is a bug
 * whichever way it was registered.
 */
const SEALED_COLUMNS = [
  {
    label: 'webhooks.secret_encrypted',
    read: (db: Database) => db.select({ id: webhooks.id, sealed: webhooks.secretEncrypted }).from(webhooks),
    write: (db: Database, id: string, sealed: string) =>
      db.update(webhooks).set({ secretEncrypted: sealed }).where(eq(webhooks.id, id)),
  },
] as const

/** What one column's pass did. */
export interface ResealColumnOutcome {
  /** `table.column`, for a report an operator can act on. */
  readonly label: string
  readonly examined: number
  readonly resealed: number
  /**
   * Rows that opened under neither key. Sealed under a third key, or altered.
   * Named by id rather than counted: nothing here can recover them, so the only
   * useful output is which rows an operator has to deal with by hand.
   */
  readonly unreadable: readonly string[]
}

export interface ResealOutcome {
  readonly columns: readonly ResealColumnOutcome[]
  readonly examined: number
  readonly resealed: number
  readonly unreadable: number
}

/**
 * Reads every sealed column, and rewrites anything not already under the
 * current key.
 *
 * Does not throw for a row it cannot open. One unreadable row must not stop the
 * pass from fixing every other one, so it is reported and the caller decides
 * what a non-empty `unreadable` means.
 */
export async function resealStoredSecrets(
  db: Database,
  cipher: SecretCipher,
): Promise<ResealOutcome> {
  const columns: ResealColumnOutcome[] = []

  for (const column of SEALED_COLUMNS) {
    const rows = await column.read(db)
    const unreadable: string[] = []
    let resealed = 0

    for (const row of rows) {
      let next: string | undefined

      try {
        next = cipher.reseal(row.sealed)
      } catch (error: unknown) {
        if (!(error instanceof SecretDecryptionError)) {
          throw error
        }

        unreadable.push(row.id)
        continue
      }

      // Undefined means it is already sealed under the current key, which is
      // every row on a second run and most rows on the first.
      if (next === undefined) {
        continue
      }

      await column.write(db, row.id, next)
      resealed += 1
    }

    columns.push({ label: column.label, examined: rows.length, resealed, unreadable })
  }

  return {
    columns,
    examined: columns.reduce((total, column) => total + column.examined, 0),
    resealed: columns.reduce((total, column) => total + column.resealed, 0),
    unreadable: columns.reduce((total, column) => total + column.unreadable.length, 0),
  }
}
