import { createDecisionBody, decisionBody, decisionSchema } from '@kelpie/schemas'
import type {
  CreateDecisionInput,
  Decision,
  DecisionInput,
  RecordTargetType,
} from '@kelpie/schemas'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import type { QueryParameters } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import { cacheRecord, createResourceHooks } from '../resource.ts'
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

/** The proposal to confirm, as the member read it. */
export interface ConfirmDecisionArguments {
  readonly id: string
  /**
   * The `updatedAt` of the Decision on screen. The server refuses with `409`
   * when the Decision was edited after it, so the member confirms the text
   * they read and not one an agent put there before the click.
   */
  readonly updatedAt: Date
}

export interface ConfirmDecisionResult extends MutationResult<ConfirmDecisionArguments, Decision> {
  /**
   * Every Decision a confirm is in flight for, so each row shows its own
   * state. A set and not one id: a member can click a second row before the
   * first answer is back, and both are then still in flight.
   */
  readonly pendingIds: ReadonlySet<string>
  /** How many confirms have succeeded on this page, for a status line a screen reader hears. */
  readonly confirmedCount: number
}

/**
 * Confirms a proposal.
 *
 * Not optimistic: until the server answers, the Decision is still a proposal,
 * and a page that showed it as a commitment for a moment would say the one
 * thing this field exists to keep true. The answer is written into the caches
 * at once, so the row does not stay "not confirmed" while the lists refetch.
 * The dashboard lists recent decisions with the same label, so it goes stale
 * too. A refusal refetches the lists: the usual cause is that the text changed.
 */
export function useConfirmDecision(): ConfirmDecisionResult {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const [confirmedCount, setConfirmedCount] = useState(0)
  const mutation = useMutation({
    mutationFn: ({ id, updatedAt }: ConfirmDecisionArguments) =>
      client.post(
        `/decisions/${id}/confirm`,
        { updated_at: updatedAt.toISOString() },
        decisionSchema.parse,
      ),
    // The mutation's own state follows only the newest call. These two run
    // for every call, so the set holds each id until its own answer is back.
    onMutate: ({ id }) => {
      setPendingIds((current) => new Set(current).add(id))
    },
    onSettled: (_decision, _error, { id }) => {
      setPendingIds((current) => new Set([...current].filter((pending) => pending !== id)))
    },
    onSuccess: (decision) => {
      setConfirmedCount((count) => count + 1)
      cacheRecord(queryClient, 'decisions', decision)
      void queryClient.invalidateQueries({ queryKey: ['decisions'] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['decisions'] })
    },
  })

  return {
    run: (input) => {
      mutation.mutate(input)
    },
    runAsync: (input) => mutation.mutateAsync(input),
    isPending: pendingIds.size > 0,
    pendingIds,
    confirmedCount,
    error: toError(mutation.error),
  }
}
