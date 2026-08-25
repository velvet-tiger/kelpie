import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { ACCOUNT_TYPES, COMPANY_STAGES, ICP_FITS, SIZE_BANDS } from './schema.ts'
import type {
  CompaniesService,
  CompanyView,
  CreateCompanyInput,
  UpdateCompanyInput,
} from './service.ts'

/** Wire shapes for `/v1/companies`. Bodies are strict; an unknown field is a 422, per `api.md`. */

/** The full field set, without defaults. `createBody` adds those; `updateBody` makes it partial. */
const companyShape = {
  name: z.string().min(1),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  description: z.string(),
  stage: z.enum(COMPANY_STAGES),
  size_band: z.enum(SIZE_BANDS),
  hq: z.string().nullable(),
  website: z.string().nullable(),
  account_type: z.enum(ACCOUNT_TYPES),
  icp_fit: z.enum(ICP_FITS),
  tech_stack: z.array(z.string().min(1)),
  summary: z.string(),
  tags: z.array(z.string().min(1)),
  is_own: z.boolean(),
}

/**
 * Only `name` is required. The defaults are the ones the mockup's own Add company
 * button writes, so creating through the API and creating through the UI produce
 * the same record.
 */
export const createBody = z.strictObject({
  ...companyShape,
  domain: companyShape.domain.default(null),
  industry: companyShape.industry.default(null),
  description: companyShape.description.default(''),
  stage: companyShape.stage.default('startup'),
  size_band: companyShape.size_band.default('1-10'),
  hq: companyShape.hq.default(null),
  website: companyShape.website.default(null),
  account_type: companyShape.account_type.default('prospect'),
  icp_fit: companyShape.icp_fit.default('unknown'),
  tech_stack: companyShape.tech_stack.default([]),
  summary: companyShape.summary.default(''),
  tags: companyShape.tags.default([]),
  is_own: companyShape.is_own.default(false),
})

export const updateBody = z.strictObject(companyShape).partial()

export interface CompaniesRoutesDependencies extends CredentialDependencies {
  readonly service: CompaniesService
}

export function toCreateInput(body: z.infer<typeof createBody>): CreateCompanyInput {
  return {
    name: body.name,
    domain: body.domain,
    industry: body.industry,
    description: body.description,
    stage: body.stage,
    sizeBand: body.size_band,
    hq: body.hq,
    website: body.website,
    accountType: body.account_type,
    icpFit: body.icp_fit,
    techStack: body.tech_stack,
    summary: body.summary,
    tags: body.tags,
    isOwn: body.is_own,
  }
}

export function toUpdateInput(body: z.infer<typeof updateBody>): UpdateCompanyInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.domain === undefined ? {} : { domain: body.domain }),
    ...(body.industry === undefined ? {} : { industry: body.industry }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.stage === undefined ? {} : { stage: body.stage }),
    ...(body.size_band === undefined ? {} : { sizeBand: body.size_band }),
    ...(body.hq === undefined ? {} : { hq: body.hq }),
    ...(body.website === undefined ? {} : { website: body.website }),
    ...(body.account_type === undefined ? {} : { accountType: body.account_type }),
    ...(body.icp_fit === undefined ? {} : { icpFit: body.icp_fit }),
    ...(body.tech_stack === undefined ? {} : { techStack: body.tech_stack }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.is_own === undefined ? {} : { isOwn: body.is_own }),
  }
}

export function companyResponse(company: CompanyView): Record<string, unknown> {
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    industry: company.industry,
    description: company.description,
    stage: company.stage,
    size_band: company.sizeBand,
    hq: company.hq,
    website: company.website,
    account_type: company.accountType,
    icp_fit: company.icpFit,
    tech_stack: company.techStack,
    summary: company.summary,
    tags: company.tags,
    is_own: company.isOwn,
    created_at: company.createdAt.toISOString(),
    updated_at: company.updatedAt.toISOString(),
  }
}

export function mountCompaniesRoutes(router: Hono, dependencies: CompaniesRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/companies', async (context) => {
    // `?is_own=true|false` narrows to the workspace's own companies (or the
    // rest). Anything else is treated as absent, so an unknown value never
    // returns an accidental "everything".
    const isOwnParam = context.req.query('is_own')
    const isOwn =
      isOwnParam === 'true' ? true : isOwnParam === 'false' ? false : undefined

    const page = await dependencies.service.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        personIds: readIdFilter(context, 'person_id'),
        isOwn,
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, companyResponse))
  })

  router.post('/companies', async (context) => {
    const body = await readJsonBody(context, createBody)
    const company = await dependencies.service.create(
      await requireActor(context),
      toCreateInput(body),
    )

    return context.json(companyResponse(company), 201)
  })

  router.get('/companies/:id', async (context) => {
    const company = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(companyResponse(company))
  })

  router.patch('/companies/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const company = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(companyResponse(company))
  })

  router.delete('/companies/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}
