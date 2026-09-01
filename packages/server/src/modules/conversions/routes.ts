import type { ConvertPipelineRecordInput, PipelineKind } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import type { z } from 'zod'

import { readJsonBody } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { ConversionsService } from './service.ts'
import { renderConvertedPipelineRecord } from './wire.ts'

export interface ConvertRouteDependencies extends CredentialDependencies {
  readonly conversions: ConversionsService
  readonly sourceKind: PipelineKind
  readonly bodySchema: z.ZodType<{
    target_type: PipelineKind
    stage_id?: string | undefined
    company_id?: string | undefined
    kind?: string | undefined
    name?: string | undefined
  }>
  readonly renderTarget?: (
    targetKind: PipelineKind,
    target: unknown,
    personIds: readonly string[],
  ) => Record<string, unknown>
}

export function toConvertInput(body: {
  target_type: PipelineKind
  stage_id?: string | undefined
  company_id?: string | undefined
  kind?: string | undefined
  name?: string | undefined
}): ConvertPipelineRecordInput {
  return {
    targetType: body.target_type,
    stageId: body.stage_id,
    companyId: body.company_id,
    kind: body.kind,
    name: body.name,
  }
}

export function mountPipelineConvertRoute(
  router: Hono,
  path: string,
  dependencies: ConvertRouteDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.post(path, async (context) => {
    const id = context.req.param('id')!

    const body = await readJsonBody(context, dependencies.bodySchema)
    const { targetKind, target, personIds } = await dependencies.conversions.convert(
      await requireActor(context),
      dependencies.sourceKind,
      id,
      toConvertInput(body),
    )

    const render =
      dependencies.renderTarget ?? ((kind, record, ids) => renderConvertedPipelineRecord(kind, record, ids))

    return context.json(render(targetKind, target, personIds), 201)
  })
}
