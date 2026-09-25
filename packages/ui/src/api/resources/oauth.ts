import {
  approveOAuthRequestBody,
  oauthDecisionSchema,
  oauthGrantSchema,
  oauthRequestSchema,
} from '@kelpie/schemas'
import type { ApproveOAuthRequestInput, OAuthDecision, OAuthGrant, OAuthRequest } from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * `/v1/oauth`: the consent page an MCP client sends a person to, and the
 * "Connected apps" list. Session only; the server refuses a bearer credential.
 *
 * Not workspace-scoped. A request asks which workspace to connect, and the
 * list covers every workspace the person belongs to.
 */

const GRANTS_KEY = ['oauth', 'grants'] as const

function requestKey(id: string): readonly unknown[] {
  return ['oauth', 'requests', id]
}

export interface OAuthRequestState {
  readonly request: OAuthRequest | undefined
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useOAuthRequest(id: string): OAuthRequestState {
  const client = useApiClient()
  const result = useQuery({
    queryKey: requestKey(id),
    queryFn: () => client.get(`/oauth/requests/${id}`, oauthRequestSchema.parse),
    // A request is answered once. Refetching after that would show "expired"
    // over the page that is already on its way back to the client.
    retry: false,
    refetchOnWindowFocus: false,
  })

  return {
    request: result.data,
    isLoading: result.isPending,
    error: toError(result.error),
  }
}

export interface ApproveOAuthRequestVariables extends ApproveOAuthRequestInput {
  readonly requestId: string
}

export function useApproveOAuthRequest(): MutationResult<ApproveOAuthRequestVariables, OAuthDecision> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ requestId, ...input }: ApproveOAuthRequestVariables) =>
      client.post(`/oauth/requests/${requestId}/approve`, approveOAuthRequestBody(input), oauthDecisionSchema.parse),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GRANTS_KEY })
    },
  })

  return asMutationResult(mutation)
}

export function useDenyOAuthRequest(): MutationResult<string, OAuthDecision> {
  const client = useApiClient()
  const mutation = useMutation({
    mutationFn: (requestId: string) =>
      client.post(`/oauth/requests/${requestId}/deny`, {}, oauthDecisionSchema.parse),
  })

  return asMutationResult(mutation)
}

export interface OAuthGrantsState {
  readonly grants: readonly OAuthGrant[]
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useOAuthGrants(): OAuthGrantsState {
  const client = useApiClient()
  const result = useQuery({
    queryKey: GRANTS_KEY,
    queryFn: () => client.list('/oauth/grants', oauthGrantSchema.parse),
  })

  return {
    grants: result.data?.items ?? [],
    isLoading: result.isPending,
    error: toError(result.error),
  }
}

export function useRevokeOAuthGrant(): MutationResult<string, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (id: string) => client.delete(`/oauth/grants/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GRANTS_KEY })
    },
  })

  return asMutationResult(mutation)
}
