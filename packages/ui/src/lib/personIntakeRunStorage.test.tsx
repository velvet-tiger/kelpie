import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { useLogOut } from '../api/resources/session.ts'
import { stubClient } from '../testing/stubClient.ts'
import {
  clearAllSavedIntakeRuns,
  clearOtherUsersIntakeRuns,
  clearSavedIntakeRuns,
  readSavedIntakeRun,
  saveIntakeRun,
} from './personIntakeRunStorage.ts'

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

/**
 * The person-intake wizard's saved run: one entry per workspace and user, and
 * nothing left behind for the next person to sign in to the tab.
 */

function savedRun(userId: string, runId: string): Parameters<typeof saveIntakeRun>[1] {
  return {
    user_id: userId,
    run_id: runId,
    identify_run_id: null,
    step: 'notes',
    text: `Notes from ${userId}`,
    candidate: null,
    existing_person_id: null,
  }
}

describe('the saved person-intake run', () => {
  it('belongs to one workspace and one user', () => {
    saveIntakeRun('ws_1', savedRun('usr_1', 'ai_1'))
    saveIntakeRun('ws_2', savedRun('usr_1', 'ai_2'))

    expect(readSavedIntakeRun('ws_1', 'usr_1')?.run_id).toBe('ai_1')
    expect(readSavedIntakeRun('ws_2', 'usr_1')?.run_id).toBe('ai_2')
    expect(readSavedIntakeRun('ws_1', 'usr_2')).toBeUndefined()
  })

  it('reads an entry whose user is not the reader as none', () => {
    sessionStorage.setItem('kelpie.personIntake.run.ws_1.usr_1', JSON.stringify(savedRun('usr_2', 'ai_1')))

    expect(readSavedIntakeRun('ws_1', 'usr_1')).toBeUndefined()
  })

  it('clears one workspace, other users, or everything', () => {
    saveIntakeRun('ws_1', savedRun('usr_1', 'ai_1'))
    saveIntakeRun('ws_2', savedRun('usr_1', 'ai_2'))
    saveIntakeRun('ws_1', savedRun('usr_2', 'ai_3'))
    sessionStorage.setItem('unrelated', 'kept')

    clearOtherUsersIntakeRuns('usr_1')
    expect(readSavedIntakeRun('ws_1', 'usr_2')).toBeUndefined()
    expect(readSavedIntakeRun('ws_1', 'usr_1')).toBeDefined()

    clearSavedIntakeRuns('ws_1')
    expect(readSavedIntakeRun('ws_1', 'usr_1')).toBeUndefined()
    expect(readSavedIntakeRun('ws_2', 'usr_1')).toBeDefined()

    clearAllSavedIntakeRuns()
    expect(readSavedIntakeRun('ws_2', 'usr_1')).toBeUndefined()
    expect(sessionStorage.getItem('unrelated')).toBe('kept')
  })

  it('is cleared when the user signs out', async () => {
    saveIntakeRun('ws_1', savedRun('usr_1', 'ai_1'))
    saveIntakeRun('ws_2', savedRun('usr_1', 'ai_2'))
    const client = stubClient({ postEmpty: () => undefined })
    const wrapper = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
      <ApiProvider client={client} queryClient={new QueryClient()}>
        {children}
      </ApiProvider>
    )
    const { result } = renderHook(() => useLogOut(), { wrapper })

    await act(async () => {
      await result.current.runAsync()
    })

    expect(readSavedIntakeRun('ws_1', 'usr_1')).toBeUndefined()
    expect(readSavedIntakeRun('ws_2', 'usr_1')).toBeUndefined()
  })
})
