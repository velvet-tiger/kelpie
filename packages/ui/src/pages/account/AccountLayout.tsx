import { NavLink, Outlet } from 'react-router'

import type { NavItem } from '../../registry/contributions.ts'
import { useNavItems } from '../../registry/context.ts'
import { useVisibleNavItems } from '../../registry/visibleNav.ts'

/**
 * Tabs across the account's own settings, from the mockup's `AccountNav`.
 *
 * Three of its five tabs are core's. The rest come from `nav.account`, which is
 * where a module's own account page announces itself: a module route mounts as
 * a sibling of `/account` rather than a child of it, so without this the page
 * would render with no tab strip and nothing anywhere pointing at it.
 *
 * Core numbers itself in hundreds, the same convention the shell's sidebar
 * uses, so a module can land between two core tabs without core renumbering.
 */

const CORE_TABS: readonly NavItem[] = [
  { id: 'profile', to: '/account/profile', label: 'Profile', order: 100 },
  { id: 'security', to: '/account/security', label: 'Security', order: 200 },
  { id: 'preferences', to: '/account/preferences', label: 'Preferences', order: 300 },
  { id: 'api-keys', to: '/account/api-keys', label: 'API keys', order: 400 },
]

function tabClass({ isActive }: { isActive: boolean }): string {
  return [
    'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
    isActive
      ? 'bg-accent-soft text-accent-hover'
      : 'text-ink-muted hover:bg-surface hover:text-ink',
  ].join(' ')
}

export function AccountLayout(): React.JSX.Element {
  const tabs = useVisibleNavItems(CORE_TABS, useNavItems('account'))

  return (
    <div className="animate-fade-in mx-auto max-w-4xl">
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-border pb-3">
        {tabs.map((tab) => (
          <NavLink key={tab.id} to={tab.to} className={tabClass}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
