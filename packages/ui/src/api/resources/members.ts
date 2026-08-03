import { memberSchema } from '@kelpie/schemas'
import type { Member } from '@kelpie/schemas'
import { useQuery } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
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
