import type { PipelineKind } from '@kelpie/schemas'

import { dealResponse } from '../deals/routes.ts'
import type { DealRecord } from '../deals/repository.ts'
import { enquiryResponse } from '../enquiries/routes.ts'
import type { EnquiryRecord } from '../enquiries/repository.ts'
import { opportunityResponse } from '../opportunities/routes.ts'
import type { OpportunityRecord } from '../opportunities/repository.ts'
import { partnershipResponse } from '../partnerships/routes.ts'
import type { PartnershipRecord } from '../partnerships/repository.ts'
import { raiseResponse } from '../raises/routes.ts'
import type { RaiseRecord } from '../raises/repository.ts'

/** Wire-shape a freshly converted pipeline record for any target type. */
export function renderConvertedPipelineRecord(
  targetKind: PipelineKind,
  target: unknown,
  personIds: readonly string[],
): Record<string, unknown> {
  const { workspaceId: _workspaceId, ...record } = target as {
    workspaceId: string
  }

  switch (targetKind) {
    case 'enquiry':
      return enquiryResponse({ ...(record as Omit<EnquiryRecord, 'workspaceId'>), personIds })
    case 'deal':
      return dealResponse({ ...(record as Omit<DealRecord, 'workspaceId'>), personIds })
    case 'opportunity':
      return opportunityResponse({
        ...(record as Omit<OpportunityRecord, 'workspaceId'>),
        personIds,
      })
    case 'raise':
      return raiseResponse({ ...(record as Omit<RaiseRecord, 'workspaceId'>), personIds })
    case 'partnership':
      return partnershipResponse({
        ...(record as Omit<PartnershipRecord, 'workspaceId'>),
        personIds,
      })
  }
}
