import {
  createWorkspaceBody,
  logInBody,
  sessionSchema,
  signedInAccountSchema,
  workspaceSchema,
} from '@kelpie/schemas'
import type {
  CreateWorkspaceInput,
  LogInInput,
  Session,
  SignedInAccount,
  Workspace,
} from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '../client.ts'
import type { ApiClient } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'

/**
 * Who the browser is signed in as.
 *
 * Not a CRM resource, so it does not go through `createResourceHooks`: there is
 * no list, no id, and a `401` is an answer rather than a failure.
 *
 * Signing in or out changes which workspace every other cached query belongs to,
 * so both clear the whole cache. Leaving one person's People page in the cache
 * for the next person to sign in would be a data leak, not a stale render.
 */

const SESSION_KEY = ['session'] as const

function sessionQuery(client: ApiClient): {
  queryKey: typeof SESSION_KEY
  queryFn: () => Promise<Session>
  retry: false
  staleTime: 0
} {
  return {
    queryKey: SESSION_KEY,
    queryFn: () => client.get('/auth/me', sessionSchema.parse),
    // A 401 is the answer "signed out". Retrying it is pointless, and every
    // remount should ask again rather than trust a cached identity.
    retry: false,
    staleTime: 0,
  }
}

export interface SessionState {
  readonly session: Session | undefined
  readonly isLoading: boolean
  /** The service answered `401`. Distinct from a network failure, which is `error`. */
  readonly isSignedOut: boolean
  /** Signed in, but the account has no workspace yet. Every CRM endpoint answers `403` until it does. */
  readonly needsWorkspace: boolean
  readonly error: Error | null
}

export function useSession(): SessionState {
  const client = useApiClient()
  const result = useQuery(sessionQuery(client))
  const isSignedOut = result.error instanceof ApiError && result.error.status === 401

  return {
    session: result.data,
    isLoading: result.isPending,
    isSignedOut,
    needsWorkspace: result.data !== undefined && result.data.workspaceId === null,
    error: isSignedOut ? null : toError(result.error),
  }
}

export function useLogIn(): MutationResult<LogInInput, SignedInAccount> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: LogInInput) =>
      client.post('/auth/login', logInBody(input), signedInAccountSchema.parse),
    onSuccess: async () => {
      queryClient.clear()
      await queryClient.fetchQuery(sessionQuery(client))
    },
  })

  return asMutationResult(mutation)
}

export function useLogOut(): MutationResult<void, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => client.postEmpty('/auth/logout'),
    // No refetch afterwards. The caller sends the browser to the sign-in page,
    // and the next protected route asks for the session itself.
    onSettled: () => {
      queryClient.clear()
    },
  })

  return asMutationResult(mutation)
}

/**
 * Creates the account's first workspace.
 *
 * Signup makes an account and nothing else (`onboarding.md`), so without this a
 * new account reaches the app and gets `403` from every CRM endpoint.
 */
export function useCreateWorkspace(): MutationResult<CreateWorkspaceInput, Workspace> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: CreateWorkspaceInput) =>
      client.post('/workspaces', createWorkspaceBody(input), workspaceSchema.parse),
    // Creating a workspace moves the session into it, so the session is stale.
    onSuccess: async () => {
      await queryClient.fetchQuery(sessionQuery(client))
    },
  })

  return asMutationResult(mutation)
}

interface MutationLike<TInput, TOutput> {
  mutate: (input: TInput) => void
  mutateAsync: (input: TInput) => Promise<TOutput>
  isPending: boolean
  error: unknown
}

function asMutationResult<TInput, TOutput>(
  mutation: MutationLike<TInput, TOutput>,
): MutationResult<TInput, TOutput> {
  return {
    run: (input) => {
      mutation.mutate(input)
    },
    runAsync: (input) => mutation.mutateAsync(input),
    isPending: mutation.isPending,
    error: toError(mutation.error),
  }
}
