import type { ExtensibleRecordType } from '@kelpie/schemas'
import type { ComponentType, ReactNode } from 'react'

/**
 * What a UI module may add to the shell.
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

/**
 * An admin page whose tabs modules may add to. `ai` is Admin → AI: core owns
 * the page and its MCP tab, and the optional `ai` module adds Kelpie AI's
 * settings and run log.
 */
export type ExtensibleAdminPage = 'ai'

export interface AdminTab {
  readonly id: string
  readonly label: string
  readonly order?: number
  readonly render: () => ReactNode
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


/**
 * Whether the runner can take a task now, for the workspace the viewer is in.
 * `reason` is a sentence the Agent menu shows on its disabled Run button.
 */
export type AgentRunnerAvailability =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'ready'; readonly agentId: string }

/** Where a dispatched run got to, once core has handed it to the runner's agent. */
export type AgentRunnerProgress =
  | { readonly status: 'running' }
  | { readonly status: 'succeeded' }
  | { readonly status: 'failed'; readonly reason: string }

/**
 * The agent the Agent menu's Run button dispatches to, with no dialog.
 *
 * Core has no model of its own, so with no runner registered Run stays
 * disabled and Preview is the way to reach a registered agent. Both members are
 * React hooks: the menu calls them on every render, so they follow the Rules of
 * Hooks, and `enabled` lets the menu defer the fetch until it opens.
 */
export interface AgentRunner {
  readonly id: string
  readonly useAvailability: (options: { readonly enabled: boolean }) => AgentRunnerAvailability
  /** Progress for the core agent run `agentRunId`. `undefined` polls nothing. */
  readonly useProgress: (agentRunId: string | undefined) => AgentRunnerProgress | undefined
}

export interface PersonIntakeWizardProps {
  /** Ends the intake and closes the AI drawer it sits in. */
  readonly onClose: () => void
  /**
   * Called when a model request starts or ends, so the drawer's header button
   * can show that the task is working while the drawer is hidden.
   */
  readonly onPendingChange?: (pending: boolean) => void
}

/**
 * The model-driven wizard behind People's **Add from notes**.
 *
 * Core owns the button and the AI drawer panel, and with no provider (or one
 * that is not ready) the panel offers a copy-prompt for the user's own agent. A
 * provider replaces that with a wizard that identifies, researches and
 * creates. `useAvailability` is a hook, with the runner's shape and rules.
 */
export interface PersonIntakeProvider {
  readonly id: string
  readonly useAvailability: (options: { readonly enabled: boolean }) => AgentRunnerAvailability
  readonly Wizard: ComponentType<PersonIntakeWizardProps>
}
