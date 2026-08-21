import { z } from 'zod'

import {
  AGENT_RUN_STATUSES,
  AGENT_TASK_PLACEMENTS,
  AGENT_TASK_TARGET_TYPES,
} from './values.ts'
import type { AgentRunStatus, AgentTaskPlacement, AgentTaskTargetType } from './values.ts'
import {
  definedFields,
  idSchema,
  nullableTimestampSchema,
  recordTimestamps,
} from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Agent tasks (`agent-tasks.md`): prompt recipes over the workspace's own data.
 *
 * The task catalog ships in code, so a TaskDefinition has no timestamps and no
 * body builder — it is read-only on the wire. A ResolvedTask is the one payload
 * both triggers share: Copy puts `prompt` on the clipboard, Run POSTs the whole
 * thing to a registered agent.
 */

/** A catalog entry. `id` is a stable string like `company.enrich`, not a ULID. */
export interface AgentTaskDefinition {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly targetTypes: readonly AgentTaskTargetType[]
  readonly placement: AgentTaskPlacement
  readonly handbookSlugs: readonly string[]
  readonly instructions: string
  readonly writePolicy: string
}

export const agentTaskDefinitionSchema: z.ZodType<AgentTaskDefinition, unknown> = z
  .object({
    id: idSchema,
    label: z.string(),
    description: z.string(),
    target_types: z.array(z.enum(AGENT_TASK_TARGET_TYPES)),
    placement: z.enum(AGENT_TASK_PLACEMENTS),
    handbook_slugs: z.array(z.string()),
    instructions: z.string(),
    write_policy: z.string(),
  })
  .transform(
    (wire): AgentTaskDefinition => ({
      id: wire.id,
      label: wire.label,
      description: wire.description,
      targetTypes: wire.target_types,
      placement: wire.placement,
      handbookSlugs: wire.handbook_slugs,
      instructions: wire.instructions,
      writePolicy: wire.write_policy,
    }),
  )

/**
 * The structured snapshot resolve assembled. `related` keys are id-list names
 * such as `person_ids`; which keys appear depends on the target type.
 */
export interface AgentTaskContextPack {
  readonly targetLabel: string
  readonly deepLink: string
  readonly handbookSlugs: readonly string[]
  readonly pinnedNoteIds: readonly string[]
  readonly openPlanIds: readonly string[]
  readonly openDecisionIds: readonly string[]
  readonly related: Readonly<Record<string, readonly string[]>>
}

const contextPackSchema: z.ZodType<AgentTaskContextPack, unknown> = z
  .object({
    target_label: z.string(),
    deep_link: z.string(),
    handbook_slugs: z.array(z.string()),
    pinned_note_ids: z.array(idSchema),
    open_plan_ids: z.array(idSchema),
    open_decision_ids: z.array(idSchema),
    related: z.record(z.string(), z.array(idSchema)),
  })
  .transform(
    (wire): AgentTaskContextPack => ({
      targetLabel: wire.target_label,
      deepLink: wire.deep_link,
      handbookSlugs: wire.handbook_slugs,
      pinnedNoteIds: wire.pinned_note_ids,
      openPlanIds: wire.open_plan_ids,
      openDecisionIds: wire.open_decision_ids,
      related: wire.related,
    }),
  )

/**
 * What resolve answers, and what a run dispatches. Two prompts, one body.
 *
 *   - `prompt` — the external-agent-framed prompt: opens with "operating via
 *     MCP / the public API" and closes with "Done when… applied allowed
 *     updates". What Copy hands to the user and what dispatch sends by
 *     default. An agent that runs its own tool loop reads this and works
 *     from it directly.
 *   - `basePrompt` — the shared body, without the framing. An agent that
 *     returns structured data for a caller to apply (the hosted AI in the
 *     cloud is the one that ships) reads this and adds its own instructions
 *     for how to reply.
 *
 * The wire also carries the base as `base_prompt` alongside `prompt`; a
 * receiver picks the one that matches how it will execute.
 */
export interface ResolvedAgentTask {
  readonly taskId: string
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
  readonly prompt: string
  readonly basePrompt: string
  readonly context: AgentTaskContextPack
}

