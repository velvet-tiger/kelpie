import { AppError } from '../lib/errors.ts'
import { ModuleBootError } from './order.ts'

/**
 * Feature gating that stays inert in open source.
 *
 * Modules and core declare capabilities. Services check them where gating
 * matters. The open-source assembly registers no grant provider, so every check
 * answers granted and unlimited: a self-hoster never meets a paywall.
 *
 * The cloud billing module supplies a provider that maps subscription state to
 * grants. Nothing else about the check changes.
 */

/** A yes-or-no capability, e.g. `integrations.gmail`. */
export interface FlagCapability {
  readonly name: string
  readonly kind: 'flag'
  readonly description: string
}

/** A counted capability, e.g. `seats.limit`. */
export interface LimitCapability {
  readonly name: string
  readonly kind: 'limit'
  readonly description: string
}

export type Capability = FlagCapability | LimitCapability

/** What a check answers. `limit: null` means unlimited, not zero. */
export type Entitlement =
  | { readonly kind: 'flag'; readonly granted: boolean }
  | { readonly kind: 'limit'; readonly limit: number | null }

/**
 * Supplies grants for a workspace.
 *
 * @returns The grant, or undefined to express no opinion and let the next
 *   provider, or the open-source default, answer.
 */
export type GrantProvider = (
  workspaceId: string,
  capability: Capability,
) => Promise<Entitlement | undefined>

export interface EntitlementRegistry {
  /** Declares a capability. Declaring one name twice fails boot. */
  declare(capability: Capability): void
  /** Registers a source of grants. Providers are asked in registration order. */
  provide(provider: GrantProvider): void
  /**
   * @throws AppError 500 if nothing declared this capability, which means a typo
   *   rather than a missing grant.
   */
  check(workspaceId: string, name: string): Promise<Entitlement>
  /** Everything declared, for an admin page or a support answer. */
  capabilities(): readonly Capability[]
}

/** What a capability answers when no provider has an opinion. */
function openSourceDefault(capability: Capability): Entitlement {
  return capability.kind === 'flag' ? { kind: 'flag', granted: true } : { kind: 'limit', limit: null }
}

export function createEntitlementRegistry(): EntitlementRegistry {
  const declared = new Map<string, Capability>()
  const providers: GrantProvider[] = []

  return {
    declare(capability) {
      if (declared.has(capability.name)) {
        throw new ModuleBootError([`capability "${capability.name}" is declared twice`])
      }

      declared.set(capability.name, capability)
    },

    provide(provider) {
      providers.push(provider)
    },

    async check(workspaceId, name) {
      const capability = declared.get(name)

      if (capability === undefined) {
        throw new Error(`No module declared the capability "${name}"`)
      }

      for (const provider of providers) {
        const grant = await provider(workspaceId, capability)

        if (grant !== undefined) {
          return grant
        }
      }

      return openSourceDefault(capability)
    },

    capabilities() {
      return [...declared.values()]
    },
  }
}

/**
 * Guards a gated action.
 *
 * @throws AppError 403 `entitlement_required` when the capability is not granted.
 */
export async function requireCapability(
  entitlements: EntitlementRegistry,
  workspaceId: string,
  name: string,
): Promise<void> {
  const entitlement = await entitlements.check(workspaceId, name)

  if (entitlement.kind === 'flag' && !entitlement.granted) {
    throw new AppError('entitlement_required', `Your plan does not include ${name}`)
  }
}

/**
 * Reads a counted capability.
 *
 * @returns The limit, or null for unlimited.
 * @throws Error if the capability was declared as a flag rather than a limit.
 */
export async function limitFor(
  entitlements: EntitlementRegistry,
  workspaceId: string,
  name: string,
): Promise<number | null> {
  const entitlement = await entitlements.check(workspaceId, name)

  if (entitlement.kind !== 'limit') {
    throw new Error(`Capability "${name}" is a flag, not a limit`)
  }

  return entitlement.limit
}
