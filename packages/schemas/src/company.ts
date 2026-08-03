import { z } from 'zod'

import { ACCOUNT_TYPES, COMPANY_STAGES, ICP_FITS, SIZE_BANDS } from './values.ts'
import type { AccountType, CompanyStage, IcpFit, SizeBand } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/** Wire and write shapes for `/v1/companies`. */

export interface Company extends RecordTimestamps {
  readonly id: string
  readonly name: string
  readonly domain: string | null
  readonly industry: string | null
  readonly description: string
  readonly stage: CompanyStage
  readonly sizeBand: SizeBand
  readonly hq: string | null
  readonly website: string | null
  readonly accountType: AccountType
  readonly icpFit: IcpFit
  readonly techStack: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
}

export const companySchema: z.ZodType<Company, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    domain: z.string().nullable(),
    industry: z.string().nullable(),
    description: z.string(),
    stage: z.enum(COMPANY_STAGES),
    size_band: z.enum(SIZE_BANDS),
    hq: z.string().nullable(),
    website: z.string().nullable(),
    account_type: z.enum(ACCOUNT_TYPES),
    icp_fit: z.enum(ICP_FITS),
    tech_stack: z.array(z.string()),
    summary: z.string(),
    tags: z.array(z.string()),
    ...recordTimestamps,
  })
  .transform(
    (wire): Company => ({
      id: wire.id,
      name: wire.name,
      domain: wire.domain,
      industry: wire.industry,
      description: wire.description,
      stage: wire.stage,
      sizeBand: wire.size_band,
      hq: wire.hq,
      website: wire.website,
      accountType: wire.account_type,
      icpFit: wire.icp_fit,
      techStack: wire.tech_stack,
      summary: wire.summary,
      tags: wire.tags,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CompanyInput {
  readonly name?: string
  readonly domain?: string | null
  readonly industry?: string | null
  readonly description?: string
  readonly stage?: CompanyStage
  readonly sizeBand?: SizeBand
  readonly hq?: string | null
  readonly website?: string | null
  readonly accountType?: AccountType
  readonly icpFit?: IcpFit
  readonly techStack?: readonly string[]
  readonly summary?: string
  readonly tags?: readonly string[]
}

export function companyBody(input: CompanyInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    domain: input.domain,
    industry: input.industry,
    description: input.description,
    stage: input.stage,
    size_band: input.sizeBand,
    hq: input.hq,
    website: input.website,
    account_type: input.accountType,
    icp_fit: input.icpFit,
    tech_stack: input.techStack,
    summary: input.summary,
    tags: input.tags,
  })
}