export const resolvedAgentTaskSchema: z.ZodType<ResolvedAgentTask, unknown> = z
  .object({
    task_id: idSchema,
    target_type: z.enum(AGENT_TASK_TARGET_TYPES),
    target_id: idSchema,
    prompt: z.string(),
    // Older core versions did not send this; treat it as optional on parse
    // and fall back to `prompt` so a client built against the new schema
    // still works against an older server.
    base_prompt: z.string().optional(),
    context: contextPackSchema,
  })
  .transform(
    (wire): ResolvedAgentTask => ({
      taskId: wire.task_id,
      targetType: wire.target_type,
      targetId: wire.target_id,
      prompt: wire.prompt,
      basePrompt: wire.base_prompt ?? wire.prompt,
      context: wire.context,
    }),
  )

export interface ResolveAgentTaskInput {
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
}

export function resolveAgentTaskBody(input: ResolveAgentTaskInput): Record<string, unknown> {
  return {
    target_type: input.targetType,
    target_id: input.targetId,
  }
}

export interface RunAgentTaskInput extends ResolveAgentTaskInput {
  readonly agentId: string
}

export function runAgentTaskBody(input: RunAgentTaskInput): Record<string, unknown> {
  return {
    ...resolveAgentTaskBody(input),
    agent_id: input.agentId,
  }
}

/**
 * A bring-your-own agent endpoint. The auth header is sealed server-side and
 * never returned; `hasAuthHeader` is all a reader learns about it.
 */
export interface RegisteredAgent extends RecordTimestamps {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly hasAuthHeader: boolean
  readonly lastRunAt: Date | null
}

export const registeredAgentSchema: z.ZodType<RegisteredAgent, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    endpoint: z.string(),
    has_auth_header: z.boolean(),
    last_run_at: nullableTimestampSchema,
    ...recordTimestamps,
  })
  .transform(
    (wire): RegisteredAgent => ({
      id: wire.id,
      name: wire.name,
      endpoint: wire.endpoint,
      hasAuthHeader: wire.has_auth_header,
      lastRunAt: wire.last_run_at,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreateRegisteredAgentInput {
  readonly name: string
  readonly endpoint: string
  /** Sent as the `Authorization` header on every dispatch to this agent. */
  readonly authHeader?: string
}

export function createRegisteredAgentBody(
  input: CreateRegisteredAgentInput,
): Record<string, unknown> {
  return definedFields({
    name: input.name,
    endpoint: input.endpoint,
    auth_header: input.authHeader,
  })
}

export interface RegisteredAgentInput {
  readonly name?: string
  readonly endpoint?: string
  /** A string replaces the stored header; `null` clears it. */
  readonly authHeader?: string | null
}

export function registeredAgentBody(input: RegisteredAgentInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    endpoint: input.endpoint,
    auth_header: input.authHeader,
  })
}

/**
 * One dispatch of a ResolvedTask to a registered agent. `failureReason` is set
 * only on `failed`, and says what the dispatch hit — a status, a timeout, a
 * refused connection.
 */
export interface AgentRun extends RecordTimestamps {
  readonly id: string
  readonly agentId: string
  readonly taskId: string
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
  readonly status: AgentRunStatus
  readonly prompt: string
  readonly failureReason: string | null
}

export const agentRunSchema: z.ZodType<AgentRun, unknown> = z
  .object({
    id: idSchema,
    agent_id: idSchema,
    task_id: idSchema,
    target_type: z.enum(AGENT_TASK_TARGET_TYPES),
    target_id: idSchema,
    status: z.enum(AGENT_RUN_STATUSES),
    prompt: z.string(),
    failure_reason: z.string().nullable(),
    ...recordTimestamps,
  })
  .transform(
    (wire): AgentRun => ({
      id: wire.id,
      agentId: wire.agent_id,
      taskId: wire.task_id,
      targetType: wire.target_type,
      targetId: wire.target_id,
      status: wire.status,
      prompt: wire.prompt,
      failureReason: wire.failure_reason,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )
