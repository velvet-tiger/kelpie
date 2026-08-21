import { eq } from 'drizzle-orm'

import { ConfigurationError } from '../lib/config.ts'
import type { KelpieConfig } from '../lib/config.ts'
import { connectDatabase } from '../lib/database.ts'
import type { Database } from '../lib/database.ts'
import type { Logger } from '../lib/logger.ts'
import { createSecretCipher, secretEncryptionConfigSchema, SecretDecryptionError } from '../lib/secrets.ts'
import type { SecretCipher } from '../lib/secrets.ts'
import { agentRegistrations } from './agent-tasks/schema.ts'
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

/** One sealed column, and how to read and rewrite it. */
interface SealedColumn {
  /** `table.column`, for a report an operator can act on. */
  readonly label: string
  readonly read: (db: Database) => Promise<readonly { id: string; sealed: string | null }[]>
  readonly write: (db: Database, id: string, sealed: string) => Promise<unknown>
}

/**
 * Every column in core's schema holding a value sealed by `lib/secrets.ts`.
 *
 * All three that exist are here, including `agent_registrations`, which nothing
 * writes yet. Covering a column before its first write is the cheap half of
 * this: the expensive half is noticing, a year later, that a rotation reported
 * success while stranding a customer's stored credential with no way back. The
 * test asserts this list against the schema, so a fourth `_encrypted` column
 * fails the day it is added rather than at the next rotation.
 *
 * There is no registry for modules to declare these through, on purpose. One
 * caller does not need an extension point, and a sealed column that nothing
 * re-seals is a bug whichever way it was registered. A module outside core
 * seals under the same key through `createSecretCipher` and brings its own pass
 * over its own tables, which this one cannot see.
 */
const SEALED_COLUMNS: readonly SealedColumn[] = [
  {
    label: 'webhooks.secret_encrypted',
    read: async (db) => db.select({ id: webhooks.id, sealed: webhooks.secretEncrypted }).from(webhooks),
    write: async (db, id, sealed) => {
      await db.update(webhooks).set({ secretEncrypted: sealed }).where(eq(webhooks.id, id))
    },
  },
  {
    label: 'webhooks.previous_secret_encrypted',
    read: async (db) =>
      db.select({ id: webhooks.id, sealed: webhooks.previousSecretEncrypted }).from(webhooks),
    write: async (db, id, sealed) => {
      await db.update(webhooks).set({ previousSecretEncrypted: sealed }).where(eq(webhooks.id, id))
    },
  },
  {
    label: 'agent_registrations.auth_header_encrypted',
    read: async (db) =>
      db
        .select({ id: agentRegistrations.id, sealed: agentRegistrations.authHeaderEncrypted })
        .from(agentRegistrations),
    write: async (db, id, sealed) => {
      await db
        .update(agentRegistrations)
        .set({ authHeaderEncrypted: sealed })
        .where(eq(agentRegistrations.id, id))
    },
  },
]

/** The columns this pass covers. Exported for the test that checks none is missing. */
export const RESEALED_COLUMNS: readonly string[] = SEALED_COLUMNS.map((column) => column.label)

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
    // Null means the row holds no secret, which is every row of a column whose
    // module has not started writing one. Not counted as examined: a report
    // saying it looked at forty rows and re-sealed none would read as a problem.
    const rows = (await column.read(db)).filter(
      (row): row is { id: string; sealed: string } => row.sealed !== null,
    )
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

/**
 * One reseal pass over some set of columns. Core's own pass is one; a module
 * with its own sealed table exports one too, and the assembly wires it in as
 * an `extraPasses` entry.
 *
 * The shape matches `resealStoredSecrets` on purpose, so a pass covering a
 * single column returns a one-element `columns` and `runReseal` can print
 * every pass the same way.
 */
export type ResealPass = (db: Database, cipher: SecretCipher) => Promise<ResealOutcome>

export interface RunResealOptions {
  readonly config: KelpieConfig
  readonly logger: Logger
  /**
   * Extra passes to run after core's own. An assembly wires its modules'
   * sealed columns in here; each pass covers columns core cannot see.
   */
  readonly extraPasses?: readonly ResealPass[]
  /** Where the per-column report goes. Defaults to stdout. */
  readonly report?: (message: string) => void
  /** Where unreadable-row ids and the trailing failure summary go. Defaults to stderr. */
  readonly reportFatal?: (message: string) => void
}

