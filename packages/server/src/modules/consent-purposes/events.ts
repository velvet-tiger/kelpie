import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events for the consent-purposes catalog.
 *
 * `target` is the purpose definition. Per-person consent writes ride each
 * person's own `.updated` event, with per-purpose entries in `changed` shaped
 * as `consents.<slug>`.
 */
export const consentPurposesEvents = {
  'consent_purposes.purpose.created': z.object({ slug: z.string() }),
  'consent_purposes.purpose.updated': z.object({
    slug: z.string(),
    changed: z.array(z.string()).readonly(),
  }),
  'consent_purposes.purpose.deleted': z.object({ slug: z.string() }),
} satisfies ModuleEventCatalog

export interface ConsentPurposeCreatedData {
  readonly slug: string
}
export interface ConsentPurposeUpdatedData {
  readonly slug: string
  readonly changed: readonly string[]
}
export interface ConsentPurposeDeletedData {
  readonly slug: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'consent_purposes.purpose.created': ConsentPurposeCreatedData
    'consent_purposes.purpose.updated': ConsentPurposeUpdatedData
    'consent_purposes.purpose.deleted': ConsentPurposeDeletedData
  }
}
