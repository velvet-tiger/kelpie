import { coreModules } from '@kelpie/server'
import type { KelpieModule } from '@kelpie/server'

/**
 * The server module list, and the only place it is declared.
 *
 * Boot registers these in order, after resolving what each one requires. An
 * unknown id, an unmet dependency, or invalid module configuration stops boot
 * rather than starting a service that is missing a feature.
 *
 * Add a module by installing it and putting it in this array:
 *
 *   import { smtpEmail } from '@kelpie/module-smtp-email'
 *
 *   export const modules: readonly KelpieModule[] = [...coreModules, smtpEmail]
 *
 * Removing one from `coreModules` is possible too, but core modules depend on
 * each other, so boot will tell you if you have taken out something another
 * module needs.
 */
export const modules: readonly KelpieModule[] = [...coreModules]
