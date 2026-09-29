import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

/**
 * The AI drawer's contract and hook, apart from its components so the
 * component file keeps fast refresh (the same split as `registry/context.ts`).
 * The drawer itself is `AiDrawer.tsx`.
 */

/** What a task may do to the drawer it sits in. */
export interface AiDrawerControls {
  /** Hides the drawer. The task stays mounted. */
  readonly close: () => void
  /** Ends the task and unmounts it. */
  readonly finish: () => void
  /** Tells the header button to show the pending spinner. */
  readonly setPending: (pending: boolean) => void
}

/** The content of the drawer. One is active at a time. */
export interface AiDrawerTask {
  readonly id: string
  readonly title: string
  /** A line under the title. */
  readonly description?: string
  readonly render: (controls: AiDrawerControls) => ReactNode
}

export interface AiDrawerState {
  readonly activeTask: AiDrawerTask | undefined
  readonly isOpen: boolean
  readonly isPending: boolean
  /**
   * Opens the drawer on `task`. When another task is active, opens on that
   * one instead, says so, and returns `false`. Nothing is replaced silently.
   */
  readonly open: (task: AiDrawerTask) => boolean
  /** Shows the active task again. */
  readonly reopen: () => void
  readonly close: () => void
  /** Ends the active task. */
  readonly finish: () => void
}

export const AiDrawerContext = createContext<AiDrawerState | undefined>(undefined)

export function useAiDrawer(): AiDrawerState {
  const state = useContext(AiDrawerContext)

  if (state === undefined) {
    throw new Error('useAiDrawer needs an AiDrawerProvider above it. Shell provides one.')
  }

  return state
}

/** Whether the drawer says that a new task has to wait for the active one. */
export const AiDrawerBusyNoticeContext = createContext(false)

/** The active task's pending setter, handed to it through its controls. */
export const AiDrawerPendingContext = createContext<(pending: boolean) => void>(() => undefined)
