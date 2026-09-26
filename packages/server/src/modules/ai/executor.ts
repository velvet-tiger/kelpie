import { AGENT_TASK_TARGET_TYPES } from '@kelpie/schemas'
import type { AgentTaskTargetType } from '@kelpie/schemas'

import { describeThrown } from '../../lib/errors.ts'
import type { Actor } from '../auth/actor.ts'
import type { Database } from '../../lib/database.ts'
import type { Logger } from '../../lib/logger.ts'
import type { McpTool } from '../../runtime/module.ts'

import { ContextPackTargetError, buildContextPack } from './contextPack.ts'
import { renderInstructions, renderRepairMessage, renderUserMessage } from './prompt.ts'
import type { AiCompletionResult, AiMessage, AiProviderPort } from './provider.ts'
import { proposalJsonSchemaFor, validateProposal } from './proposal.ts'
import type {
  AppendNoteOperation,
  CreateDecisionOperation,
  CreatePlanOperation,
  CreatePositionOperation,
  Operation,
  OperationOutcome,
  PinNoteOperation,
  Proposal,
  UpdateTargetOperation,
  ValidateProposalSuccess,
} from './proposal.ts'
import {
  claimOldestQueuedRun,
  countRunningRuns,
  settleRun,
  touchRun,
} from './repository.ts'
import type { AiRunRecord } from './repository.ts'
import { aiActorFor } from './tools.ts'

/**
 * The detached work-runner.
 *
 * `pump` is fire-and-forget: intake schedules a run and calls `pump`, and
 * `execute` runs after the current stack unwinds. The `void`-`catch` shape is
 * the import-export `detach` pattern crossed with core's post-commit dispatch
 * — a hand-rolled shape because core exports no shared helper for it.
 *
 * The whole model turn is one shot. Kelpie builds a context pack by reading
 * the target record and its neighbours through core's in-process MCP read
 * tools, then calls the provider with **no tools** and a strict JSON
 * response format. The reply is validated as a proposal; the applier walks
 * each operation and writes it through the same MCP registry with the
 * synthetic AI actor. The model never touches a tool.
 *
 * Concurrency: while running-count < cap, claim the oldest queued row and
 * execute it. The claim is race-safe (`claimOldestQueuedRun`), and `execute`
 * settles its row itself and never rejects, so the loop cannot leak an
 * unhandled rejection. Completion-chaining falls out of the loop: when a run
 * finishes, its pump call keeps draining.
 *
 * There is no scheduler, no worker pool, and no durable queue. A crash mid-
 * run leaves a row `running`; the next intake's stale sweep marks it failed.
 */

/** A provider port for a workspace, or the reason there is none. */
export type AiPortResolution =
  | { readonly kind: 'ready'; readonly port: AiProviderPort }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface AiExecutorDependencies {
  readonly db: Database
  /**
   * Builds the port for a workspace at run time. In `workspace` key mode the
   * key is the workspace's, so there is no single port for the process.
   */
  readonly resolvePort: (workspaceId: string) => Promise<AiPortResolution>
  /** Every MCP tool in the assembly. Read at run time, after boot. */
  readonly listTools: () => readonly McpTool[]
  /**
   * True when the key belongs to the workspace. A provider error (wrong key,
   * no quota, unknown model) is then the workspace's to fix, and the run log
   * shows the provider's message. False when the key is the deployment's:
   * the customer sees a generic message and the operator reads the log.
   */
  readonly exposeProviderErrors: boolean
  readonly now: () => Date
  readonly maxTokens: number
  readonly maxConcurrentRuns: number
  readonly log: Logger
}

export interface AiExecutor {
  /**
   * Starts every queued run capacity allows for this workspace, detached.
   * Never rejects; failures land on the row and are logged.
   */
  pump(workspaceId: string): void
  /** Awaited pump variant, for tests. */
  pumpAwait(workspaceId: string): Promise<void>
}

