import type { Database } from '../../lib/database.ts'
import { SecretDecryptionError } from '../../lib/secrets.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { ResealColumnOutcome, ResealOutcome } from '../reseal.ts'
import { listSettingsRows, replaceSealedSetting } from './repository.ts'
import type { SealedSettingColumn } from './repository.ts'

/**
 * Re-seals this module's stored credentials under the current
 * `SECRET_ENCRYPTION_KEY`.
 *
 * Core's `resealStoredSecrets` walks core's always-present tables. This
 * module is optional, so its table exists only in an assembly that lists it,
 * and the assembly passes this function to `runReseal` as an `extraPasses`
 * entry. Two sealed columns per row: the workspace's provider key when it has
 * one, and a dispatch secret left from before dispatch went in-process.
 * `unreadable` names the workspace id. Each row is independent, so a run
 * that dies halfway leaves the rows it finished current and the rest still
 * openable with the previous key. Re-running finishes the job.
 *
 * The service runs while this does, so an admin can replace the key or save
 * the settings between the read of a row and its write. Each column is
 * written only over the value that was read. A column that changed is left
 * as the service wrote it and counted in `changed`.
 */

const DISPATCH_LABEL = 'ai_settings.dispatch_secret_encrypted'
const API_KEY_LABEL = 'ai_settings.api_key_encrypted'

/** One column's running totals. */
interface ColumnTally {
  examined: number
  resealed: number
  changed: number
  readonly unreadable: string[]
}

function emptyTally(): ColumnTally {
  return { examined: 0, resealed: 0, changed: 0, unreadable: [] }
}

export async function resealAiSecrets(db: Database, cipher: SecretCipher): Promise<ResealOutcome> {
  const rows = await listSettingsRows(db)
  const dispatch = emptyTally()
  const apiKey = emptyTally()

  /**
   * Re-seals one column of one row. A null holds no secret and is not
   * examined.
   */
  async function resealColumn(
    workspaceId: string,
    column: SealedSettingColumn,
    sealed: string | null,
    tally: ColumnTally,
  ): Promise<void> {
    if (sealed === null) {
      return
    }

    tally.examined += 1

    const replacement = replacementFor(cipher, sealed, workspaceId, tally)

    if (replacement === undefined) {
      return
    }

    // A save between the read and this write put a new value in the column,
    // or cleared it. That value stays: writing ours would put the old secret
    // back where the admin's new one should be. It is counted, so that
    // `runReseal` reads the row again in another round.
    if (await replaceSealedSetting(db, workspaceId, column, sealed, replacement, new Date())) {
      tally.resealed += 1
    } else {
      tally.changed += 1
    }
  }

  for (const row of rows) {
    // Unread since dispatch went in-process, and cleared on the next save,
    // but a value that remains still has to open under the new key.
    await resealColumn(row.workspaceId, 'dispatchSecretEncrypted', row.dispatchSecretEncrypted, dispatch)
    await resealColumn(row.workspaceId, 'apiKeyEncrypted', row.apiKeyEncrypted, apiKey)
  }

  const columns: ResealColumnOutcome[] = [
    { label: DISPATCH_LABEL, ...dispatch },
    { label: API_KEY_LABEL, ...apiKey },
  ]

  return {
    columns,
    examined: dispatch.examined + apiKey.examined,
    resealed: dispatch.resealed + apiKey.resealed,
    unreadable: dispatch.unreadable.length + apiKey.unreadable.length,
    changed: dispatch.changed + apiKey.changed,
  }
}

/** The new sealed value, or undefined when the value is current or unreadable. */
function replacementFor(
  cipher: SecretCipher,
  sealed: string,
  workspaceId: string,
  tally: ColumnTally,
): string | undefined {
  try {
    return cipher.reseal(sealed)
  } catch (error: unknown) {
    if (!(error instanceof SecretDecryptionError)) throw error
    tally.unreadable.push(workspaceId)
    return undefined
  }
}
