import { z } from 'zod'

/**
 * Wire shape for `POST /v1/workspaces/:id/sample-data`.
 *
 * The endpoint takes no body. The response is a count per object type, so a
 * caller can tell the reader what the button just did without a second query.
 */

export interface SampleDataCounts {
  readonly companies: number
  readonly people: number
  readonly positions: number
  readonly deals: number
  readonly planItems: number
  readonly notes: number
  readonly opportunities: number
  readonly raises: number
  readonly partnerships: number
  readonly enquiries: number
  readonly roles: number
  readonly candidates: number
}

export const sampleDataCountsSchema: z.ZodType<SampleDataCounts, unknown> = z
  .object({
    companies: z.number().int().nonnegative(),
    people: z.number().int().nonnegative(),
    positions: z.number().int().nonnegative(),
    deals: z.number().int().nonnegative(),
    plan_items: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    opportunities: z.number().int().nonnegative(),
    raises: z.number().int().nonnegative(),
    partnerships: z.number().int().nonnegative(),
    enquiries: z.number().int().nonnegative(),
    roles: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
  })
  .transform(
    (wire): SampleDataCounts => ({
      companies: wire.companies,
      people: wire.people,
      positions: wire.positions,
      deals: wire.deals,
      planItems: wire.plan_items,
      notes: wire.notes,
      opportunities: wire.opportunities,
      raises: wire.raises,
      partnerships: wire.partnerships,
      enquiries: wire.enquiries,
      roles: wire.roles,
      candidates: wire.candidates,
    }),
  )
