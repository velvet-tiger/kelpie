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
import { createOverrideStore } from './overridable.ts'
import type { Overridable, OverrideStore } from './overridable.ts'

/**
 * The build-time UI extension registry from `modules.md`.
 *
 * Composition is build-time, like the server runtime: an assembly lists its UI
 * modules and this collects what they contribute. Nothing is loaded at runtime,
 * so the bundle contains exactly the modules the assembly named.
 *
 * There is no `requires` here, unlike the server runtime, because nothing about
 * a UI contribution depends on another module having registered first. Placement
 * within a slot is `order`, which is explicit and does not need a topological
 * sort to reason about.
 */

export interface UiModuleContext {
  nav(slot: NavSlot, item: NavItem): void
  route(route: RouteContribution): void
  recordTab(objectType: ExtensibleRecordType, tab: RecordTab): void
  recordSidebarCard(objectType: ExtensibleRecordType, card: RecordSidebarCard): void
  dashboardCard(card: DashboardCard): void
  integrationProvider(provider: IntegrationProvider): void
  /** Replaces a core component. Prefer a slot; see `modules.md`. */
  override<Props>(token: Overridable<Props>, component: ComponentType<Props>): void
}

export interface UiModule {
  readonly id: string
  register(context: UiModuleContext): void
}

/** Everything the registered modules contributed, ready for the shell to render. */
export interface UiExtensions {
  navItems(slot: NavSlot): readonly NavItem[]
  routes(): readonly RouteContribution[]
  recordTabs(objectType: ExtensibleRecordType): readonly RecordTab[]
  recordSidebarCards(objectType: ExtensibleRecordType): readonly RecordSidebarCard[]
  dashboardCards(): readonly DashboardCard[]
  integrationProviders(): readonly IntegrationProvider[]
  componentFor<Props>(token: Overridable<Props>): ComponentType<Props>
}

/** Anything unordered sorts after everything ordered, keeping its registration position. */
const UNORDERED = Number.MAX_SAFE_INTEGER

/**
 * Sorts slot contributions. Exported because the shell merges its own items into
 * the same slot and both sides have to agree on what `order` means.
 *
 * Stable, so two contributions with the same order keep their registration order
 * rather than swapping between builds.
 */
export function inSlotOrder<T extends { readonly order?: number }>(items: readonly T[]): readonly T[] {
  return [...items].sort((left, right) => (left.order ?? UNORDERED) - (right.order ?? UNORDERED))
}

interface Accumulator {
  readonly nav: Map<NavSlot, NavItem[]>
  readonly routes: RouteContribution[]
  readonly recordTabs: Map<ExtensibleRecordType, RecordTab[]>
  readonly recordSidebarCards: Map<ExtensibleRecordType, RecordSidebarCard[]>
  readonly dashboardCards: DashboardCard[]
  readonly integrationProviders: IntegrationProvider[]
  readonly overrides: OverrideStore
}

/** A module contributing under a name another module already used. Fails the build, like the server runtime. */
export class UiModuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UiModuleError'
  }
}

function claim(taken: Set<string>, moduleId: string, what: string, id: string): void {
  const name = `${what}:${id}`

  if (taken.has(name)) {
    throw new UiModuleError(`module "${moduleId}" contributes ${what} "${id}", which is already taken`)
  }

  taken.add(name)
}

function pushInto<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const existing = map.get(key)

  if (existing === undefined) {
    map.set(key, [value])

    return
  }

  existing.push(value)
}

function createModuleContext(
  module: UiModule,
  accumulator: Accumulator,
  taken: Set<string>,
): UiModuleContext {
  return {
    nav(slot, item) {
      claim(taken, module.id, `nav.${slot}`, item.id)
      pushInto(accumulator.nav, slot, item)
    },

    route(route) {
      claim(taken, module.id, 'route', route.path)
      accumulator.routes.push(route)
    },

    recordTab(objectType, tab) {
      claim(taken, module.id, `record.tabs.${objectType}`, tab.id)
      pushInto(accumulator.recordTabs, objectType, tab)
    },

    recordSidebarCard(objectType, card) {
      claim(taken, module.id, `record.sidebar.${objectType}`, card.id)
      pushInto(accumulator.recordSidebarCards, objectType, card)
    },

    dashboardCard(card) {
      claim(taken, module.id, 'dashboard.cards', card.id)
      accumulator.dashboardCards.push(card)
    },

    integrationProvider(provider) {
      claim(taken, module.id, 'admin.integrations.catalog', provider.id)
      accumulator.integrationProviders.push(provider)
    },

    override(token, component) {
      if (accumulator.overrides.has(token.key)) {
        throw new UiModuleError(
          `module "${module.id}" overrides "${token.key}", which another module already replaced`,
        )
      }

      accumulator.overrides.set(token, component)
    },
  }
}

/**
 * @throws UiModuleError on a duplicate module id, or two modules claiming the
 *   same contribution. Both would otherwise surface as a React key collision or
 *   a silently discarded contribution, at runtime, in the browser.
 */
export function registerUiModules(modules: readonly UiModule[]): UiExtensions {
  const accumulator: Accumulator = {
    nav: new Map(),
    routes: [],
    recordTabs: new Map(),
    recordSidebarCards: new Map(),
    dashboardCards: [],
    integrationProviders: [],
    overrides: createOverrideStore(),
  }
  const taken = new Set<string>()
  const seenIds = new Set<string>()

  for (const module of modules) {
    if (seenIds.has(module.id)) {
      throw new UiModuleError(`two UI modules share the id "${module.id}"`)
    }

    seenIds.add(module.id)
    module.register(createModuleContext(module, accumulator, taken))
  }

  return {
    navItems: (slot) => inSlotOrder(accumulator.nav.get(slot) ?? []),
    routes: () => accumulator.routes,
    recordTabs: (objectType) => inSlotOrder(accumulator.recordTabs.get(objectType) ?? []),
    recordSidebarCards: (objectType) =>
      inSlotOrder(accumulator.recordSidebarCards.get(objectType) ?? []),
    dashboardCards: () => inSlotOrder(accumulator.dashboardCards),
    integrationProviders: () => accumulator.integrationProviders,
    componentFor: (token) => accumulator.overrides.get(token),
  }
}

/**
 * The registry an assembly with no UI modules gets, and the default a component
 * tree without a provider sees.
 *
 * Every slot is empty and every overridable renders its core fallback, which is
 * the state `modules.md` requires core pages to look finished in.
 */
export const NO_UI_MODULES: UiExtensions = registerUiModules([])