/**
 * What the run log says when the provider fails or throws.
 *
 * With a deployment key, provider-side errors — quota exhausted, rate
 * limits, HTTP 5xx, network — are the operator's problem, not the
 * customer's. The full detail goes to the log so an operator can see it;
 * the customer sees this. With a workspace key (`exposeProviderErrors`) the
 * customer sees the provider's message, because only they can fix it. A
 * network failure or a bug still shows this message in both modes. A
 * refusal is different: that is the model deliberately declining the task,
 * and the customer needs to know it happened, so `refusal` keeps its
 * message.
 */
const PROVIDER_FAILURE_MESSAGE =
  'The AI service was unavailable for this run. Try again shortly.'

/**
 * The target types the proposal vocabulary is defined for: every agent-task
 * target. The cloud copy listed its own ten and left out `enquiry` and
 * `event`, so a run on either failed as an unknown target type.
 */
function toKnownTargetType(raw: string): AgentTaskTargetType | undefined {
  return (AGENT_TASK_TARGET_TYPES as readonly string[]).includes(raw)
    ? (raw as AgentTaskTargetType)
    : undefined
}

export function createAiExecutor(dependencies: AiExecutorDependencies): AiExecutor {
  function logProviderFailure(result: AiCompletionResult, run: AiRunRecord): void {
    if (result.stopReason !== 'failed') return

    dependencies.log.warn('ai provider call failed', {
      runId: run.id,
      workspaceId: run.workspaceId,
      code: result.failure?.code ?? 'unknown',
      error: result.failure?.message ?? 'no message',
    })
  }

  async function execute(run: AiRunRecord): Promise<void> {
    try {
      const targetType = toKnownTargetType(run.targetType)
      if (targetType === undefined) {
        await settleRun(
          dependencies.db,
          run.id,
          {
            status: 'failed',
            failureReason: `Unknown target type "${run.targetType}"; the deployment may be missing a module`,
          },
          dependencies.now(),
        )
        return
      }

      const resolution = await dependencies.resolvePort(run.workspaceId)
      if (resolution.kind === 'unavailable') {
        await settleRun(
          dependencies.db,
          run.id,
          { status: 'failed', failureReason: resolution.reason },
          dependencies.now(),
        )
        return
      }
      const port = resolution.port

      const toolsByName = indexByName(dependencies.listTools())
      const actor = aiActorFor(run.workspaceId)

      // Refresh the heartbeat before every long call so the stale sweep
      // measures inactivity from the most recent milestone.
      await touchRun(dependencies.db, run.id, dependencies.now())

      let pack
      try {
        pack = await buildContextPack(
          { toolsByName },
          {
            targetType,
            targetId: run.targetId,
            context: run.context,
            actor,
          },
        )
      } catch (thrown: unknown) {
        const reason =
          thrown instanceof ContextPackTargetError
            ? thrown.message
            : `Could not load the context pack: ${describeThrown(thrown)}`

        await settleRun(
          dependencies.db,
          run.id,
          { status: 'failed', failureReason: reason },
          dependencies.now(),
        )
        return
      }

      const instructions = renderInstructions(targetType)
      const responseFormat = {
        name: 'kelpie_proposal',
        schema: proposalJsonSchemaFor(targetType),
      }

      let inputTokens = 0
      let outputTokens = 0

      const initialMessage: AiMessage = {
        role: 'user',
        text: renderUserMessage(run.prompt, pack.markdown),
      }
      const messages: AiMessage[] = [initialMessage]

      await touchRun(dependencies.db, run.id, dependencies.now())
      const first = await port.complete({
        model: run.model,
        maxTokens: dependencies.maxTokens,
        instructions,
        messages,
        responseFormat,
      })
      logProviderFailure(first, run)
      inputTokens += first.usage.inputTokens
      outputTokens += first.usage.outputTokens

      const firstOutcome = interpretProviderResult(first, targetType, dependencies.exposeProviderErrors)
      let validated: ValidateProposalSuccess | undefined

      if (firstOutcome.kind === 'fail') {
        await settleRun(
          dependencies.db,
          run.id,
          {
            status: 'failed',
            failureReason: firstOutcome.reason,
            inputTokens,
            outputTokens,
          },
          dependencies.now(),
        )
        return
      }
      if (firstOutcome.kind === 'proposal') {
        validated = firstOutcome.proposal
      } else {
        // `retry`: one repair turn only.
        messages.push({ role: 'assistant', text: first.text })
        messages.push({ role: 'user', text: renderRepairMessage(firstOutcome.issues) })

        await touchRun(dependencies.db, run.id, dependencies.now())
        const second = await port.complete({
          model: run.model,
          maxTokens: dependencies.maxTokens,
          instructions,
          messages,
          responseFormat,
        })
        logProviderFailure(second, run)
        inputTokens += second.usage.inputTokens
        outputTokens += second.usage.outputTokens

        const secondOutcome = interpretProviderResult(second, targetType, dependencies.exposeProviderErrors)
        if (secondOutcome.kind === 'proposal') {
          validated = secondOutcome.proposal
        } else {
          const failureReason =
            secondOutcome.kind === 'fail'
              ? secondOutcome.reason
              : `The model did not return a valid proposal after a repair turn: ${secondOutcome.issues.join('; ')}`
          await settleRun(
            dependencies.db,
            run.id,
            {
              status: 'failed',
              failureReason,
              inputTokens,
              outputTokens,
            },
            dependencies.now(),
          )
          return
        }
      }

      const outcomes = await applyProposal({
        proposal: validated.proposal,
        droppedFields: validated.droppedFields,
        droppedOperationKinds: validated.droppedOperationKinds,
        run,
        actor,
        toolsByName,
        log: dependencies.log,
      })

      await settleRun(
        dependencies.db,
        run.id,
        {
          status: 'succeeded',
          output: validated.proposal.summary,
          operations: outcomes,
          inputTokens,
          outputTokens,
        },
        dependencies.now(),
      )
    } catch (thrown: unknown) {
      dependencies.log.error('ai run execution threw', {
        runId: run.id,
        workspaceId: run.workspaceId,
        error: describeThrown(thrown),
      })

      try {
        await settleRun(
          dependencies.db,
          run.id,
          {
            status: 'failed',
            // The customer sees this; the real reason is in the log line
            // above for an operator to read.
            failureReason: PROVIDER_FAILURE_MESSAGE,
          },
          dependencies.now(),
        )
      } catch (settleError: unknown) {
        // If the database is down there is nothing sound to write; log and
        // move on. Same shape as core's dispatch engine.
        dependencies.log.error('ai run could not be settled after failure', {
          runId: run.id,
          error: describeThrown(settleError),
        })
      }
    }
  }

  async function drain(workspaceId: string): Promise<void> {
    while ((await countRunningRuns(dependencies.db, workspaceId)) < dependencies.maxConcurrentRuns) {
      const run = await claimOldestQueuedRun(dependencies.db, workspaceId, dependencies.now())

      if (run === undefined) return

      await execute(run)
    }
  }

  return {
    pump(workspaceId) {
      void drain(workspaceId).catch((error: unknown) => {
        dependencies.log.error('ai pump loop failed', {
          workspaceId,
          error: describeThrown(error),
        })
      })
    },
    async pumpAwait(workspaceId) {
      await drain(workspaceId)
    },
  }
}

