import { createDecisionBody, decisionBody, decisionSchema } from '@kelpie/schemas'
import type {
  CreateDecisionInput,
  Decision,
  DecisionInput,
  RecordTargetType,
} from '@kelpie/schemas'

import { useMutation, useQueryClient } from '@tanstack/react-query'

import type { QueryParameters } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import { createResourceHooks } from '../resource.ts'
import type { MutationResult, RecordListResult, UpdateArguments } from '../resource.ts'

/**
 * `/v1/decisions`, attachable to any CRM record.
 *
 * Unlike notes, the API answers a workspace-wide list too: `/decisions` is a
 * page of its own, so the filters here are all optional.
 *
 * No `alsoInvalidates`: a decision write files no activity row and touches no
 * other resource.
 */

const decisions = createResourceHooks<Decision, CreateDecisionInput, DecisionInput>({
  name: 'decisions',
  path: '/decisions',
  decode: decisionSchema.parse,
  createBody: createDecisionBody,
  updateBody: decisionBody,
})

export interface DecisionFilters {
  readonly targetType?: RecordTargetType | undefined
  readonly targetId?: string | undefined
  /** Matches the body, the rationale, the target type, and the target's name. */
  readonly term?: string | undefined
  /** `field` ascending, `-field` descending. Only `decided_at`, `created_at`, `updated_at` are sortable. */
  readonly sort?: string | undefined
}

function decisionQuery(filters: DecisionFilters): QueryParameters {
  return {
    target_type: filters.targetType,
    target_id: filters.targetId,
    q: filters.term,
    sort: filters.sort,
  }
}

export function useDecisions(filters: DecisionFilters = {}): RecordListResult<Decision> {
  return decisions.useList(decisionQuery(filters))
}

export function useCreateDecision(): MutationResult<CreateDecisionInput, Decision> {
  return decisions.useCreate()
}

export function useUpdateDecision(): MutationResult<UpdateArguments<DecisionInput>, Decision> {
  return decisions.useUpdate()
}

export function useDeleteDecision(): MutationResult<string, void> {
  return decisions.useRemove()
}

/**
 * Confirms a proposal, by id.
 *
 * Not optimistic: until the server answers, the Decision is still a proposal,
 * and a page that showed it as a commitment for a moment would say the one
 * thing this field exists to keep true. The dashboard lists recent decisions
 * with the same label, so it goes stale too.
 */
export function useConfirmDecision(): MutationResult<string, Decision> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (id: string) => client.post(`/decisions/${id}/confirm`, {}, decisionSchema.parse),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['decisions'] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  return {
    run: (id) => {
      mutation.mutate(id)
    },
    runAsync: (id) => mutation.mutateAsync(id),
    isPending: mutation.isPending,
    error: toError(mutation.error),
  }
}
