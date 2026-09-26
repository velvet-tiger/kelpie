import { AiPage } from '../pages/admin/AiPage.tsx'
import type { UiModule } from '../registry/registry.ts'
import { aiRunner } from './aiRunner.ts'

/**
 * The UI half of the optional `ai` module in `@kelpie/server`.
 *
 * Not registered by default. An assembly that lists `createAiModule()` on the
 * server lists `aiUi` in `kelpie.ui.config.ts`, the same pairing any module
 * uses. One Admin nav item, after MCP, and one page. On record pages it is the
 * Agent menu's runner: Run dispatches straight to the "Kelpie AI" agent row, and
 * stays disabled until AI is enabled and has a key. Preview's Run… still lists
 * every registered agent, Kelpie AI included.
 */
export const aiUi: UiModule = {
  id: 'ai',

  register(context) {
    context.nav('admin', { id: 'ai', label: 'AI', to: '/admin/ai', order: 550 })
    context.route({ path: 'admin/ai', element: <AiPage /> })
    context.agentRunner(aiRunner)
  },
}
