import { aiUi } from '@kelpie/ui'
import type { UiModule } from '@kelpie/ui'

/**
 * The UI module list, and the only place it is declared.
 *
 * Separate from `kelpie.config.ts` because that one is imported by the Node
 * entry point, and a UI module pulls React in with it. The two lists differ
 * anyway: a module can contribute to one surface without the other, and most
 * do.
 *
 * `aiUi` is the admin page for the optional `ai` server module. It pairs with
 * `createAiModule()` in `kelpie.config.ts`; remove both to leave AI out. An
 * empty list is supported too: core pages look finished with every slot
 * unfilled.
 */
export const uiModules: readonly UiModule[] = [aiUi]
