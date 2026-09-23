import type { UiModule } from '@kelpie/ui'

/**
 * The open-source assembly's UI module list, and the only place it is declared.
 * The cloud assembly keeps its own list in its own repo.
 *
 * Separate from `kelpie.config.ts` because that one is imported by the Node
 * entry point, and a UI module pulls React in with it. The two lists are
 * different anyway: a module can contribute to one surface without the other,
 * and most of them do.
 *
 * Open source ships no UI modules. Every slot is empty, and core pages must
 * look finished in that state.
 */
export const uiModules: readonly UiModule[] = []