function defaultReport(message: string): void {
  process.stdout.write(`${message}\n`)
}

function defaultReportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * Runs every reseal pass under the current `SECRET_ENCRYPTION_KEY` and
 * prints a report. Returns the exit code a script should return: 0 if every
 * examined value is now under the current key, 1 if any row was unreadable.
 *
 * The rotation procedure, in full:
 *
 *   1. Keep the current key. Add the new one as `SECRET_ENCRYPTION_KEY` and
 *      move the old value to `SECRET_ENCRYPTION_KEY_PREVIOUS`.
 *   2. Deploy. Deliveries keep signing: new secrets seal under the new key,
 *      and existing ones still open under the previous one.
 *   3. Run the reseal script. It rewrites every row still sealed under the
 *      old key.
 *   4. Remove `SECRET_ENCRYPTION_KEY_PREVIOUS` and deploy again.
 *
 * Safe to run at any point, including with no previous key set, where it
 * reports that everything is already current and writes nothing.
 *
 * Prefers `config.secretEncryption` (the top-level field an assembly's
 * `kelpie.config.ts` declares). Falls back to parsing `config.env` for
 * older assemblies and for `loadConfig`-based callers that never populate
 * the top-level field. Either path validates before the pass opens a row,
 * so a mistyped key throws `ConfigurationError` at boot rather than
 * reporting every row as unreadable.
 *
 * @throws ConfigurationError if neither `config.secretEncryption` nor the
 *   fallback env parse produces a valid `SecretEncryptionConfig`. The
 *   database is closed before the throw.
 */
export async function runReseal(options: RunResealOptions): Promise<number> {
  const report = options.report ?? defaultReport
  const reportFatal = options.reportFatal ?? defaultReportFatal
  const database = connectDatabase(options.config.databaseUrl, options.logger)

  let secretConfig = options.config.secretEncryption

  if (secretConfig === undefined) {
    const parsed = secretEncryptionConfigSchema.safeParse(options.config.env)

    if (!parsed.success) {
      await database.close()

      throw new ConfigurationError(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      )
    }

    secretConfig = parsed.data
  }

  const hasPrevious =
    secretConfig.SECRET_ENCRYPTION_KEY_PREVIOUS !== undefined &&
    secretConfig.SECRET_ENCRYPTION_KEY_PREVIOUS.trim().length > 0

  if (!hasPrevious) {
    report('SECRET_ENCRYPTION_KEY_PREVIOUS is not set. Nothing sealed under an older key can be read.')
  }

  const cipher = createSecretCipher(secretConfig)
  const passes: readonly ResealPass[] = [resealStoredSecrets, ...(options.extraPasses ?? [])]

  try {
    // Sequential rather than `Promise.all`, so two full-table passes never
    // contend for the pool at once. Each pass is idempotent; a run that
    // dies halfway leaves the finished rows current and re-running
    // completes the rest.
    const outcomes: ResealOutcome[] = []
    for (const pass of passes) {
      outcomes.push(await pass(database.db, cipher))
    }

    const columns = outcomes.flatMap((outcome) => outcome.columns)
    const examined = outcomes.reduce((total, outcome) => total + outcome.examined, 0)
    const resealed = outcomes.reduce((total, outcome) => total + outcome.resealed, 0)
    const unreadable = outcomes.reduce((total, outcome) => total + outcome.unreadable, 0)

    for (const column of columns) {
      report(
        `${column.label}: ${String(column.examined)} examined, ${String(column.resealed)} re-sealed, ${String(column.unreadable.length)} unreadable`,
      )

      for (const id of column.unreadable) {
        reportFatal(`  unreadable: ${id}`)
      }
    }

    if (unreadable > 0) {
      reportFatal(
        `\n${String(unreadable)} value(s) opened under neither key. They were sealed under a key that is not configured, or the rows have been altered. Nothing here can recover them: set SECRET_ENCRYPTION_KEY_PREVIOUS to the key they were sealed with and run this again, or have those records re-created.`,
      )

      return 1
    }

    report(
      resealed === 0
        ? `\nNothing to do: all ${String(examined)} value(s) are already sealed under the current key.`
        : `\nRe-sealed ${String(resealed)} of ${String(examined)} value(s). You can now remove SECRET_ENCRYPTION_KEY_PREVIOUS.`,
    )

    return 0
  } finally {
    await database.close()
  }
}
