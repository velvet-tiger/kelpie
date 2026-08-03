import { createDecisionBody, decisionBody, decisionSchema } from '@kelpie/schemas'
import type {
  CreateDecisionInput,
  Decision,
  DecisionInput,
  RecordTargetType,
} from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
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
  readonly targetType?: RecordTargetType
  readonly targetId?: string
  /** Matches the body, the rationale, the target type, and the target's name. */
  readonly term?: string
}

function decisionQuery(filters: DecisionFilters): QueryParameters {
  return {
    target_type: filters.targetType,
    target_id: filters.targetId,
    q: filters.term,
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
