import type { AiDrawerTask } from './aiDrawerState.ts'
import { PersonIntakePanel } from './PersonIntakePanel.tsx'

export const PERSON_INTAKE_TASK_ID = 'person-intake'

/** The AI drawer task People's **Add from notes** opens. */
export function personIntakeTask(): AiDrawerTask {
  return {
    id: PERSON_INTAKE_TASK_ID,
    title: 'Add a person from notes',
    description: 'Paste what you know. Kelpie builds the record from it.',
    render: (controls) => <PersonIntakePanel onClose={controls.finish} onPendingChange={controls.setPending} />,
  }
}