type ProviderInterpretation =
  | { readonly kind: 'proposal'; readonly proposal: ValidateProposalSuccess }
  | { readonly kind: 'retry'; readonly issues: readonly string[] }
  | { readonly kind: 'fail'; readonly reason: string }

function interpretProviderResult(
  result: AiCompletionResult,
  targetType: AgentTaskTargetType,
  exposeProviderErrors: boolean,
): ProviderInterpretation {
  if (result.stopReason === 'refusal') {
    return {
      kind: 'fail',
      reason: result.failure?.message ?? 'The model declined this task',
    }
  }

  if (result.stopReason === 'failed') {
    const message = result.failure?.message
    return {
      kind: 'fail',
      reason: exposeProviderErrors && message !== undefined ? message : PROVIDER_FAILURE_MESSAGE,
    }
  }

  if (result.stopReason === 'max_tokens') {
    // Truncated JSON is unusable; a repair turn would face the same cap.
    return {
      kind: 'fail',
      reason:
        'The reply was truncated at AI_MAX_TOKENS before it could complete. Raise the cap or narrow the task.',
    }
  }

  // `end_turn`: try to parse.
  let raw: unknown
  try {
    raw = JSON.parse(result.text)
  } catch (thrown: unknown) {
    return {
      kind: 'retry',
      issues: [`The reply was not valid JSON: ${describeThrown(thrown)}`],
    }
  }

  const validated = validateProposal(targetType, raw)
  if (!validated.ok) {
    return { kind: 'retry', issues: validated.issues }
  }

  return { kind: 'proposal', proposal: validated }
}

