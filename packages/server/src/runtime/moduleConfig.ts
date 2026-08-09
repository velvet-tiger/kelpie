import type { GrantProvider } from './entitlements.ts'
import type { KelpieModule } from './module.ts'
import { ModuleBootError } from './order.ts'

/**
 * The capability namespace `registry.ts` declares one flag under per
 * non-structural module: `module.<id>`. Kept here, alongside the two things
 * that read and write it, so the prefix has one owner.
 */
const MODULE_CAPABILITY_PREFIX = 'module.'

export function moduleCapabilityName(moduleId: string): string {
  return `${MODULE_CAPABILITY_PREFIX}${moduleId}`
}

/** The inverse of `moduleCapabilityName`, for a provider deciding whether a capability is its concern. */
export function parseModuleCapability(capabilityName: string): string | undefined {
  return capabilityName.startsWith(MODULE_CAPABILITY_PREFIX)
    ? capabilityName.slice(MODULE_CAPABILITY_PREFIX.length)
    : undefined
}

/**
 * Validates a deploy-time module override (`lib/moduleConfig.ts`) against the
 * assembled module list, the same way an unmet `requires` fails boot.
 *
 * @throws ModuleBootError listing every id that does not exist or names a
 *   structural module, which cannot be locked because it cannot be disabled.
 */
export function validateModuleConfig(
  overrides: Readonly<Record<string, boolean>>,
  modules: readonly KelpieModule[],
): void {
  const byId = new Map(modules.map((module) => [module.id, module]))
  const problems: string[] = []

  for (const moduleId of Object.keys(overrides)) {
    const module = byId.get(moduleId)

    if (module === undefined) {
      problems.push(`module config names "${moduleId}", which is not in the module list`)
      continue
    }

    if (module.structural === true) {
      problems.push(`module config names "${moduleId}", which is structural and cannot be disabled`)
    }
  }

  if (problems.length > 0) {
    throw new ModuleBootError(problems)
  }
}

/**
 * Answers every `module.<id>` capability the deploy-time file has an opinion
 * on. Registered ahead of any module's own provider (`registry.ts`), so a
 * locked value wins over a workspace's own setting: `EntitlementRegistry.check`
 * asks providers in registration order and stops at the first answer.
 */
export function createModuleConfigProvider(overrides: Readonly<Record<string, boolean>>): GrantProvider {
  return (_workspaceId, capability) => {
    const moduleId = parseModuleCapability(capability.name)
    const enabled = moduleId === undefined ? undefined : overrides[moduleId]

    return Promise.resolve(enabled === undefined ? undefined : { kind: 'flag', granted: enabled })
  }
}
