import { useModuleSettings } from '../api/resources/moduleSettings.ts'
import type { NavItem } from './contributions.ts'
import { inSlotOrder } from './registry.ts'

/**
 * Core's nav items merged with a slot's module contributions, ordered, with the
 * entries belonging to a disabled module removed.
 *
 * One hook rather than the rule written out at each nav surface. The shell's
 * sidebar and the account tab strip both render a slot, and a workspace that
 * switched a module off should stop seeing it in both. Two copies of this
 * filter is exactly the sort of pair that drifts, and the symptom is a tab that
 * survives its module being disabled and leads to a page answering 403.
 */

/**
 * A nav item whose id does not match its module id. Everything else looks itself
 * up directly, which is what keeps a toggleable module's own nav entry working
 * with no change here when one is added later.
 */
const NAV_ID_TO_MODULE_ID: Readonly<Record<string, string>> = {
  fundraising: 'raises',
  data: 'import-export',
}

export function useVisibleNavItems(
  coreItems: readonly NavItem[],
  moduleItems: readonly NavItem[],
): readonly NavItem[] {
  const { settings } = useModuleSettings()
  const disabledModuleIds = new Set(
    settings.filter((setting) => !setting.enabled).map((setting) => setting.moduleId),
  )

  return inSlotOrder([...coreItems, ...moduleItems]).filter(
    (item) => !disabledModuleIds.has(NAV_ID_TO_MODULE_ID[item.id] ?? item.id),
  )
}
