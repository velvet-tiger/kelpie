import type { RecordTargetType } from '@kelpie/schemas'

/**
 * The lists a new workspace starts with. Data, not migrations: a workspace
 * owner may rename or delete them, and add any others they need.
 */

export interface StarterList {
  readonly slug: string
  readonly name: string
  readonly targetType: RecordTargetType
}

export const STARTER_LISTS: readonly StarterList[] = [
  { slug: 'newsletter', name: 'Newsletter', targetType: 'person' },
]
