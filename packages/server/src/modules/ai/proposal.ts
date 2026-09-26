import type { AgentTaskTargetType } from '@kelpie/schemas'
import { z } from 'zod'

import { MAX_OPERATIONS } from './rules.ts'

/**
 * The vocabulary the model may return.
 *
 * The model runs with no tools. Every change it wants to make must come back
 * as one of the operations below; anything else is not expressible. That is
 * the whole point of the redesign: pipeline stage moves, deletes, sending
 * mail, and touching arbitrary tools are structurally impossible because the
 * schema cannot represent them.
 *
 * `update_target` is the escape valve for agent-oriented field edits. It is
 * per-target-type: only the fields on {@link UPDATE_FIELD_ALLOWLIST} for the
 * run's target may be set, in the same snake_case wire shape core's REST
 * update body accepts. Extra keys are dropped before the applier is called,
 * so a model that guesses at a forbidden field like `stage_id` sees its
 * write ignored — not the whole reply rejected.
 *
 * Ids referenced by `pin_note`, `create_position` and friends are
 * *hallucinatable*: the applier receives them as strings and hands them to
 * the read/write tool, which 404s cleanly. The proposal shape trusts core's
 * validation and its 404 behaviour rather than trying to re-check ids here.
 */

const OPERATION_KINDS = [
  'update_target',
  'append_note',
  'pin_note',
  'create_plan',
  'create_decision',
  'create_position',
] as const

export type OperationKind = (typeof OPERATION_KINDS)[number]

/**
 * Agent-oriented fields the model may set on the run's target, in wire
 * snake_case (the shape MCP `<resource>_update` takes).
 *
 * Excluded on purpose: identity (`name`, `email`, `phones`), pipeline
 * (`stage_id`, `pipeline_id`), ownership (`owner_id`), and anything that
 * would move money or state without human review. Kelpie's write policy
 * lives in the prompt; the allowlist enforces it structurally.
 */
export const UPDATE_FIELD_ALLOWLIST: Readonly<Record<AgentTaskTargetType, readonly string[]>> = {
  person: [
    'summary',
    'preferred_channel',
    'influence',
    'relationship',
    'tags',
    'timezone',
    'location',
    'social_profiles',
  ],
  company: [
    'description',
    'industry',
    'stage',
    'size_band',
    'hq',
    'website',
    'domain',
    'account_type',
    'icp_fit',
    'tech_stack',
    'summary',
    'tags',
  ],
  deal: ['summary', 'why_win', 'risks', 'competitors', 'tags'],
  opportunity: ['summary', 'kind', 'tags'],
  partnership: ['summary', 'kind', 'goals', 'success_looks_like', 'tags'],
  raise: ['summary', 'thesis_fit', 'pass_reason', 'tags'],
  enquiry: ['summary', 'source', 'tags'],
  event: ['summary', 'tags'],
  candidate: [],
  role: [],
  handbook: [],
  workspace: [],
}

/**
 * The operation kinds each target type accepts.
 *
 * A person's page can carry Positions and Notes; a Role cannot carry a
 * Position, and a Handbook page has no Plans. Filtering here means a
 * proposal that names an off-limits kind for its target is rejected up
 * front rather than at the applier, and the JSON schema handed to the
 * model advertises exactly what makes sense to try.
 */
export const OPERATIONS_BY_TARGET: Readonly<Record<AgentTaskTargetType, readonly OperationKind[]>> = {
  person: [
    'update_target',
    'append_note',
    'pin_note',
    'create_decision',
    'create_position',
  ],
  company: ['update_target', 'append_note', 'pin_note', 'create_decision'],
  deal: [
    'update_target',
    'append_note',
    'pin_note',
    'create_plan',
    'create_decision',
  ],
  opportunity: [
    'update_target',
    'append_note',
    'pin_note',
    'create_plan',
    'create_decision',
  ],
  partnership: [
    'update_target',
    'append_note',
    'pin_note',
    'create_plan',
    'create_decision',
  ],
  raise: [
    'update_target',
    'append_note',
    'pin_note',
    'create_plan',
    'create_decision',
  ],
  enquiry: [
    'update_target',
    'append_note',
    'pin_note',
    'create_plan',
    'create_decision',
  ],
  event: [
    'update_target',
    'append_note',
    'pin_note',
    'create_plan',
    'create_decision',
  ],
  candidate: ['append_note', 'pin_note', 'create_decision', 'create_position'],
  role: ['append_note', 'create_decision'],
  handbook: ['append_note'],
  workspace: ['append_note'],
}

/** ISO 8601 date-only (`YYYY-MM-DD`), the same shape core's `isoDateSchema` accepts. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Use YYYY-MM-DD')

/** ISO 8601 date-time, matching core's `z.iso.datetime()`. */
const isoDateTime = z.iso.datetime()

/**
 * `update_target` carries a bag: keys and value shapes are validated by core
 * when the applier hands them to `<resource>_update`, so parsing here just
 * checks that it is a JSON object. The per-target allowlist strips extras
 * before that call runs.
 */
const updateTargetOperation = z.object({
  kind: z.literal('update_target'),
  fields: z.record(z.string(), z.unknown()),
})

const appendNoteOperation = z.object({
  kind: z.literal('append_note'),
  body: z.string().min(1),
  pinned: z.boolean().default(false),
})

const pinNoteOperation = z.object({
  kind: z.literal('pin_note'),
  note_id: z.string().min(1),
})

const createPlanOperation = z.object({
  kind: z.literal('create_plan'),
  title: z.string().min(1),
  date: isoDate,
})

const createDecisionOperation = z.object({
  kind: z.literal('create_decision'),
  body: z.string().min(1),
  rationale: z.string().min(1).nullable(),
  due_at: isoDateTime.nullable(),
})

