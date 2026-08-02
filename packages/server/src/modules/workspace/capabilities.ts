import type { LimitCapability } from '../../runtime/entitlements.ts'

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
