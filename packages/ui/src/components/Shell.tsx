import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'

import { useAccount, useTheme } from '../api/resources/account.ts'
import { useLogOut } from '../api/resources/session.ts'
import { initialsOf } from '../lib/names.ts'
import type { ThemePreference } from '../lib/theme.ts'
import { useNavItems } from '../registry/context.ts'
import type { NavItem } from '../registry/contributions.ts'
import { useVisibleNavItems } from '../registry/visibleNav.ts'
import { ErrorBoundary } from './ErrorBoundary.tsx'

/**
 * Sidebar, header, and the outlet every page renders into.
 *
 * Core numbers its nav items in hundreds so a module can land between two of
 * them without core renumbering, which is the contract `contributions.ts`
 * documents; a core entry added later slots at an intermediate value for the
 * same reason. The list is short because it holds what is ported: the mockup's
 * other entries arrive with the features behind them.
 */
const CORE_ADMIN_NAV: readonly NavItem[] = [
  { id: 'workspace', label: 'Workspace', to: '/admin/workspace', order: 100 },
  { id: 'team', label: 'Team', to: '/admin/team', order: 200 },
  { id: 'data', label: 'Data', to: '/admin/data', order: 300 },
  { id: 'webhooks', label: 'Webhooks', to: '/admin/webhooks', order: 400 },
  { id: 'mcp', label: 'MCP', to: '/admin/mcp', order: 500 },
  { id: 'modules', label: 'Modules', to: '/admin/modules', order: 600 },
]

const CORE_NAV: readonly NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', to: '/dashboard', order: 50 },
  { id: 'people', label: 'People', to: '/people', order: 100 },
  { id: 'hiring', label: 'Hiring', to: '/hiring', order: 150 },
  { id: 'companies', label: 'Companies', to: '/companies', order: 200 },
  { id: 'deals', label: 'Deals', to: '/deals', order: 300 },
  { id: 'opportunities', label: 'Opportunities', to: '/opportunities', order: 350 },
  { id: 'fundraising', label: 'Fundraising', to: '/fundraising', order: 360 },
  { id: 'partnerships', label: 'Partnerships', to: '/partnerships', order: 375 },
  { id: 'forms', label: 'Forms', to: '/forms', order: 380 },
  { id: 'handbook', label: 'Handbook', to: '/handbook', order: 390 },
  { id: 'planning', label: 'Planning', to: '/planning', order: 400 },
  { id: 'decisions', label: 'Decisions', to: '/decisions', order: 500 },
]

/**
 * `nav.primary` is one flat slot (`modules.md`); the mockup renders it as two
 * visual groups, an unheaded top section and a headed "CRM" section. This is
 * presentation only, so it stays here rather than becoming a second slot.
 */
const TOP_LEVEL_NAV_IDS: ReadonlySet<string> = new Set(['dashboard', 'handbook', 'planning', 'decisions'])

function linkClass({ isActive }: { isActive: boolean }): string {
  return [
    'block rounded-md px-2 py-1 text-[13px] transition-colors duration-100',
    isActive
      ? 'bg-sidebar-active font-medium text-sidebar-ink'
      : 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-ink',
  ].join(' ')
}

const THEME_CYCLE: Readonly<Record<ThemePreference, ThemePreference>> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

