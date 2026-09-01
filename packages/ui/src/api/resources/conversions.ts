import {
  convertPipelineRecordRequest,
  dealSchema,
  enquirySchema,
  opportunitySchema,
  partnershipSchema,
  raiseSchema,
} from '@kelpie/schemas'
import type {
  ConvertPipelineRecordInput,
  ConvertedTo,
  Deal,
  Enquiry,
  Opportunity,
  Partnership,
  PipelineKind,
  Raise,
} from '@kelpie/schemas'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'

const COLLECTION_PATHS: Readonly<Record<PipelineKind, string>> = {
  enquiry: 'enquiries',
  deal: 'deals',
  opportunity: 'opportunities',
  raise: 'raises',
  partnership: 'partnerships',
}

const DETAIL_PATHS: Readonly<Record<PipelineKind, string>> = {
  enquiry: '/enquiries',
  deal: '/deals',
  opportunity: '/opportunities',
  raise: '/raises',
  partnership: '/partnerships',
}

export function detailPathForPipelineKind(kind: PipelineKind, id: string): string {
  return `${DETAIL_PATHS[kind]}/${id}`
}

export type ConvertedPipelineRecord = Deal | Enquiry | Opportunity | Raise | Partnership

function parseConvertedRecord(kind: PipelineKind, body: unknown): ConvertedPipelineRecord {
  switch (kind) {
    case 'enquiry':
      return enquirySchema.parse(body)
    case 'deal':
      return dealSchema.parse(body)
    case 'opportunity':
      return opportunitySchema.parse(body)
    case 'raise':
      return raiseSchema.parse(body)
    case 'partnership':
      return partnershipSchema.parse(body)
  }
}

export interface ConvertPipelineRecordArguments {
  readonly id: string
  readonly body: ConvertPipelineRecordInput
}

export function useConvertPipelineRecord(
  sourceKind: PipelineKind,
): MutationResult<ConvertPipelineRecordArguments, ConvertedPipelineRecord> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const collection = COLLECTION_PATHS[sourceKind]

  const mutation = useMutation({
    mutationFn: ({ id, body }: ConvertPipelineRecordArguments) =>
      client.post(
        `/${collection}/${id}/convert`,
        convertPipelineRecordRequest(body),
        (wire) => parseConvertedRecord(body.targetType, wire),
      ),
    onSuccess: (_record, variables) => {
      void queryClient.invalidateQueries({ queryKey: [collection] })
      void queryClient.invalidateQueries({
        queryKey: [COLLECTION_PATHS[variables.body.targetType]],
      })
      void queryClient.invalidateQueries({ queryKey: ['activities'] })
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
      void queryClient.invalidateQueries({ queryKey: ['plan_items'] })
      void queryClient.invalidateQueries({ queryKey: ['decisions'] })
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

export function convertedTargetPath(converted: ConvertedTo): string {
  return detailPathForPipelineKind(converted.targetType, converted.targetId)
}

/** @deprecated Use `useConvertPipelineRecord('enquiry')` with `{ targetType: 'deal' }`. */
export function useConvertEnquiry(): MutationResult<string, Deal> {
  const convert = useConvertPipelineRecord('enquiry')

  return {
    run: (id) => {
      convert.run({ id, body: { targetType: 'deal' } })
    },
    runAsync: async (id) => {
      const record = await convert.runAsync({ id, body: { targetType: 'deal' } })

      return dealSchema.parse(record)
    },
    isPending: convert.isPending,
    error: convert.error,
  }
}

export { COLLECTION_PATHS, DETAIL_PATHS }
