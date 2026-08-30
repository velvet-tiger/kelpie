import type { LimitCapability } from '../../runtime/entitlements.ts'

/**
 * How many custom-field definitions one workspace may have across every object
 * type. Open source answers unlimited; the cloud can gate it later without a
 * core change.
 *
 * The workspace-wide count is what an entitlement caps. A per-(workspace,
 * object_type) ceiling is enforced separately in the service as a hard cap that
 * protects the database from a runaway create loop.
 */
export const CUSTOM_FIELDS_LIMIT: LimitCapability = {
  name: 'custom_fields.limit',
  kind: 'limit',
  description:
    'How many custom-field definitions one workspace may have across every object type. Unlimited in open source.',
}
