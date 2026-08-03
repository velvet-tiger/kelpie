import {
  createPipelineStageBody,
  pipelineStageSchema,
  updatePipelineStageBody,
} from '@kelpie/schemas'
import type {
  CreatePipelineStageInput,
  PipelineKind,
  PipelineStage,
  UpdatePipelineStageInput,
} from '@kelpie/schemas'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import { createResourceHooks } from '../resource.ts'
import type { ListOptions, MutationResult, RecordListResult, UpdateArguments } from '../resource.ts'

/**
 * `/v1/pipeline_stages`: the board columns of the four pipelines.
 *
 * Stage config redraws whatever references it: a rename or reorder changes every
 * board column, and remove-with-reassign moves records and writes their
 * timelines, so writes here invalidate the staged resources too.
 */

const STAGE_WRITES_TOUCH = ['deals', 'activities'] as const

const stages = createResourceHooks<PipelineStage, CreatePipelineStageInput, UpdatePipelineStageInput>({
  name: 'pipeline_stages',
  path: '/pipeline_stages',
  decode: pipelineStageSchema.parse,
  createBody: createPipelineStageBody,
  updateBody: updatePipelineStageBody,
  alsoInvalidates: STAGE_WRITES_TOUCH,
})

/**
 * One pipeline's stages, in board order. The documented page maximum, because a
 * board needs all of its columns: a pipeline paged at 50 would render half a
 * board without saying so.
 */
export function usePipelineStages(
  kind: PipelineKind,
  options: ListOptions = {},
): RecordListResult<PipelineStage> {
  return stages.useList({ kind, limit: 200 }, options)
}

export function useCreatePipelineStage(): MutationResult<CreatePipelineStageInput, PipelineStage> {
  return stages.useCreate()
}

export function useUpdatePipelineStage(): MutationResult<
  UpdateArguments<UpdatePipelineStageInput>,
  PipelineStage
> {
  return stages.useUpdate()
}

export interface RemovePipelineStageInput {
  readonly id: string
  /** Where the stage's records go. Always named, so the server never has to guess. */
  readonly moveToId: string
}

/**
 * Remove-with-reassign. Not `createResourceHooks`' remove: that one deletes by
 * bare id, and this delete carries `?move_to=` so the records still in the
 * stage land somewhere chosen rather than blocking the delete with a 409.
 */
export function useRemovePipelineStage(): MutationResult<RemovePipelineStageInput, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ id, moveToId }: RemovePipelineStageInput) =>
      client.delete(`/pipeline_stages/${id}?move_to=${encodeURIComponent(moveToId)}`),
    onSettled: () => {
      for (const name of ['pipeline_stages', ...STAGE_WRITES_TOUCH]) {
        void queryClient.invalidateQueries({ queryKey: [name] })
      }
    },
  })

  return {
    run: (input) => {
      mutation.mutate(input)
    },
    runAsync: (input) => mutation.mutateAsync(input),
    isPending: mutation.isPending,
    error: toError(mutation.error),
  }
}
