import type { Database } from '../../lib/database.ts'
import { SecretDecryptionError } from '../../lib/secrets.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { ResealColumnOutcome, ResealOutcome } from '../reseal.ts'
import { listSettingsRows, updateSealedSettings } from './repository.ts'

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
 */

const DISPATCH_LABEL = 'ai_settings.dispatch_secret_encrypted'
const API_KEY_LABEL = 'ai_settings.api_key_encrypted'

export async function resealAiSecrets(db: Database, cipher: SecretCipher): Promise<ResealOutcome> {
  const rows = await listSettingsRows(db)
  const dispatch = { examined: 0, resealed: 0, unreadable: [] as string[] }
  const apiKey = { examined: 0, resealed: 0, unreadable: [] as string[] }

  for (const row of rows) {
    const changes: { dispatchSecretEncrypted?: string; apiKeyEncrypted?: string } = {}

    // Unread since dispatch went in-process, and cleared on the next save,
    // but a value that remains still has to open under the new key.
    if (row.dispatchSecretEncrypted !== null) {
      dispatch.examined += 1
      const dispatchReplacement = resealOne(cipher, row.dispatchSecretEncrypted, row.workspaceId, dispatch)
      if (dispatchReplacement !== undefined) {
        changes.dispatchSecretEncrypted = dispatchReplacement
      }
    }

    if (row.apiKeyEncrypted !== null) {
      apiKey.examined += 1
      const apiKeyReplacement = resealOne(cipher, row.apiKeyEncrypted, row.workspaceId, apiKey)
      if (apiKeyReplacement !== undefined) {
        changes.apiKeyEncrypted = apiKeyReplacement
      }
    }

    if (changes.dispatchSecretEncrypted !== undefined || changes.apiKeyEncrypted !== undefined) {
      await updateSealedSettings(db, row.workspaceId, changes, new Date())
    }
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
  }
}

/** The new sealed value, or undefined when the value is current or unreadable. */
function resealOne(
  cipher: SecretCipher,
  sealed: string,
  workspaceId: string,
  tally: { resealed: number; unreadable: string[] },
): string | undefined {
  let replacement: string | undefined
  try {
    replacement = cipher.reseal(sealed)
  } catch (error: unknown) {
    if (!(error instanceof SecretDecryptionError)) throw error
    tally.unreadable.push(workspaceId)
    return undefined
  }

  if (replacement !== undefined) {
    tally.resealed += 1
  }

  return replacement
}
