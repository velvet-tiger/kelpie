import { createPlanItemBody, planItemBody, planItemSchema } from '@kelpie/schemas'
import type {
  CreatePlanItemInput,
  PipelineKind,
  PlanItem,
  PlanItemInput,
  PlanItemStatus,
} from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type { ListOptions, MutationResult, RecordListResult, UpdateArguments } from '../resource.ts'

/**
 * `/v1/plan_items`: the dated next steps on the four pipelines.
 *
 * Unlike notes, this list is answerable workspace-wide, because the Planning
 * page is exactly that question. `useRecordPlanItems` narrows it to one record's
 * panel and `usePlanItemsForRecords` to a page of them.
 *
 * No `alsoInvalidates`: a plan item write emits no activity and touches no other
 * resource. The one cross-resource effect runs the other way, when deleting a
 * pipeline record takes its plan items with it.
 */

const planItems = createResourceHooks<PlanItem, CreatePlanItemInput, PlanItemInput>({
  name: 'planItems',
  path: '/plan_items',
  decode: planItemSchema.parse,
  createBody: createPlanItemBody,
  updateBody: planItemBody,
})

/** The `?limit=` ceiling from `api.md`. A caller asking for a bounded set may ask for all of it. */
export const MAX_PAGE_SIZE = 200

export interface PlanItemFilters {
  readonly targetType?: PipelineKind
  /** The records to read steps for. Repeats on the wire: `?target_id=a&target_id=b`. */
  readonly targetIds?: readonly string[]
  readonly statuses?: readonly PlanItemStatus[]
  /** Inclusive `YYYY-MM-DD` bounds. The calendar asks for one month with the pair. */
  readonly from?: string
  readonly to?: string
  /** Page size. Worth setting only when the filter already bounds the answer. */
  readonly limit?: number
}

function planItemQuery(filters: PlanItemFilters): QueryParameters {
  return {
    target_type: filters.targetType,
    target_id: filters.targetIds,
    status: filters.statuses,
    from: filters.from,
    to: filters.to,
    limit: filters.limit,
  }
}

export function usePlanItems(
  filters: PlanItemFilters = {},
  options: ListOptions = {},
): RecordListResult<PlanItem> {
  return planItems.useList(planItemQuery(filters), options)
}

/** One record's plan, in date order: what the panel on a detail page shows. */
export function useRecordPlanItems(
  targetType: PipelineKind,
  targetId: string,
): RecordListResult<PlanItem> {
  return usePlanItems({ targetType, targetIds: [targetId] })
}

/**
 * The plan across a set of records: a Person's or a Company's roll-up.
 *
 * Held back until the ids are known. A list filtered by a set of ids has nothing
 * to ask before then, and asking with the filter omitted would answer with the
 * whole workspace instead of nothing. Ids past the `?target_id=` ceiling are
 * dropped rather than sent, because the request would be a 422 in full.
 */
export function usePlanItemsForRecords(
  targetType: PipelineKind,
  targetIds: readonly string[],
): RecordListResult<PlanItem> {
  return usePlanItems(
    { targetType, targetIds: targetIds.slice(0, MAX_PAGE_SIZE), limit: MAX_PAGE_SIZE },
    { enabled: targetIds.length > 0 },
  )
}

export function useCreatePlanItem(): MutationResult<CreatePlanItemInput, PlanItem> {
  return planItems.useCreate()
}

export function useUpdatePlanItem(): MutationResult<UpdateArguments<PlanItemInput>, PlanItem> {
  return planItems.useUpdate()
}

export function useDeletePlanItem(): MutationResult<string, void> {
  return planItems.useRemove()
}
