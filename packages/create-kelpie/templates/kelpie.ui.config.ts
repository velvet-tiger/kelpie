import type { UiModule } from '@kelpie/ui'

/**
 * The UI module list, and the only place it is declared.
 *
 * Separate from `kelpie.config.ts` because that one is imported by the Node
 * entry point, and a UI module pulls React in with it. The two lists differ
 * anyway: a module can contribute to one surface without the other, and most
 * do.
 *
 * Empty is the supported state. Core pages look finished with every slot
 * unfilled.
 */
export const uiModules: readonly UiModule[] = []
