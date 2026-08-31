import type { LimitCapability } from '../../runtime/entitlements.ts'

/**
 * How many consent purposes one workspace may define. Open source answers
 * unlimited; the cloud can gate it later without a core change.
 */
export const CONSENT_PURPOSES_LIMIT: LimitCapability = {
  name: 'consent_purposes.limit',
  kind: 'limit',
  description:
    'How many consent purposes one workspace may define. Unlimited in open source.',
}
