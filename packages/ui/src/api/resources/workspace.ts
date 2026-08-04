import { updateWorkspaceBody, workspaceSchema } from '@kelpie/schemas'
import type { UpdateWorkspaceInput, Workspace } from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'
import { useSession } from './session.ts'

/**
 * The workspace the session is in.
 *
 * Not a CRM resource: there is one of them, its id comes from the session rather
 * than a route, and there is no list. `createResourceHooks` would have nothing
 * to configure.
 */

const WORKSPACE_KEY = 'workspace'

export interface WorkspaceState {
  readonly workspace: Workspace | undefined
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useWorkspace(): WorkspaceState {
  const client = useApiClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? undefined
  const result = useQuery({
    queryKey: [WORKSPACE_KEY, workspaceId],
    queryFn: () => client.get(`/workspaces/${workspaceId ?? ''}`, workspaceSchema.parse),
    enabled: workspaceId !== undefined,
  })

  return {
    workspace: result.data,
    isLoading: result.isPending && workspaceId !== undefined,
    error: toError(result.error),
  }
}

export function useUpdateWorkspace(): MutationResult<UpdateWorkspaceInput, Workspace> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? ''
  const mutation = useMutation({
    mutationFn: (input: UpdateWorkspaceInput) =>
      client.patch(`/workspaces/${workspaceId}`, updateWorkspaceBody(input), workspaceSchema.parse),
    onSuccess: (workspace) => {
      queryClient.setQueryData([WORKSPACE_KEY, workspaceId], workspace)
    },
  })

  return asMutationResult(mutation)
}

/**
 * Deletes the workspace, everything in it, and the caller's way back.
 *
 * The slug goes with the request because the API asks the caller to name what it
 * is destroying. Afterwards the whole cache is dropped: every cached list
 * belongs to a workspace that no longer exists.
 */
export function useDeleteWorkspace(): MutationResult<{ readonly slug: string }, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? ''
  const mutation = useMutation({
    mutationFn: ({ slug }: { readonly slug: string }) =>
      client.delete(`/workspaces/${workspaceId}`, { slug }),
    onSuccess: () => {
      queryClient.clear()
    },
  })

  return asMutationResult(mutation)
}
