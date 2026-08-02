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
 * A copy of the server's list, because `@kelpie/ui` importing `@kelpie/server`
 * would drag Drizzle, postgres.js and Node built-ins into the browser bundle
 * (roadmap decision 8). It moves to the shared schema package when that lands.
 */
export const RECORD_OBJECT_TYPES = [
  'person',
  'company',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'role',
  'candidate',
] as const

export type RecordObjectType = (typeof RECORD_OBJECT_TYPES)[number]

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
