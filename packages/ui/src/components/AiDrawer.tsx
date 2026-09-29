import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useSession } from '../api/resources/session.ts'
import {
  AiDrawerBusyNoticeContext,
  AiDrawerContext,
  AiDrawerPendingContext,
  useAiDrawer,
} from './aiDrawerState.ts'
import type { AiDrawerControls, AiDrawerState, AiDrawerTask } from './aiDrawerState.ts'
import { ErrorBoundary } from './ErrorBoundary.tsx'

/**
 * The side drawer AI work runs in, so the page next to it stays usable.
 *
 * Core owns the frame, the open state and the one active task. Modules and
 * pages supply the content through `useAiDrawer().open(task)`, from
 * `aiDrawerState.ts`. The state sits
 * in `Shell`, above the routed outlet, so it survives a route change.
 *
 * Closing only hides the drawer. A task keeps its step and any request in
 * flight in React state, and unmounting it would lose both, so the content
 * stays mounted until the task finishes or the user discards it.
 */

const WIDTH_STORAGE_KEY = 'kelpie.aiDrawer.width'
const DEFAULT_WIDTH = 400
const MIN_WIDTH = 320

function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.floor(window.innerWidth / 2))
}

function clampWidth(width: number): number {
  return Math.min(Math.max(width, MIN_WIDTH), maxWidth())
}

/** A convenience, so a failed read (private window, blocked storage) falls back to the default. */
function readStoredWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY))

    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

function storeWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(width))
  } catch {
    // The width is a per-browser convenience. Not saving it is harmless.
  }
}

export function AiDrawerProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [activeTask, setActiveTask] = useState<AiDrawerTask | undefined>(undefined)
  const [isOpen, setIsOpen] = useState(false)
  const [isPending, setIsPending] = useState(false)
  const [busyNotice, setBusyNotice] = useState(false)
  const activeRef = useRef<AiDrawerTask | undefined>(undefined)
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? null
  const workspaceRef = useRef<string | null>(workspaceId)

  const finish = useCallback((): void => {
    activeRef.current = undefined
    setActiveTask(undefined)
    setIsOpen(false)
    setIsPending(false)
    setBusyNotice(false)
  }, [])

  const open = useCallback((task: AiDrawerTask): boolean => {
    setIsOpen(true)

    if (activeRef.current !== undefined) {
      setBusyNotice(true)
      return false
    }

    activeRef.current = task
    setActiveTask(task)
    setBusyNotice(false)
    return true
  }, [])

  const reopen = useCallback((): void => {
    if (activeRef.current !== undefined) setIsOpen(true)
  }, [])

  const close = useCallback((): void => {
    setIsOpen(false)
    setBusyNotice(false)
  }, [])

  // A task belongs to one workspace. The switcher asks first when a request is
  // pending; this is the backstop for any other way the session moves.
  useEffect(() => {
    if (workspaceRef.current !== null && workspaceId !== null && workspaceRef.current !== workspaceId) {
      finish()
    }

    if (workspaceId !== null) workspaceRef.current = workspaceId
  }, [workspaceId, finish])

  const state = useMemo<AiDrawerState>(
    () => ({ activeTask, isOpen, isPending, open, reopen, close, finish }),
    [activeTask, isOpen, isPending, open, reopen, close, finish],
  )

  return (
    <AiDrawerContext.Provider value={state}>
      <AiDrawerBusyNoticeContext.Provider value={busyNotice}>
        <AiDrawerPendingContext.Provider value={setIsPending}>{children}</AiDrawerPendingContext.Provider>
      </AiDrawerBusyNoticeContext.Provider>
    </AiDrawerContext.Provider>
  )
}

/**
 * The drawer itself. `Shell` places it after `<main>`: beside the page from the
 * `md` breakpoint, so the page narrows; on top of it below that, with no
 * backdrop, because a phone has no room to push.
 */
export function AiDrawerPanel(): React.JSX.Element | null {
  const { activeTask, isOpen, close, finish, isPending } = useAiDrawer()
  const busyNotice = useContext(AiDrawerBusyNoticeContext)
  const setPending = useContext(AiDrawerPendingContext)
  const [width, setWidth] = useState(readStoredWidth)
  const widthRef = useRef(width)
  const asideRef = useRef<HTMLElement>(null)
  const [height, setHeight] = useState<number | undefined>(undefined)

  // Beside the page, the drawer sticks to the top of the viewport and fills it
  // down from its own top edge. Measured, not a fixed offset, because what sits
  // above the shell (the header, an environment banner) varies by install.
  useLayoutEffect(() => {
    const aside = asideRef.current

    if (aside === null || !isOpen) return

    function measure(): void {
      if (aside === null) return
      setHeight(window.innerHeight - Math.max(0, aside.getBoundingClientRect().top))
    }

    measure()
    window.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)

    return () => {
      window.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [isOpen, activeTask])

  const controls = useMemo<AiDrawerControls>(() => ({ close, finish, setPending }), [close, finish, setPending])

  if (activeTask === undefined) {
    return null
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)

    function onMove(move: PointerEvent): void {
      const next = clampWidth(window.innerWidth - move.clientX)
      widthRef.current = next
      setWidth(next)
    }

    function onUp(): void {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      storeWidth(widthRef.current)
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }

  return (
    <aside
      ref={asideRef}
      hidden={!isOpen}
      aria-label={activeTask.title}
      style={
        {
          '--ai-drawer-width': `${String(width)}px`,
          '--ai-drawer-height': height === undefined ? '100vh' : `${String(height)}px`,
        } as React.CSSProperties
      }
      onKeyDown={(event) => {
        if (event.key === 'Escape') close()
      }}
      className="fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l border-border bg-surface sm:w-[400px] md:sticky md:top-0 md:z-auto md:h-(--ai-drawer-height) md:w-(--ai-drawer-width) md:shrink-0 md:self-start"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the drawer"
        onPointerDown={startResize}
        className="absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize md:block"
      />
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-ink">{activeTask.title}</div>
          {activeTask.description !== undefined && (
            <div className="mt-0.5 text-[12px] text-ink-muted">{activeTask.description}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            className="text-[12px] font-medium text-ink-muted hover:text-danger"
            onClick={() => {
              if (!isPending || window.confirm('AI is still working on this task. Discard it?')) finish()
            }}
          >
            Discard
          </button>
          <button type="button" className="text-[12px] font-medium text-ink-muted hover:text-ink" onClick={close}>
            Close
          </button>
        </div>
      </div>
      {busyNotice && (
        <p role="status" className="border-b border-border bg-surface-sunken px-4 py-2 text-[12px] text-ink-muted">
          Finish or discard this task to start a new one.
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <ErrorBoundary key={activeTask.id}>{activeTask.render(controls)}</ErrorBoundary>
      </div>
    </aside>
  )
}

/** Header button for an active task while the drawer is hidden. */
export function AiDrawerLauncher(): React.JSX.Element | null {
  const { activeTask, isOpen, isPending, reopen } = useAiDrawer()

  if (activeTask === undefined || isOpen) {
    return null
  }

  return (
    <button
      type="button"
      onClick={reopen}
      title={isPending ? `${activeTask.title}: working` : activeTask.title}
      className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] text-ink transition hover:border-border-strong hover:bg-surface-sunken"
    >
      {isPending ? (
        <span
          aria-hidden="true"
          className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
        />
      ) : (
        <span aria-hidden="true" className="text-accent">
          ✦
        </span>
      )}
      <span className="truncate">{activeTask.title}</span>
    </button>
  )
}