function indexByName(tools: readonly McpTool[]): ReadonlyMap<string, McpTool> {
  const map = new Map<string, McpTool>()
  for (const tool of tools) {
    map.set(tool.name, tool)
  }
  return map
}

interface ApplyProposalInput {
  readonly proposal: Proposal
  readonly droppedFields: readonly string[]
  readonly droppedOperationKinds: readonly Operation['kind'][]
  readonly run: AiRunRecord
  readonly actor: Actor
  readonly toolsByName: ReadonlyMap<string, McpTool>
  readonly log: Logger
}

async function applyProposal(input: ApplyProposalInput): Promise<readonly OperationOutcome[]> {
  const outcomes: OperationOutcome[] = []

  // Report drops before the applied ones, so the admin log surfaces what
  // Kelpie refused before what it kept.
  for (const kind of input.droppedOperationKinds) {
    outcomes.push({
      kind,
      status: 'skipped',
      detail: `Operation kind not allowed for ${input.run.targetType}`,
    })
  }
  if (input.droppedFields.length > 0) {
    outcomes.push({
      kind: 'update_target',
      status: 'skipped',
      detail: `Fields not on the allowlist and ignored: ${input.droppedFields.join(', ')}`,
    })
  }

  for (const operation of input.proposal.operations) {
    // Every branch calls `applyOne` which returns its own outcome; a thrown
    // error inside one operation is caught there so the rest still run.
    outcomes.push(await applyOne(operation, input))
  }

  // Log the mix so an operator can spot a run that applied nothing.
  const applied = outcomes.filter((outcome) => outcome.status === 'applied').length
  input.log.info('ai run applied operations', {
    runId: input.run.id,
    workspaceId: input.run.workspaceId,
    applied,
    total: input.proposal.operations.length,
  })

  return outcomes
}

async function applyOne(operation: Operation, input: ApplyProposalInput): Promise<OperationOutcome> {
  try {
    switch (operation.kind) {
      case 'update_target':
        return await applyUpdateTarget(operation, input)
      case 'append_note':
        return await applyAppendNote(operation, input)
      case 'pin_note':
        return await applyPinNote(operation, input)
      case 'create_plan':
        return await applyCreatePlan(operation, input)
      case 'create_decision':
        return await applyCreateDecision(operation, input)
      case 'create_position':
        return await applyCreatePosition(operation, input)
    }
  } catch (thrown: unknown) {
    input.log.warn('ai operation failed', {
      runId: input.run.id,
      kind: operation.kind,
      error: describeThrown(thrown),
    })
    return { kind: operation.kind, status: 'failed', detail: describeThrown(thrown) }
  }
}

/** The MCP write tool for an `update_target`. Mirrors `TARGET_READ_TOOL`. */
const TARGET_UPDATE_TOOL: Readonly<Record<AgentTaskTargetType, string | undefined>> = {
  person: 'people_update',
  company: 'companies_update',
  deal: 'deals_update',
  opportunity: 'opportunities_update',
  partnership: 'partnerships_update',
  raise: 'raises_update',
  enquiry: 'enquiries_update',
  event: 'events_update',
  candidate: undefined,
  role: undefined,
  handbook: undefined,
  workspace: undefined,
}

