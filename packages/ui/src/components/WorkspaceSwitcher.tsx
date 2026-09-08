import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { useAccountWorkspaces, useSession, useSwitchWorkspace } from '../api/resources/session.ts'

/**
 * Header control: the workspace this session is in, and a menu to move it.
 *
 * The list and the switch both live under `/v1/auth`, so a suspended current
 * workspace still lets the reader see the other memberships and leave.
 */

export function WorkspaceSwitcher(): React.JSX.Element | null {
  const navigate = useNavigate()
  const { session } = useSession()
  const { workspaces, isLoading } = useAccountWorkspaces()
  const switchWorkspace = useSwitchWorkspace()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const currentId = session?.workspaceId ?? null
  const current = workspaces.find((workspace) => workspace.id === currentId)

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: MouseEvent): void {
      if (menuRef.current?.contains(event.target as Node) !== true) {
        setOpen(false)
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (isLoading && workspaces.length === 0) {
    return (
      <span className="max-w-[10rem] truncate px-2 py-1 text-[12px] text-ink-faint" aria-hidden>
        Workspace
      </span>
    )
  }

  if (workspaces.length === 0) {
    return null
  }

  const label = current?.name ?? 'Workspace'

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value)
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Switch workspace"
        title={label}
        className="inline-flex max-w-[12rem] items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
      >
        <span className="truncate">{label}</span>
        <svg viewBox="0 0 12 12" aria-hidden className="h-2.5 w-2.5 shrink-0">
          <path
            d="M2.5 4.5 L6 8 L9.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1.5 w-56 overflow-hidden rounded-md border border-border bg-surface-raised py-1"
        >
          {workspaces.map((workspace) => {
            const isCurrent = workspace.id === currentId

            return (
              <button
                key={workspace.id}
                type="button"
                role="menuitem"
                aria-current={isCurrent ? 'true' : undefined}
                disabled={switchWorkspace.isPending}
                onClick={() => {
                  if (isCurrent) {
                    setOpen(false)
                    return
                  }

                  switchWorkspace
                    .runAsync({ workspaceId: workspace.id })
                    .then(() => {
                      setOpen(false)
                      void navigate('/dashboard', { replace: true })
                    })
                    .catch(() => undefined)
                }}
                className="block w-full px-3 py-1.5 text-left hover:bg-surface-sunken disabled:opacity-60"
              >
                <div className="truncate text-[13px] text-ink">{workspace.name}</div>
                <div className="truncate text-[11px] text-ink-faint capitalize">
                  {workspace.role}
                  {isCurrent ? ' · current' : ''}
                </div>
              </button>
            )
          })}
          {switchWorkspace.error !== null && (
            <p className="border-t border-border px-3 py-1.5 text-[12px] text-danger">
              {switchWorkspace.error.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