const createPositionOperation = z.object({
  kind: z.literal('create_position'),
  company_id: z.string().min(1),
  title: z.string().min(1),
})

const operationSchema = z.discriminatedUnion('kind', [
  updateTargetOperation,
  appendNoteOperation,
  pinNoteOperation,
  createPlanOperation,
  createDecisionOperation,
  createPositionOperation,
])

export type Operation = z.infer<typeof operationSchema>
export type UpdateTargetOperation = z.infer<typeof updateTargetOperation>
export type AppendNoteOperation = z.infer<typeof appendNoteOperation>
export type PinNoteOperation = z.infer<typeof pinNoteOperation>
export type CreatePlanOperation = z.infer<typeof createPlanOperation>
export type CreateDecisionOperation = z.infer<typeof createDecisionOperation>
export type CreatePositionOperation = z.infer<typeof createPositionOperation>

const proposalSchema = z.object({
  /** A short summary the run log shows to admins. */
  summary: z.string().min(1),
  operations: z.array(operationSchema).max(MAX_OPERATIONS),
})

export type Proposal = z.infer<typeof proposalSchema>

/**
 * The outcome the applier records for each operation. Persisted on the run
 * row (`ai_runs.operations`) and surfaced in the admin log.
 */
export interface OperationOutcome {
  readonly kind: OperationKind
  readonly status: 'applied' | 'failed' | 'skipped'
  /** Free-form detail: the created id, or the failure message. */
  readonly detail: string
}

export interface ValidateProposalSuccess {
  readonly ok: true
  readonly proposal: Proposal
  /**
   * Fields the model tried to set that were not on the allowlist for this
   * target type. Not fatal: the applier still runs `update_target` with
   * only the permitted keys, and these are surfaced in the outcome list so
   * an admin can see what was ignored.
   */
  readonly droppedFields: readonly string[]
  /**
   * Operations whose kind is not in {@link OPERATIONS_BY_TARGET} for this
   * target. Also not fatal — they are dropped and reported.
   */
  readonly droppedOperationKinds: readonly OperationKind[]
}

export interface ValidateProposalFailure {
  readonly ok: false
  /** One line per Zod issue, joined for the repair message. */
  readonly issues: readonly string[]
}

export type ValidateProposalResult = ValidateProposalSuccess | ValidateProposalFailure

/**
 * Parses raw JSON from the model against {@link proposalSchema} and applies
 * the per-target allowlists.
 *
 * Zod is the authority: the model's JSON schema tells OpenAI what to aim
 * for, but the reply must still parse here or the executor issues one
 * repair turn. On success the returned proposal has every off-limits
 * operation removed and every off-limits field inside `update_target`
 * stripped; both drops are reported so the applier records them.
 */
export function validateProposal(
  targetType: AgentTaskTargetType,
  raw: unknown,
): ValidateProposalResult {
  const parsed = proposalSchema.safeParse(raw)

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }
  }

  const allowedKinds = new Set(OPERATIONS_BY_TARGET[targetType])
  const allowedFields = new Set(UPDATE_FIELD_ALLOWLIST[targetType])

  const droppedOperationKinds: OperationKind[] = []
  const droppedFields: string[] = []

  const operations: Operation[] = []
  for (const operation of parsed.data.operations) {
    if (!allowedKinds.has(operation.kind)) {
      droppedOperationKinds.push(operation.kind)
      continue
    }

    if (operation.kind === 'update_target') {
      const kept: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(operation.fields)) {
        if (allowedFields.has(key)) {
          kept[key] = value
        } else {
          droppedFields.push(key)
        }
      }
      // A stripped-empty update_target adds nothing; skip it rather than
      // sending an empty PATCH that would be a no-op at the service anyway.
      if (Object.keys(kept).length === 0) {
        continue
      }
      operations.push({ kind: 'update_target', fields: kept })
      continue
    }

    operations.push(operation)
  }

  return {
    ok: true,
    proposal: { summary: parsed.data.summary, operations },
    droppedFields,
    droppedOperationKinds,
  }
}

/**
 * Renders the JSON schema handed to the OpenAI Responses API for structured
 * output. Reflects the same operations {@link OPERATIONS_BY_TARGET} allows
 * for the target, so the model is nudged at the schema layer as well as
 * the prose layer.
 *
 * `strict: false` at the provider call — `z.toJSONSchema` does not meet
 * OpenAI's strict subset (open records, defaults, unions with defaults) —
 * so this shape is advisory. The Zod re-parse in {@link validateProposal}
 * is the authority.
 */
export function proposalJsonSchemaFor(targetType: AgentTaskTargetType): Record<string, unknown> {
  const allowedKinds = new Set(OPERATIONS_BY_TARGET[targetType])
  const kindSchemas: Record<OperationKind, z.ZodTypeAny> = {
    update_target: updateTargetOperation,
    append_note: appendNoteOperation,
    pin_note: pinNoteOperation,
    create_plan: createPlanOperation,
    create_decision: createDecisionOperation,
    create_position: createPositionOperation,
  }
  const advertised: z.ZodTypeAny[] = []
  for (const kind of OPERATION_KINDS) {
    if (allowedKinds.has(kind)) {
      advertised.push(kindSchemas[kind])
    }
  }

  // No allowed operations means the model may only return a summary; a
  // `z.never()` element makes `operations` render as an empty-only array,
  // which is the shape we want.
  const [first, second, ...rest] = advertised
  const operationsUnion: z.ZodTypeAny =
    first === undefined
      ? z.never()
      : second === undefined
        ? first
        : z.union([first, second, ...rest])

  const schema = z.object({
    summary: z.string().min(1),
    operations: z.array(operationsUnion).max(MAX_OPERATIONS),
  })

  return z.toJSONSchema(schema) as Record<string, unknown>
}
