import { AiPage } from '../pages/admin/AiPage.tsx'
import type { UiModule } from '../registry/registry.ts'

/**
 * The UI half of the optional `ai` module in `@kelpie/server`.
 *
 * Not registered by default. An assembly that lists `createAiModule()` on the
 * server lists `aiUi` in `kelpie.ui.config.ts`, the same pairing any module
 * uses. One Admin nav item, after MCP, and one page. There is nothing to add to
 * record pages: the Run dialog already lists the workspace's agents, and
 * enabling AI adds the "Kelpie AI" row to that list.
 */
export const aiUi: UiModule = {
  id: 'ai',

  register(context) {
    context.nav('admin', { id: 'ai', label: 'AI', to: '/admin/ai', order: 550 })
    context.route({ path: 'admin/ai', element: <AiPage /> })
  },
}
