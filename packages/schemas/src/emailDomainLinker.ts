import { z } from 'zod'

/**
 * Wire shape for `POST /v1/workspaces/:id/relink-email-domains`.
 *
 * The endpoint takes no body. The response counts what the sweep did: how
 * many Companies were scanned and how many titleless Positions were newly
 * created. A follow-up run on the same workspace returns the same count for
 * `companies_scanned` and zero for `positions_created` — the sweep is
 * idempotent (a person already linked to that company is skipped).
 */

export interface RelinkEmailDomainsCounts {
  readonly companiesScanned: number
  readonly positionsCreated: number
}

export const relinkEmailDomainsCountsSchema: z.ZodType<RelinkEmailDomainsCounts, unknown> = z
  .object({
    companies_scanned: z.number().int().nonnegative(),
    positions_created: z.number().int().nonnegative(),
  })
  .transform(
    (wire): RelinkEmailDomainsCounts => ({
      companiesScanned: wire.companies_scanned,
      positionsCreated: wire.positions_created,
    }),
  )
