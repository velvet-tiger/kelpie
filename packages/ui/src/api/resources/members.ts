import { memberSchema, updateMemberRoleBody } from '@kelpie/schemas'
import type { Member, MemberRole } from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'
import { useSession } from './session.ts'

/**
 * The workspace's team, for resolving an id to a name.
 *
 * Not built on `createResourceHooks`: the path carries the workspace id, and the
 * endpoint answers the whole team in one page rather than a cursor list.
 *
 * Notes carry an `author_id` and activities an `actor_member_id`, both workspace
 * member ids. `api.md` has no include-expansion, so the panel showing them joins
 * against this list. One request per page, not one per row.
 */

export interface MemberDirectory {
  readonly members: readonly Member[]
  /** Member id to display name. Every panel that shows an actor wants exactly this. */
  readonly nameById: ReadonlyMap<string, string>
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useMembers(): MemberDirectory {
  const client = useApiClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? undefined
  const result = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () =>
      client.list(`/workspaces/${workspaceId ?? ''}/members`, memberSchema.parse),
    enabled: workspaceId !== undefined,
    // The team changes when someone is invited, which is rare and never during
    // the render of a timeline.
    staleTime: 5 * 60 * 1000,
  })
  const members = result.data?.items ?? []

  return {
    members,
    nameById: new Map(members.map((member) => [member.id, member.name])),
    isLoading: result.isPending && workspaceId !== undefined,
    error: toError(result.error),
  }
}

export interface SetMemberRoleArguments {
  readonly memberId: string
  readonly role: MemberRole
}

/**
 * Changes a member's role, or hands them ownership.
 *
 * Both invalidate the session as well as the list: a role change that lands on
 * the caller changes what the app should offer them, and a transfer always lands
 * on the caller.
 */
export function useSetMemberRole(): MutationResult<SetMemberRoleArguments, Member> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? ''
  const mutation = useMutation({
    mutationFn: ({ memberId, role }: SetMemberRoleArguments) =>
      client.patch(
        `/workspaces/${workspaceId}/members/${memberId}`,
        updateMemberRoleBody({ role }),
        memberSchema.parse,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['members', workspaceId] })
      await queryClient.invalidateQueries({ queryKey: ['session'] })
    },
  })

  return asMutationResult(mutation)
}

/**
 * Removes somebody from the workspace.
 *
 * Records they own are the API's business, not this hook's: it answers `409`
 * naming every type still pointing at them, and the page shows that.
 */
export function useRemoveMember(): MutationResult<string, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? ''
  const mutation = useMutation({
    mutationFn: (memberId: string) => client.delete(`/workspaces/${workspaceId}/members/${memberId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['members', workspaceId] })
    },
  })

  return asMutationResult(mutation)
}