export function Shell(): React.JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const { account } = useAccount()
  const logOut = useLogOut()
  const moduleNav = useNavItems('primary')
  const moduleAdminNav = useNavItems('admin')
  const [menuOpen, setMenuOpen] = useState(false)
  // The same preference the account page writes, so this button and that page
  // cannot disagree about which theme the account is on.
  const { theme, setTheme } = useTheme()
  const menuRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!menuOpen) {
      return
    }

    function onPointerDown(event: MouseEvent): void {
      if (menuRef.current?.contains(event.target as Node) !== true) {
        setMenuOpen(false)
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const navItems = useVisibleNavItems(CORE_NAV, moduleNav)
  const topLevelItems = navItems.filter((item) => TOP_LEVEL_NAV_IDS.has(item.id))
  const crmItems = navItems.filter((item) => !TOP_LEVEL_NAV_IDS.has(item.id))
  const adminItems = useVisibleNavItems(CORE_ADMIN_NAV, moduleAdminNav)

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="flex w-[200px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="px-3 py-4">
          <NavLink to="/dashboard" className="group block px-2">
            <div className="text-[15px] font-semibold tracking-tight text-sidebar-ink transition-opacity group-hover:opacity-80">
              Kelpie
            </div>
          </NavLink>
        </div>

        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-2 pb-4">
          <div className="flex flex-col gap-0.5">
            {topLevelItems.map((item) => (
              <NavLink key={item.id} to={item.to} className={linkClass}>
                {item.label}
              </NavLink>
            ))}
          </div>

          <div>
            <div className="mb-1 px-2 text-[11px] text-sidebar-muted">CRM</div>
            <div className="flex flex-col gap-0.5">
              {crmItems.map((item) => (
                <NavLink key={item.id} to={item.to} className={linkClass}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>

          {/*
            Shown to every member. Both pages read for anyone in the workspace
            and only their controls are admin-gated, so hiding the section would
            keep a member from seeing who else is on their team.
          */}
          <div>
            <div className="mb-1 px-2 text-[11px] text-sidebar-muted">Admin</div>
            <div className="flex flex-col gap-0.5">
              {adminItems.map((item) => (
                <NavLink key={item.id} to={item.to} className={linkClass}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 items-center gap-3 border-b border-border px-5">
          <form
            className="flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              const term = query.trim()

              if (term.length === 0) {
                return
              }

              void navigate(`/search?q=${encodeURIComponent(term)}`)
            }}
          >
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              aria-label="Search"
              placeholder="Search…"
              className="w-full max-w-sm rounded-md border border-transparent bg-surface-sunken px-2.5 py-1 text-[13px] text-ink outline-none transition placeholder:text-ink-faint focus:border-border focus:bg-surface-raised"
            />
          </form>
          <button
            type="button"
            onClick={() => {
              setTheme(THEME_CYCLE[theme])
            }}
            title={`Theme: ${THEME_LABELS[theme]}`}
            className="rounded-md px-2 py-1 text-[12px] text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
          >
            {THEME_LABELS[theme]}
          </button>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => {
                setMenuOpen((current) => !current)
              }}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-accent-fg transition hover:bg-accent-hover"
              title={account?.name ?? 'Account'}
            >
              {account === undefined ? '?' : initialsOf(account.name)}
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1.5 w-56 overflow-hidden rounded-md border border-border bg-surface-raised py-1"
              >
                <div className="border-b border-border px-3 py-2">
                  <div className="truncate text-[13px] font-medium text-ink">
                    {account?.name ?? 'Loading…'}
                  </div>
                  <div className="truncate font-mono text-[11px] text-ink-faint">
                    {account?.email ?? ''}
                  </div>
                </div>
                <NavLink
                  to="/account/profile"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                  }}
                  className="block px-3 py-1.5 text-left text-[13px] text-ink hover:bg-surface-sunken"
                >
                  Account settings
                </NavLink>
                <NavLink
                  to="/account/preferences"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                  }}
                  className="block border-b border-border px-3 py-1.5 text-left text-[13px] text-ink hover:bg-surface-sunken"
                >
                  Preferences
                </NavLink>
                <button
                  type="button"
                  role="menuitem"
                  disabled={logOut.isPending}
                  onClick={() => {
                    setMenuOpen(false)
                    logOut
                      .runAsync()
                      .catch(() => undefined)
                      .finally(() => {
                        void navigate('/login', { replace: true })
                      })
                  }}
                  className="block w-full px-3 py-1.5 text-left text-[13px] text-ink hover:bg-surface-sunken"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-auto px-5 py-5">
          {/* Keyed on the path so navigating away from a crashed page remounts
              the boundary instead of leaving it stuck showing the old error. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
