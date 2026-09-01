import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/** Domain events published by the enquiries module. */

export const enquiriesEvents = {
  'enquiries.enquiry.created': z.object({}).strict(),
  'enquiries.enquiry.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'enquiries.enquiry.deleted': z.object({}).strict(),
  'enquiries.enquiry.stage_changed': z.object({
    fromStageId: z.string().nullable(),
    toStageId: z.string(),
  }),
  /**
   * The enquiry has been converted to a Deal. Fires from
   * `POST /v1/enquiries/:id/convert`. Not deliverable as a webhook: consumers
   * outside Kelpie subscribe to `record.created` on the deal instead. Kept for
   * internal listeners that want the semantic signal.
   */
  'enquiries.enquiry.converted': z.object({
    dealId: z.string().optional(),
    targetType: z.string(),
    targetId: z.string(),
  }),
} satisfies ModuleEventCatalog

export type EnquiryCreatedData = Record<string, never>
export interface EnquiryUpdatedData {
  readonly changed: readonly string[]
}
export type EnquiryDeletedData = Record<string, never>
export interface EnquiryStageChangedData {
  readonly fromStageId: string | null
  readonly toStageId: string
}
export interface EnquiryConvertedData {
  readonly dealId?: string | undefined
  readonly targetType: string
  readonly targetId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'enquiries.enquiry.created': EnquiryCreatedData
    'enquiries.enquiry.updated': EnquiryUpdatedData
    'enquiries.enquiry.deleted': EnquiryDeletedData
    'enquiries.enquiry.stage_changed': EnquiryStageChangedData
    'enquiries.enquiry.converted': EnquiryConvertedData
  }
}
