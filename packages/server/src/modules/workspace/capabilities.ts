import type { FlagCapability, LimitCapability } from '../../runtime/entitlements.ts'

/**
 * Capabilities the workspace module declares.
 *
 * A capability is a name plus what kind of answer it takes. Services reference
 * these constants rather than the string, so a typo is a compile error.
 */

export const SEATS_LIMIT: LimitCapability = {
  name: 'seats.limit',
  kind: 'limit',
  description: 'How many people can belong to one workspace. Unlimited in open source.',
}

/**
 * Whether a workspace's own members may use it at all. Checked once per
 * request by a blanket `/v1` and `/mcp` middleware (`app.ts`), not by any
 * service — this is deliberately coarser than every other capability here.
 * Granted by default: no provider answers it in a self-hosted assembly, so
 * `EntitlementRegistry`'s open-source default (`entitlements.ts`) applies
 * and nothing changes for anyone without a module that supplies one.
 */
export const WORKSPACE_ACCESS: FlagCapability = {
  name: 'workspace.access',
  kind: 'flag',
  description: 'Whether this workspace may be used at all. A deployment-wide override, not a plan feature.',
}
