import { createInviteBody, inviteSchema } from '@kelpie/schemas'
import type { InvitableRole, Invite } from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'
import { useSession } from './session.ts'

/**
 * Outstanding invitations for the workspace.
 *
 * Admin-only server-side, so a member's request answers `403`. The team page
 * only renders this half for an admin, which keeps the refusal off screen
 * without the browser being what decides it.
 *
 * The URL the emailed link points at is built server-side from the deployment's
 * own base URL, so nothing here sends one.
 */

const INVITES_KEY = 'invites'

export interface InviteListResult {
  readonly invites: readonly Invite[]
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useInvites(): InviteListResult {
  const client = useApiClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? undefined
  const result = useQuery({
    queryKey: [INVITES_KEY, workspaceId],
    queryFn: () => client.list(`/workspaces/${workspaceId ?? ''}/invites`, inviteSchema.parse),
    enabled: workspaceId !== undefined,
  })

  return {
    invites: result.data?.items ?? [],
    isLoading: result.isPending && workspaceId !== undefined,
    error: toError(result.error),
  }
}

export interface SendInviteArguments {
  readonly email: string
  readonly role: InvitableRole
}

export function useSendInvite(): MutationResult<SendInviteArguments, Invite> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? ''
  const mutation = useMutation({
    mutationFn: ({ email, role }: SendInviteArguments) =>
      client.post(
        `/workspaces/${workspaceId}/invites`,
        createInviteBody({ email, role }),
        inviteSchema.parse,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [INVITES_KEY, workspaceId] })
    },
  })

  return asMutationResult(mutation)
}

/** Reissues the token and emails it again. The link in the first email stops working. */
export function useResendInvite(): MutationResult<string, Invite> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? ''
  const mutation = useMutation({
    mutationFn: (inviteId: string) =>
      client.post(`/workspaces/${workspaceId}/invites/${inviteId}/resend`, {}, inviteSchema.parse),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [INVITES_KEY, workspaceId] })
    },
  })

  return asMutationResult(mutation)
}

export function useRevokeInvite(): MutationResult<string, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? ''
  const mutation = useMutation({
    mutationFn: (inviteId: string) => client.delete(`/workspaces/${workspaceId}/invites/${inviteId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [INVITES_KEY, workspaceId] })
    },
  })

  return asMutationResult(mutation)
}
