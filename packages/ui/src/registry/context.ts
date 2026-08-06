import { createContext, useContext } from 'react'
import type { ComponentType } from 'react'

import type {
  DashboardCard,
  ExtensibleRecordType,
  IntegrationProvider,
  NavItem,
  NavSlot,
  RecordSidebarCard,
  RecordTab,
  RouteContribution,
} from './contributions.ts'
import type { Overridable } from './overridable.ts'
import { NO_UI_MODULES } from './registry.ts'
import type { UiExtensions } from './registry.ts'

/**
 * Reading the registry from a component.
 *
 * The default is the empty registry rather than an error, so a component tree
 * without a provider behaves exactly like an assembly with no modules: every
 * slot empty, every overridable rendering core's own component. A page under
 * test needs no setup to look right.
 *
 * The provider lives in its own file so Fast Refresh keeps working; a module
 * that exports both a component and a hook loses it.
 */
export const UiExtensionContext = createContext<UiExtensions>(NO_UI_MODULES)

export function useUiExtensions(): UiExtensions {
  return useContext(UiExtensionContext)
}

/** Module nav items for one slot, in order. The shell merges its own items in. */
export function useNavItems(slot: NavSlot): readonly NavItem[] {
  return useUiExtensions().navItems(slot)
}

/** Whole pages modules contribute, mounted under the shell's chrome. */
export function useModuleRoutes(): readonly RouteContribution[] {
  return useUiExtensions().routes()
}

export function useRecordTabs(objectType: ExtensibleRecordType): readonly RecordTab[] {
  return useUiExtensions().recordTabs(objectType)
}

export function useRecordSidebarCards(objectType: ExtensibleRecordType): readonly RecordSidebarCard[] {
  return useUiExtensions().recordSidebarCards(objectType)
}

export function useDashboardCards(): readonly DashboardCard[] {
  return useUiExtensions().dashboardCards()
}

export function useIntegrationProviders(): readonly IntegrationProvider[] {
  return useUiExtensions().integrationProviders()
}

/**
 * The component to render for an overridable: a module's replacement, or core's
 * own. Core calls this instead of rendering its component directly.
 */
export function useOverridable<Props>(token: Overridable<Props>): ComponentType<Props> {
  return useUiExtensions().componentFor(token)
}
