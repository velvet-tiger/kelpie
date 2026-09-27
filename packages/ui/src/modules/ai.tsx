import { AiRunLogTab, AiSettingsTab } from '../pages/admin/AiPage.tsx'
import type { UiModule } from '../registry/registry.ts'
import { aiRunner } from './aiRunner.ts'
import { PersonIntakeWizard } from './PersonIntakeWizard.tsx'

/**
 * The UI half of the optional `ai` module in `@kelpie/server`.
 *
 * Not registered by default. An assembly that lists `createAiModule()` on the
 * server lists `aiUi` in `kelpie.ui.config.ts`, the same pairing any module
 * uses. Two tabs on core's Admin → AI page, Settings and Run log, before
 * core's MCP tab. On record pages it is the Agent menu's runner: Run dispatches straight to the "Kelpie AI" agent row, and
 * stays disabled until AI is enabled and has a key. Preview's Run… still lists
 * every registered agent, Kelpie AI included. On People it is the wizard behind
 * Add from notes.
 */
export const aiUi: UiModule = {
  id: 'ai',

  register(context) {
    context.adminTab('ai', { id: 'settings', label: 'Settings', order: 100, render: () => <AiSettingsTab /> })
    context.adminTab('ai', { id: 'runs', label: 'Run log', order: 200, render: () => <AiRunLogTab /> })
    context.agentRunner(aiRunner)
    // Ready on exactly the terms Run is: enabled, keyed, and its agent row in place.
    context.personIntake({ id: 'ai', useAvailability: aiRunner.useAvailability, Wizard: PersonIntakeWizard })
  },
}