async function applyUpdateTarget(
  operation: UpdateTargetOperation,
  input: ApplyProposalInput,
): Promise<OperationOutcome> {
  const targetType = input.run.targetType as AgentTaskTargetType
  const toolName = TARGET_UPDATE_TOOL[targetType]

  if (toolName === undefined) {
    return {
      kind: 'update_target',
      status: 'skipped',
      detail: `No update tool for target type ${targetType}`,
    }
  }
  const tool = requireTool(input.toolsByName, toolName)
  await tool.invoke({ id: input.run.targetId, ...operation.fields }, input.actor)

  const changed = Object.keys(operation.fields).join(', ')
  return { kind: 'update_target', status: 'applied', detail: `Fields: ${changed}` }
}

async function applyAppendNote(
  operation: AppendNoteOperation,
  input: ApplyProposalInput,
): Promise<OperationOutcome> {
  const tool = requireTool(input.toolsByName, 'notes_create')
  const result = await tool.invoke(
    {
      target_type: input.run.targetType,
      target_id: input.run.targetId,
      body: operation.body,
      pinned: operation.pinned,
    },
    input.actor,
  )
  return {
    kind: 'append_note',
    status: 'applied',
    detail: detailWithId('note', result),
  }
}

async function applyPinNote(
  operation: PinNoteOperation,
  input: ApplyProposalInput,
): Promise<OperationOutcome> {
  const tool = requireTool(input.toolsByName, 'notes_update')
  await tool.invoke({ id: operation.note_id, pinned: true }, input.actor)
  return { kind: 'pin_note', status: 'applied', detail: `Pinned note ${operation.note_id}` }
}

async function applyCreatePlan(
  operation: CreatePlanOperation,
  input: ApplyProposalInput,
): Promise<OperationOutcome> {
  const tool = requireTool(input.toolsByName, 'plan_items_create')
  const result = await tool.invoke(
    {
      target_type: input.run.targetType,
      target_id: input.run.targetId,
      title: operation.title,
      date: operation.date,
    },
    input.actor,
  )
  return { kind: 'create_plan', status: 'applied', detail: detailWithId('plan_item', result) }
}

async function applyCreateDecision(
  operation: CreateDecisionOperation,
  input: ApplyProposalInput,
): Promise<OperationOutcome> {
  const tool = requireTool(input.toolsByName, 'decisions_create')
  const result = await tool.invoke(
    {
      target_type: input.run.targetType,
      target_id: input.run.targetId,
      body: operation.body,
      rationale: operation.rationale,
      due_at: operation.due_at,
    },
    input.actor,
  )
  return { kind: 'create_decision', status: 'applied', detail: detailWithId('decision', result) }
}

async function applyCreatePosition(
  operation: CreatePositionOperation,
  input: ApplyProposalInput,
): Promise<OperationOutcome> {
  const tool = requireTool(input.toolsByName, 'positions_create')
  // Positions link a person and a company. Only person and candidate targets
  // reach here (per OPERATIONS_BY_TARGET); candidate is not directly a
  // person, so callers on a candidate target ought to use its Person.
  // Kelpie always uses the run target as the person for a person target
  // and refuses otherwise, so the model cannot use the operation to link
  // an arbitrary third-party pair.
  if (input.run.targetType !== 'person') {
    return {
      kind: 'create_position',
      status: 'skipped',
      detail: 'Positions can only be created from a person target in this flow',
    }
  }
  const result = await tool.invoke(
    {
      person_id: input.run.targetId,
      company_id: operation.company_id,
      title: operation.title,
    },
    input.actor,
  )
  return { kind: 'create_position', status: 'applied', detail: detailWithId('position', result) }
}

/** Extract the created record's id from an MCP tool return, best-effort. */
function detailWithId(label: string, result: unknown): string {
  if (result !== null && typeof result === 'object' && 'id' in result) {
    const id = (result as { id: unknown }).id
    if (typeof id === 'string') {
      return `Created ${label} ${id}`
    }
  }
  return `Created ${label}`
}

function requireTool(index: ReadonlyMap<string, McpTool>, name: string): McpTool {
  const tool = index.get(name)
  if (tool === undefined) {
    throw new Error(`MCP tool "${name}" is not registered in this deployment`)
  }
  return tool
}

