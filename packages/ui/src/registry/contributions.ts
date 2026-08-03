import type { RecordObjectType } from '@kelpie/schemas'
import type { ComponentType, ReactNode } from 'react'

/**
 * What a UI module may add to the shell, per the slot table in `modules.md`.
 *
 * Every slot renders nothing when empty. A core page has to look finished with
 * no modules loaded at all, because the open-source assembly is exactly that.
 */

export const NAV_SLOTS = ['primary', 'admin', 'account'] as const

export type NavSlot = (typeof NAV_SLOTS)[number]

export interface NavItem {
  readonly id: string
  readonly label: string
  /** Route path, the same string the shell's router matches. */
  readonly to: string
  /**
   * Where it sits among the core items. Core numbers itself in hundreds, so a
   * module can land between two of them without core renumbering.
   */
  readonly order?: number
  readonly icon?: ReactNode
}

/** A whole page, mounted under the shell's chrome. */
export interface RouteContribution {
  readonly path: string
  readonly element: ReactNode
}

/**
 * The record types a detail page exists for, and therefore the ones a module can
 * add a tab or a sidebar card to.
 *
 * Now in `@kelpie/schemas`, which is the shared-schema package this file's
 * previous note was waiting for. Re-exported rather than moved outright: it is
 * part of the contribution vocabulary, and a module author reading this file
 * should not have to follow an import to learn what a record type is.
 */
export { RECORD_OBJECT_TYPES } from '@kelpie/schemas'
export type { RecordObjectType }

/** What a tab or card is rendering against. Ids, not records: the contributor fetches its own data. */
export interface RecordContext {
  readonly objectType: RecordObjectType
  readonly recordId: string
}

export interface RecordTab {
  readonly id: string
  readonly label: string
  readonly order?: number
  readonly render: (context: RecordContext) => ReactNode
}

export interface RecordSidebarCard {
  readonly id: string
  readonly order?: number
  readonly render: (context: RecordContext) => ReactNode
}

export interface DashboardCard {
  readonly id: string
  readonly order?: number
  readonly render: () => ReactNode
}

export const INTEGRATION_CATEGORIES = [
  'messaging',
  'identity',
  'enrichment',
  'email',
  'calendar',
] as const

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number]

/** A catalog entry on the admin integrations page. Core owns the page and the connection lifecycle. */
export interface IntegrationProvider {
  readonly id: string
  readonly name: string
  readonly category: IntegrationCategory
  readonly description: string
  /** Rendered on the provider's own settings panel once connected. */
  readonly settings?: ComponentType<Record<string, never>>
}
