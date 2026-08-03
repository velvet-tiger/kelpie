import { createPositionBody, positionSchema, updatePositionBody } from '@kelpie/schemas'
import type { CreatePositionInput, Position } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  UpdateArguments,
} from '../resource.ts'

/**
 * `/v1/positions`, the Person↔Company link holding the job title.
 *
 * Only the title is updatable. Re-pointing a link at a different person or
 * company is a delete and a create, which is what the API accepts.
 */

export interface PositionTitleUpdate {
  readonly title: string
}

const positions = createResourceHooks<Position, CreatePositionInput, PositionTitleUpdate>({
  name: 'positions',
  path: '/positions',
  decode: positionSchema.parse,
  createBody: createPositionBody,
  updateBody: (input) => updatePositionBody(input.title),
  // `?company_id=` on people and `?person_id=` on companies are lists this join
  // decides the membership of. Without this, linking a person to a company shows
  // the new row with the name still unfetched.
  alsoInvalidates: ['people', 'companies'],
})

export interface PositionFilters {
  /** Positions held by any of these people. Repeats on the wire. */
  readonly personIds?: readonly string[]
  /** Positions held at any of these companies. Repeats on the wire. */
  readonly companyIds?: readonly string[]
  readonly limit?: number
}

function positionQuery(filters: PositionFilters): QueryParameters {
  return { person_id: filters.personIds, company_id: filters.companyIds, limit: filters.limit }
}

export function usePositions(
  filters: PositionFilters = {},
  options: ListOptions = {},
): RecordListResult<Position> {
  return positions.useList(positionQuery(filters), options)
}

export function useCreatePosition(): MutationResult<CreatePositionInput, Position> {
  return positions.useCreate()
}

export function useUpdatePositionTitle(): MutationResult<
  UpdateArguments<PositionTitleUpdate>,
  Position
> {
  return positions.useUpdate()
}

export function useDeletePosition(): MutationResult<string, void> {
  return positions.useRemove()
}
