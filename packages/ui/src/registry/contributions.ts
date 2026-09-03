import type { ExtensibleRecordType } from '@kelpie/schemas'
import type { ReactNode } from 'react'

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

/**
 * What a sign-in method is rendering against.
 *
 * `intent` because the same button reads differently on the two pages, and
 * `next` because where the browser lands afterwards is the page's to decide,
 * not the module's. The page has already checked it is a path within the app.
 */
export interface AuthMethodContext {
  readonly intent: 'login' | 'signup'
  readonly next: string
}

/**
 * Another way to sign in, offered beside the password form.
 *
 * Core renders whatever a module returns and nothing around it: no divider, no
 * heading. A module cannot always tell at build time whether it has anything to
 * offer (an unconfigured provider renders nothing at all), and core framing
 * would then decorate an empty space.
 */
export interface AuthMethod {
  readonly id: string
  readonly order?: number
  readonly render: (context: AuthMethodContext) => ReactNode
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
export { EXTENSIBLE_RECORD_TYPES } from '@kelpie/schemas'
export type { ExtensibleRecordType }

/** What a tab or card is rendering against. Ids, not records: the contributor fetches its own data. */
export interface RecordContext {
  readonly objectType: ExtensibleRecordType
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

