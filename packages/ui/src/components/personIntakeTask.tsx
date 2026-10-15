import { useEffect, useRef } from 'react'

import { useSession } from '../api/resources/session.ts'
import { useAiDrawer } from './aiDrawerState.ts'
import type { AiDrawerTask } from './aiDrawerState.ts'
import { PersonIntakePanel } from './PersonIntakePanel.tsx'
import { clearSavedIntakeRun, readSavedIntakeRun } from './personIntakeRunStorage.ts'

export const PERSON_INTAKE_TASK_ID = 'person-intake'

/** The AI drawer task People's **Add from notes** opens. */
export function personIntakeTask(): AiDrawerTask {
  return {
    id: PERSON_INTAKE_TASK_ID,
    title: 'Add a person from notes',
    description: 'Paste what you know. Kelpie builds the record from it.',
    render: (controls) => <PersonIntakePanel onClose={controls.finish} onPendingChange={controls.setPending} />,
    // Done, Discard and a workspace switch all end the task, and none of them
    // should bring it back on the next reload.
    onEnd: (workspaceId) => {
      if (workspaceId !== null) clearSavedIntakeRun(workspaceId)
    },
  }
}

/**
 * Finds a person-intake run this tab saved before a reload, and makes it the
 * drawer's task again with the drawer closed. The header button shows it, and
 * the page stays uncovered. The wizard reads the saved run when it mounts and
 * picks up on the saved step.
 *
 * Once per workspace the session lands in, so a task the user ended is not
 * brought back while the page stays loaded.
 */
export function useRestorePersonIntake(): void {
  const { session } = useSession()
  const { restore } = useAiDrawer()
  const workspaceId = session?.workspaceId ?? null
  const checked = useRef<string | null>(null)

  useEffect(() => {
    if (workspaceId === null || checked.current === workspaceId) return

    checked.current = workspaceId
    if (readSavedIntakeRun(workspaceId) !== undefined) restore(personIntakeTask())
  }, [workspaceId, restore])
}
