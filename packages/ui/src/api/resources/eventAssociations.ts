import { eventAssociationRowSchema } from '@kelpie/schemas'
import type { EventAssociationRow, EventAssociationTargetType } from '@kelpie/schemas'
import { useQuery } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'

/**
 * `GET /v1/event-associations?target_type=&target_id=`: Events linked to another
 * record. The reverse of the associations array on an Event.
 */

export interface EventAssociationsResult {
  readonly associations: readonly EventAssociationRow[]
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useEventAssociationsFor(
  targetType: EventAssociationTargetType | undefined,
  targetId: string | undefined,
): EventAssociationsResult {
  const client = useApiClient()
  const enabled = targetType !== undefined && targetId !== undefined
  const result = useQuery({
    queryKey: ['eventAssociations', targetType, targetId],
    queryFn: async () => {
      const page = await client.list('/event-associations', eventAssociationRowSchema.parse, {
        target_type: targetType,
        target_id: targetId,
      })

      return page.items
    },
    enabled,
  })

  return {
    associations: result.data ?? [],
    isLoading: result.isPending && enabled,
    error: toError(result.error),
  }
}
