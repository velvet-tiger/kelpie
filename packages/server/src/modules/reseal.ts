import { and, eq } from 'drizzle-orm'

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
 *
 * The service runs while this does, so a secret can be rotated or replaced
 * between the read of a row and its write. Each write therefore applies only
 * to the value that was read, and a row that changed is left as the service
 * wrote it.
 */

/** One sealed column, and how to read and rewrite it. */
interface SealedColumn {
  /** `table.column`, for a report an operator can act on. */
  readonly label: string
  readonly read: (db: Database) => Promise<readonly { id: string; sealed: string | null }[]>
  /**
   * Writes `sealed` over `expected`, and over nothing else.
   *
   * @returns False when the column no longer holds `expected`, or the row is
   *   gone. Nothing was written.
   */
  readonly replace: (db: Database, id: string, expected: string, sealed: string) => Promise<boolean>
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
    replace: async (db, id, expected, sealed) => {
      const replaced = await db
        .update(webhooks)
        .set({ secretEncrypted: sealed })
        .where(and(eq(webhooks.id, id), eq(webhooks.secretEncrypted, expected)))
        .returning({ id: webhooks.id })

      return replaced.length > 0
    },
  },
  {
    label: 'webhooks.previous_secret_encrypted',
    read: async (db) =>
      db.select({ id: webhooks.id, sealed: webhooks.previousSecretEncrypted }).from(webhooks),
    replace: async (db, id, expected, sealed) => {
      const replaced = await db
        .update(webhooks)
        .set({ previousSecretEncrypted: sealed })
        .where(and(eq(webhooks.id, id), eq(webhooks.previousSecretEncrypted, expected)))
        .returning({ id: webhooks.id })

      return replaced.length > 0
    },
  },
  {
    label: 'agent_registrations.auth_header_encrypted',
    read: async (db) =>
      db
        .select({ id: agentRegistrations.id, sealed: agentRegistrations.authHeaderEncrypted })
        .from(agentRegistrations),
    replace: async (db, id, expected, sealed) => {
      const replaced = await db
        .update(agentRegistrations)
        .set({ authHeaderEncrypted: sealed })
        .where(and(eq(agentRegistrations.id, id), eq(agentRegistrations.authHeaderEncrypted, expected)))
        .returning({ id: agentRegistrations.id })

      return replaced.length > 0
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
  /**
   * Values that changed between the read and the write, and were left as the
   * service wrote them. Counted in `examined` and not in `resealed`.
   *
   * Counted and not named: an operator does nothing to these rows by hand.
   * `runReseal` reads them again in its next round.
   *
   * Optional, so a pass written before this field still fits the type. A
   * pass that leaves it out reports none.
   */
  readonly changed?: number
}

export interface ResealOutcome {
  readonly columns: readonly ResealColumnOutcome[]
  readonly examined: number
  readonly resealed: number
  readonly unreadable: number
  /** The sum of the columns' `changed`. Optional for the same reason; absent means none. */
  readonly changed?: number
}

/**
 * Reads every sealed column, and rewrites anything not already under the
 * current key.
 *
 * Does not throw for a row it cannot open. One unreadable row must not stop the
 * pass from fixing every other one, so it is reported and the caller decides
 * what a non-empty `unreadable` means.
 *
 * Never writes over a value it did not read. A row that changed during the
 * pass is counted in `changed` and left alone.
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
    let changed = 0

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

      // The service may have rotated or replaced this secret since the read.
      // Writing regardless would put the old secret back, sealed under the
      // new key, where the customer's new one should be. So the write applies
      // only to the value that was read, and the service's value stays.
      //
      // A changed value is counted and not assumed current. `runReseal`
      // reads every column again after a round that changed or skipped a
      // value, and says the previous key can go only after a round that
      // found every value under the current key.
      if (await column.replace(db, row.id, row.sealed, next)) {
        resealed += 1
      } else {
        changed += 1
      }
    }

    columns.push({ label: column.label, examined: rows.length, resealed, unreadable, changed })
  }

  return {
    columns,
    examined: columns.reduce((total, column) => total + column.examined, 0),
    resealed: columns.reduce((total, column) => total + column.resealed, 0),
    unreadable: columns.reduce((total, column) => total + column.unreadable.length, 0),
    changed: columns.reduce((total, column) => total + countChanged(column), 0),
  }
}

/** A pass written before `changed` existed leaves it out, and reported no such value. */
function countChanged(outcome: { readonly changed?: number }): number {
  return outcome.changed ?? 0
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
 * How many rounds one run makes before it gives up. A round is every pass,
 * one time.
 *
 * The usual run is two rounds: one that re-seals, and one that reads
 * everything again and finds nothing to do. A further round is needed only
 * when the service changed a secret during the round before it, and a person
 * who rotates a secret at that moment does so once or twice, not in every
 * round. A run that is still writing after five rounds is not catching up
 * with people. Something seals under the previous key all the time, which is
 * an instance of the service still running with the old key as its current
 * one, and no number of rounds ends that.
 */
export const MAX_RESEAL_ROUNDS = 5

/** Every value is under the current key. The previous key can go. */
export const RESEAL_EXIT_SETTLED = 0

/** Some value opened under neither key. Nothing here can recover it. */
export const RESEAL_EXIT_UNREADABLE = 1

/**
 * The last round still re-sealed or skipped a value. Not zero, so a script
 * that removes the previous key after a successful reseal stops here.
 */
export const RESEAL_EXIT_UNSETTLED = 2

/** One column's figures over every round of a run. */
interface ColumnTotals {
  /** From the last round: how many values the column holds now. */
  examined: number
  /** Summed over the rounds. */
  resealed: number
  /** Summed over the rounds. */
  changed: number
  /** From the last round: a row that stays unreadable is one row, not one for each round. */
  unreadable: readonly string[]
}

/** What the rounds of one run came to. */
interface ResealRun {
  /** By column label, in the order the passes reported them. A label names one column, so two passes never share one. */
  readonly totals: ReadonlyMap<string, ColumnTotals>
  readonly rounds: number
  /** What the last round wrote and skipped. Both zero is what `settled` means. */
  readonly lastRound: { readonly resealed: number; readonly changed: number }
  readonly settled: boolean
}

/**
 * Runs every pass, round after round, until a round re-seals nothing and
 * skips nothing, or `MAX_RESEAL_ROUNDS` is reached.
 */
async function resealUntilSettled(
  passes: readonly ResealPass[],
  db: Database,
  cipher: SecretCipher,
): Promise<ResealRun> {
  const totals = new Map<string, ColumnTotals>()
  let rounds = 0
  let lastRound = { resealed: 0, changed: 0 }
  let settled = false

  while (!settled && rounds < MAX_RESEAL_ROUNDS) {
    rounds += 1
    lastRound = { resealed: 0, changed: 0 }

    // Sequential rather than `Promise.all`, so two full-table passes never
    // contend for the pool at once. Each pass is idempotent; a run that
    // dies halfway leaves the finished rows current and re-running
    // completes the rest.
    for (const pass of passes) {
      const outcome = await pass(db, cipher)

      // From the columns and not from the outcome's own totals, so a pass
      // that fills in one and not the other is still counted.
      for (const column of outcome.columns) {
        const before = totals.get(column.label)
        const changedInColumn = countChanged(column)

        totals.set(column.label, {
          examined: column.examined,
          resealed: (before?.resealed ?? 0) + column.resealed,
          changed: (before?.changed ?? 0) + changedInColumn,
          unreadable: column.unreadable,
        })
        lastRound.resealed += column.resealed
        lastRound.changed += changedInColumn
      }
    }

    settled = lastRound.resealed === 0 && lastRound.changed === 0
  }

  return { totals, rounds, lastRound, settled }
}

/**
 * Runs every reseal pass under the current `SECRET_ENCRYPTION_KEY`, again and
 * again until a round re-seals nothing and skips nothing, and prints one
 * report for the whole run.
 *
 * The service runs while this does, so one round is not proof. A person can
 * rotate a secret during it, and a row can change between its read and its
 * write. Only a round that wrote nothing and skipped nothing has read every
 * value and found each one under the current key. So that round is what ends
 * the run, and what lets the report say the previous key can go.
 *
 * @returns The exit code a script should return. `RESEAL_EXIT_SETTLED` (0)
 *   when the last round found every value under the current key.
 *   `RESEAL_EXIT_UNREADABLE` (1) when a value opened under neither key.
 *   `RESEAL_EXIT_UNSETTLED` (2) when `MAX_RESEAL_ROUNDS` rounds were not
 *   enough: the previous key must stay, and the run must be repeated.
 *
 * The rotation procedure, in full:
 *
 *   1. Keep the current key. Add the new one as `SECRET_ENCRYPTION_KEY` and
 *      move the old value to `SECRET_ENCRYPTION_KEY_PREVIOUS`.
 *   2. Deploy. Deliveries keep signing: new secrets seal under the new key,
 *      and existing ones still open under the previous one.
 *   3. Run the reseal script. It rewrites every row still sealed under the
 *      old key, and exits 0 only when it has read every value again and
 *      found each one under the new key.
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
    const { totals, rounds, lastRound, settled } = await resealUntilSettled(passes, database.db, cipher)

    const columns = [...totals.entries()]
    const examined = columns.reduce((total, [, column]) => total + column.examined, 0)
    const resealed = columns.reduce((total, [, column]) => total + column.resealed, 0)
    const changed = columns.reduce((total, [, column]) => total + column.changed, 0)
    const unreadable = columns.reduce((total, [, column]) => total + column.unreadable.length, 0)

    // One line for each column for the whole run. A block for each round
    // would repeat every column up to five times to say the same thing.
    for (const [label, column] of columns) {
      report(
        `${label}: ${String(column.examined)} examined, ${String(column.resealed)} re-sealed, ${String(column.unreadable.length)} unreadable${column.changed === 0 ? '' : `, ${String(column.changed)} changed during the run`}`,
      )

      for (const id of column.unreadable) {
        reportFatal(`  unreadable: ${id}`)
      }
    }

    if (!settled) {
      reportFatal(
        `\nNot finished. After ${String(MAX_RESEAL_ROUNDS)} rounds, the last round still re-sealed ${String(lastRound.resealed)} value(s) and found ${String(lastRound.changed)} that changed while it ran. Do not remove SECRET_ENCRYPTION_KEY_PREVIOUS. Something still seals secrets under the previous key: check that every instance of the service runs with the new SECRET_ENCRYPTION_KEY. Then run this again.`,
      )
    }

    if (unreadable > 0) {
      reportFatal(
        `\n${String(unreadable)} value(s) opened under neither key. They were sealed under a key that is not configured, or the rows have been altered. Nothing here can recover them: set SECRET_ENCRYPTION_KEY_PREVIOUS to the key they were sealed with and run this again, or have those records re-created.`,
      )

      return RESEAL_EXIT_UNREADABLE
    }

    if (!settled) {
      return RESEAL_EXIT_UNSETTLED
    }

    const removable = hasPrevious ? ' You can now remove SECRET_ENCRYPTION_KEY_PREVIOUS.' : ''

    if (resealed === 0 && changed === 0) {
      report(
        `\nNothing to do: all ${String(examined)} value(s) are already sealed under the current key.${removable}`,
      )

      return RESEAL_EXIT_SETTLED
    }

    const skipped =
      changed === 0 ? '' : ` ${String(changed)} value(s) changed during the run and were read again.`

    report(
      `\nRe-sealed ${String(resealed)} value(s) in ${String(rounds)} rounds.${skipped} All ${String(examined)} value(s) are now sealed under the current key.${removable}`,
    )

    return RESEAL_EXIT_SETTLED
  } finally {
    await database.close()
  }
}
