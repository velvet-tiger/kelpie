import { personIntakeSavedRunSchema } from '@kelpie/schemas'
import type { PersonIntakeSavedRun } from '@kelpie/schemas'

/**
 * The person-intake run a tab is working on, kept in `sessionStorage` so a
 * reload finds it again. One entry per workspace and user, because a task
 * belongs to one workspace, and the notes in it belong to the person who
 * typed them: a sign-out, or another user signing in to the same tab, must
 * not show them.
 *
 * A convenience, not a record: storage can be blocked, full or cleared, and
 * every read and write here treats a failure as "no saved run". The run itself
 * lives on the server, which keeps its result for an hour.
 */

const KEY_PREFIX = 'kelpie.personIntake.run.'

function keyFor(workspaceId: string, userId: string): string {
  return `${KEY_PREFIX}${workspaceId}.${userId}`
}

/** Every saved-run key in this tab's storage. Empty when storage cannot be read. */
function savedKeys(): string[] {
  try {
    const keys: string[] = []

    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index)
      if (key !== null && key.startsWith(KEY_PREFIX)) keys.push(key)
    }

    return keys
  } catch {
    // Blocked storage holds nothing to clear.
    return []
  }
}

function removeKeys(keys: readonly string[]): void {
  for (const key of keys) {
    try {
      sessionStorage.removeItem(key)
    } catch {
      // Blocked storage: nothing could have been saved either.
    }
  }
}

/**
 * The saved run for this workspace and user, or undefined when there is none
 * or it cannot be read. An entry whose `user_id` is not this user's reads as
 * none.
 */
export function readSavedIntakeRun(workspaceId: string, userId: string): PersonIntakeSavedRun | undefined {
  let stored: string | null

  try {
    stored = sessionStorage.getItem(keyFor(workspaceId, userId))
  } catch {
    // Blocked storage (a private window, a sandboxed frame) means no saved run.
    return undefined
  }

  if (stored === null) return undefined

  try {
    const parsed = personIntakeSavedRunSchema.safeParse(JSON.parse(stored))

    return parsed.success && parsed.data.user_id === userId ? parsed.data : undefined
  } catch {
    // Not JSON: written by hand or by something else. Treat it as no saved run.
    return undefined
  }
}

export function saveIntakeRun(workspaceId: string, run: PersonIntakeSavedRun): void {
  try {
    sessionStorage.setItem(keyFor(workspaceId, run.user_id), JSON.stringify(run))
  } catch {
    // Not saving costs only the reload case: the task still runs in this tab.
  }
}

/** Forgets the workspace's saved run, whoever saved it. */
export function clearSavedIntakeRuns(workspaceId: string): void {
  removeKeys(savedKeys().filter((key) => key.startsWith(`${KEY_PREFIX}${workspaceId}.`)))
}

/** Forgets every saved run in this tab. Called on sign-out. */
export function clearAllSavedIntakeRuns(): void {
  removeKeys(savedKeys())
}

/** Forgets every saved run another user left in this tab. Called when the signed-in user is known. */
export function clearOtherUsersIntakeRuns(userId: string): void {
  removeKeys(savedKeys().filter((key) => !key.endsWith(`.${userId}`)))
}
