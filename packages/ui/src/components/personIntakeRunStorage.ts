import { personIntakeSavedRunSchema } from '@kelpie/schemas'
import type { PersonIntakeSavedRun } from '@kelpie/schemas'

/**
 * The person-intake run a tab is working on, kept in `sessionStorage` so a
 * reload finds it again. One entry per workspace, because a task belongs to
 * one workspace.
 *
 * A convenience, not a record: storage can be blocked, full or cleared, and
 * every read and write here treats a failure as "no saved run". The run itself
 * lives on the server, which keeps its result for an hour.
 */

const KEY_PREFIX = 'kelpie.personIntake.run.'

function keyFor(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`
}

/** The saved run for this workspace, or undefined when there is none or it cannot be read. */
export function readSavedIntakeRun(workspaceId: string): PersonIntakeSavedRun | undefined {
  let stored: string | null

  try {
    stored = sessionStorage.getItem(keyFor(workspaceId))
  } catch {
    // Blocked storage (a private window, a sandboxed frame) means no saved run.
    return undefined
  }

  if (stored === null) return undefined

  try {
    const parsed = personIntakeSavedRunSchema.safeParse(JSON.parse(stored))

    return parsed.success ? parsed.data : undefined
  } catch {
    // Not JSON: written by hand or by something else. Treat it as no saved run.
    return undefined
  }
}

export function saveIntakeRun(workspaceId: string, run: PersonIntakeSavedRun): void {
  try {
    sessionStorage.setItem(keyFor(workspaceId), JSON.stringify(run))
  } catch {
    // Not saving costs only the reload case: the task still runs in this tab.
  }
}

export function clearSavedIntakeRun(workspaceId: string): void {
  try {
    sessionStorage.removeItem(keyFor(workspaceId))
  } catch {
    // Nothing could have been saved either.
  }
}
