import {
  confirmEmailVerificationBody,
  confirmPasswordResetBody,
  createWorkspaceBody,
  logInBody,
  requestEmailVerificationBody,
  requestPasswordResetBody,
  sessionSchema,
  signUpBody,
  signedInAccountSchema,
  workspaceSchema,
} from '@kelpie/schemas'
import type {
  ConfirmEmailVerificationInput,
  ConfirmPasswordResetInput,
  CreateWorkspaceInput,
  LogInInput,
  RequestEmailVerificationInput,
  RequestPasswordResetInput,
  Session,
  SignUpInput,
  SignedInAccount,
  Workspace,
} from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '../client.ts'
import type { ApiClient } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

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
  /** No workspace yet, and creating one will answer `403` until the account verifies its email. */
  readonly needsEmailVerification: boolean
  readonly error: Error | null
}

export function useSession(): SessionState {
  const client = useApiClient()
  const result = useQuery(sessionQuery(client))
  const isSignedOut = result.error instanceof ApiError && result.error.status === 401
  const needsWorkspace = result.data !== undefined && result.data.workspaceId === null

  return {
    session: result.data,
    isLoading: result.isPending,
    isSignedOut,
    needsWorkspace,
    needsEmailVerification: needsWorkspace && result.data?.emailVerified === false,
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

/**
 * Creates the account and signs the browser in, because `POST /v1/auth/signup`
 * sets the session cookie itself.
 *
 * The cache is cleared for the same reason sign-in clears it: whatever is in it
 * belongs to whoever was here before.
 */
export function useSignUp(): MutationResult<SignUpInput, SignedInAccount> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: SignUpInput) =>
      client.post('/auth/signup', signUpBody(input), signedInAccountSchema.parse),
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

/** Where a reset email lands. `ResetPasswordPage` reads the token out of the query string. */
export function resetUrlTemplate(origin: string): string {
  return `${origin}/reset-password?token={token}`
}

/** Where a verification email lands. `VerifyEmailConfirmPage` reads the token out of the query string. */
export function verifyEmailUrlTemplate(origin: string): string {
  return `${origin}/verify-email?token={token}`
}

/**
 * Asks for a reset link.
 *
 * Answers `202` whether or not the address is registered, and the page says the
 * same thing either way. A caller that could tell the difference would have an
 * account-existence oracle.
 *
 * Nothing in the cache changes: this signs nobody in and ends no session.
 */
export function useRequestPasswordReset(): MutationResult<RequestPasswordResetInput, void> {
  const client = useApiClient()
  const mutation = useMutation({
    mutationFn: (input: RequestPasswordResetInput) =>
      client.postEmpty('/auth/password-reset', requestPasswordResetBody(input)),
  })

  return asMutationResult(mutation)
}

/**
 * Spends a reset token on a new password.
 *
 * The service ends every session the account had, this browser included, so the
 * caller sends the reader to sign in rather than into the app.
 */
export function useConfirmPasswordReset(): MutationResult<ConfirmPasswordResetInput, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: ConfirmPasswordResetInput) =>
      client.postEmpty('/auth/password-reset/confirm', confirmPasswordResetBody(input)),
    onSuccess: () => {
      queryClient.clear()
    },
  })

  return asMutationResult(mutation)
}

/**
 * Asks for a fresh verification link. The same call a "resend" button makes,
 * and a no-op once the account is already verified.
 *
 * Nothing in the cache changes: this signs nobody in or out.
 */
export function useRequestEmailVerification(): MutationResult<RequestEmailVerificationInput, void> {
  const client = useApiClient()
  const mutation = useMutation({
    mutationFn: (input: RequestEmailVerificationInput) =>
      client.postEmpty('/auth/verify-email', requestEmailVerificationBody(input)),
  })

  return asMutationResult(mutation)
}

/**
 * Spends a verification token from that email.
 *
 * Unlike a password reset this ends no session, so the caller only needs the
 * session re-read: `needsEmailVerification` flips once it lands.
 */
export function useConfirmEmailVerification(): MutationResult<ConfirmEmailVerificationInput, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: ConfirmEmailVerificationInput) =>
      client.postEmpty('/auth/verify-email/confirm', confirmEmailVerificationBody(input)),
    onSuccess: async () => {
      await queryClient.fetchQuery(sessionQuery(client))
    },
  })

  return asMutationResult(mutation)
}

/**
 * Joins the workspace an invitation names.
 *
 * Like creating one, this moves the session, so the whole cache goes: the next
 * page belongs to a different workspace than the one just cached.
 */
export function useAcceptInvite(): MutationResult<{ readonly token: string }, Workspace> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ token }: { readonly token: string }) =>
      client.post('/invites/accept', { token }, workspaceSchema.parse),
    onSuccess: async () => {
      queryClient.clear()
      await queryClient.fetchQuery(sessionQuery(client))
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

