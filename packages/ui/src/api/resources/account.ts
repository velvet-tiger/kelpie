import {
  accountPreferencesSchema,
  accountSchema,
  accountSessionSchema,
  changePasswordBody,
  updateAccountBody,
  updateAccountPreferencesBody,
} from '@kelpie/schemas'
import type {
  Account,
  AccountPreferences,
  AccountSession,
  ChangePasswordInput,
  ThemePreference,
  UpdateAccountInput,
  UpdateAccountPreferencesInput,
} from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { applyTheme, getStoredTheme, setStoredTheme, watchSystemTheme } from '../../lib/theme.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * The signed-in person, as the `/account/*` pages read and write them.
 *
 * Not CRM resources, so none of these go through `createResourceHooks`: there is
 * no collection and no id in a path. They are also not workspace-scoped, which
 * is why nothing here keys on the session's workspace: renaming an account
 * renames it everywhere it is a member.
 */

const ACCOUNT_KEY = ['account'] as const
const PREFERENCES_KEY = ['account', 'preferences'] as const
const SESSIONS_KEY = ['account', 'sessions'] as const

export interface AccountState {
  readonly account: Account | undefined
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useAccount(): AccountState {
  const client = useApiClient()
  const result = useQuery({
    queryKey: ACCOUNT_KEY,
    queryFn: () => client.get('/account', accountSchema.parse),
  })

  return { account: result.data, isLoading: result.isPending, error: toError(result.error) }
}

export function useUpdateAccount(): MutationResult<UpdateAccountInput, Account> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: UpdateAccountInput) =>
      client.patch('/account', updateAccountBody(input), accountSchema.parse),
    onSuccess: async (account) => {
      queryClient.setQueryData(ACCOUNT_KEY, account)
      // The team page lists this person by name and address out of the member
      // list, which the account write knows nothing about.
      await queryClient.invalidateQueries({ queryKey: ['members'] })
    },
  })

  return asMutationResult(mutation)
}

export interface AccountPreferencesState {
  readonly preferences: AccountPreferences | undefined
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useAccountPreferences(): AccountPreferencesState {
  const client = useApiClient()
  const result = useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: () => client.get('/account/preferences', accountPreferencesSchema.parse),
  })

  return { preferences: result.data, isLoading: result.isPending, error: toError(result.error) }
}

export function useUpdateAccountPreferences(): MutationResult<
  UpdateAccountPreferencesInput,
  AccountPreferences
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: UpdateAccountPreferencesInput) =>
      client.patch(
        '/account/preferences',
        updateAccountPreferencesBody(input),
        accountPreferencesSchema.parse,
      ),
    onSuccess: (preferences) => {
      queryClient.setQueryData(PREFERENCES_KEY, preferences)
    },
    // A failed write leaves an optimistic theme on screen that the account does
    // not hold. Ask the service what is true rather than guessing back.
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY })
    },
  })

  return asMutationResult(mutation)
}

export interface AccountSessionsState {
  readonly sessions: readonly AccountSession[]
  readonly isLoading: boolean
  readonly error: Error | null
}

/** Where this account is signed in. The caller's own session is marked `current`. */
export function useAccountSessions(): AccountSessionsState {
  const client = useApiClient()
  const result = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => client.list('/auth/sessions', accountSessionSchema.parse),
  })

  return {
    sessions: result.data?.items ?? [],
    isLoading: result.isPending,
    error: toError(result.error),
  }
}

export function useRevokeAccountSession(): MutationResult<string, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (sessionId: string) => client.delete(`/auth/sessions/${sessionId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY })
    },
  })

  return asMutationResult(mutation)
}

/**
 * Changes the password and ends every other session, which is what the service
 * does, so the session list on the same page is refetched rather than left
 * showing devices that are no longer signed in.
 */
export function useChangePassword(): MutationResult<ChangePasswordInput, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      client.patchEmpty('/auth/password', changePasswordBody(input)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY })
    },
  })

  return asMutationResult(mutation)
}

export interface ThemeControl {
  readonly theme: ThemePreference
  readonly setTheme: (theme: ThemePreference) => void
}

/**
 * The theme, applied to the document and stored on the account.
 *
 * The account's preference is the source of truth, so the theme follows the
 * person to a new browser. `localStorage` seeds the first paint only: waiting
 * for the request would render the default theme and then correct itself on
 * every cold load.
 *
 * The value comes from the query cache rather than component state, because
 * more than one control changes it. The shell's toggle and the preferences page
 * are separate components, and two `useState` copies of one preference disagree
 * the moment either is clicked.
 */
export function useTheme(): ThemeControl {
  const queryClient = useQueryClient()
  const { preferences } = useAccountPreferences()
  const update = useUpdateAccountPreferences()
  const [firstPaintTheme] = useState<ThemePreference>(() => getStoredTheme())
  const theme = preferences?.theme ?? firstPaintTheme

  useEffect(() => {
    applyTheme(theme)
    // Kept current so the next cold load in this browser paints the right theme
    // before the request answers.
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

  function setTheme(next: ThemePreference): void {
    // Applied to the cache first: the click is about something visible, and the
    // eye should not wait on a round trip. `onError` puts the truth back.
    queryClient.setQueryData(PREFERENCES_KEY, (current: AccountPreferences | undefined) =>
      current === undefined ? current : { ...current, theme: next },
    )
    update.run({ theme: next })
  }

  return { theme, setTheme }
}
