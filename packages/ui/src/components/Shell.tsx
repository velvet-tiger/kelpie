import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'

import { useLogOut, useSession } from '../api/resources/session.ts'
import { applyTheme, getStoredTheme, setStoredTheme, watchSystemTheme } from '../lib/theme.ts'
import type { ThemePreference } from '../lib/theme.ts'
import { useNavItems } from '../registry/context.ts'
import type { NavItem } from '../registry/contributions.ts'
import { inSlotOrder } from '../registry/registry.ts'

/**
 * Sidebar, header, and the outlet every page renders into.
 *
 * Core numbers its nav items in hundreds so a module can land between two of
 * them without core renumbering, which is the contract `contributions.ts`
 * documents; a core entry added later slots at an intermediate value for the
 * same reason. The list is short because it holds what is ported: the mockup's
 * other entries arrive with the features behind them.
 */
const CORE_NAV: readonly NavItem[] = [
  { id: 'people', label: 'People', to: '/people', order: 100 },
  { id: 'companies', label: 'Companies', to: '/companies', order: 200 },
  { id: 'deals', label: 'Deals', to: '/deals', order: 300 },
  { id: 'opportunities', label: 'Opportunities', to: '/opportunities', order: 350 },
  { id: 'partnerships', label: 'Partnerships', to: '/partnerships', order: 375 },
  { id: 'planning', label: 'Planning', to: '/planning', order: 400 },
  { id: 'decisions', label: 'Decisions', to: '/decisions', order: 500 },
]

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
  const { session } = useSession()
  const logOut = useLogOut()
  const moduleNav = useNavItems('primary')
  const [menuOpen, setMenuOpen] = useState(false)
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredTheme())
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    applyTheme(theme)
    setStoredTheme(theme)
  }, [theme])

  useEffect(() => {
    if (theme !== 'system') {
      return
    }

    return watchSystemTheme(() => {
      applyTheme('system')
    })
  }, [theme])

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

  const navItems = inSlotOrder([...CORE_NAV, ...moduleNav])

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="flex w-[200px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="px-3 py-4">
          <NavLink to="/people" className="group block px-2">
            <div className="text-[15px] font-semibold tracking-tight text-sidebar-ink transition-opacity group-hover:opacity-80">
              Kelpie
            </div>
          </NavLink>
        </div>

        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-2 pb-4">
          <div>
            <div className="mb-1 px-2 text-[11px] text-sidebar-muted">CRM</div>
            <div className="flex flex-col gap-0.5">
              {navItems.map((item) => (
                <NavLink key={item.id} to={item.to} className={linkClass}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 items-center justify-end gap-3 border-b border-border px-5">
          <button
            type="button"
            onClick={() => {
              setTheme((current) => THEME_CYCLE[current])
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
              title="Account"
            >
              {(session?.role ?? '?').slice(0, 1).toUpperCase()}
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1.5 w-56 overflow-hidden rounded-md border border-border bg-surface-raised py-1"
              >
                <div className="border-b border-border px-3 py-2">
                  <div className="truncate font-mono text-[11px] text-ink-faint">
                    {session?.workspaceId ?? 'No workspace'}
                  </div>
                </div>
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
                        void navigate('/sign-in', { replace: true })
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
          <Outlet />
        </main>
      </div>
    </div>
  )
}
