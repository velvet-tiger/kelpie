import { NavLink, Outlet } from 'react-router'

/**
 * Tabs across the account's own settings, from the mockup's `AccountNav`.
 *
 * Three of its five tabs are here. Personal API keys and integrations arrive
 * with the features behind them, the same rule the shell's sidebar follows.
 */

const TABS = [
  { to: '/account/profile', label: 'Profile' },
  { to: '/account/security', label: 'Security' },
  { to: '/account/preferences', label: 'Preferences' },
] as const

function tabClass({ isActive }: { isActive: boolean }): string {
  return [
    'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
    isActive
      ? 'bg-accent-soft text-accent-hover'
      : 'text-ink-muted hover:bg-surface hover:text-ink',
  ].join(' ')
}

export function AccountLayout(): React.JSX.Element {
  return (
    <div className="animate-fade-in mx-auto max-w-4xl">
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-border pb-3">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={tabClass}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
