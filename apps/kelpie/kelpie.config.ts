import type { KelpieModule } from '@kelpie/server'

/**
 * The open-source assembly's module list, and the only place it is declared.
 * The cloud assembly keeps its own list in its own repo and adds proprietary
 * modules to it.
 *
 * Boot registers these in order, after resolving `requires`. An unknown id, an
 * unmet dependency, or invalid module config stops boot.
 */
export const modules: readonly KelpieModule[] = []
