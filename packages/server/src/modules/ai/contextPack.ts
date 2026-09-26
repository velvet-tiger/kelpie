import type { AgentTaskTargetType } from '@kelpie/schemas'
import type { Actor } from '../auth/actor.ts'
import type { McpTool } from '../../runtime/module.ts'

import type { AiRunContext } from './repository.ts'
import {
  CONTEXT_PACK_DECISION_LIMIT,
  CONTEXT_PACK_PINNED_NOTE_LIMIT,
  CONTEXT_PACK_PLAN_ITEM_LIMIT,
  CONTEXT_PACK_RELATED_LIMIT,
} from './rules.ts'

/**
 * Builds the context pack the executor hands to the model.
 *
 * Kelpie reads the data itself — via the same in-process MCP tool registry
 * the executor uses for writes — and renders a compact markdown block. The
 * model receives that block and returns operations; it never asks for a
 * record and never opens a tool.
 *
 * Each read is best-effort. A missing pinned note or a renamed handbook
 * slug is noted in the pack rather than failing the run: the model can
 * still work with what did load, and the failure is visible. The one
 * exception is the target: if the target read fails the run cannot make
 * sense, so it fails with the tool's error message.
 */

/**
 * The map from a `target_type` to the MCP read tool that returns the record.
 *
 * Workspace targets use the dashboard snapshot rather than a per-record read
 * because the workspace tasks point at the dashboard exactly for this shape:
 * one call, curated signals, no per-record joins.
 */
const TARGET_READ_TOOL: Readonly<Record<AgentTaskTargetType, string>> = {
  person: 'people_get',
  company: 'companies_get',
  deal: 'deals_get',
  opportunity: 'opportunities_get',
  partnership: 'partnerships_get',
  raise: 'raises_get',
  enquiry: 'enquiries_get',
  event: 'events_get',
  candidate: 'candidates_get',
  role: 'roles_get',
  handbook: 'handbook_pages_get',
  workspace: 'dashboard_get',
}

/**
 * The MCP tools the pack builder reaches for. Each is optional — a
 * deployment that omits a module (say, hiring) still boots and its target
 * types are simply unreachable.
 */
interface ReadTools {
  readonly target: McpTool | undefined
  readonly notesGet: McpTool | undefined
  readonly planItemsGet: McpTool | undefined
  readonly decisionsGet: McpTool | undefined
  readonly handbookList: McpTool | undefined
}

export interface ContextPackDependencies {
  readonly toolsByName: ReadonlyMap<string, McpTool>
}

export interface BuildContextPackInput {
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
  readonly context: AiRunContext | null
  readonly actor: Actor
}

/** The rendered pack plus what could not be loaded. */
export interface ContextPackResult {
  readonly markdown: string
  /** Human-readable lines the executor can surface if the run struggles. */
  readonly warnings: readonly string[]
}

export class ContextPackTargetError extends Error {
  readonly toolName: string

  constructor(message: string, toolName: string) {
    super(message)
    this.name = 'ContextPackTargetError'
    this.toolName = toolName
  }
}

export async function buildContextPack(
  dependencies: ContextPackDependencies,
  input: BuildContextPackInput,
): Promise<ContextPackResult> {
  const toolNames = TARGET_READ_TOOL
  const targetToolName = toolNames[input.targetType]
  const tools: ReadTools = {
    target: dependencies.toolsByName.get(targetToolName),
    notesGet: dependencies.toolsByName.get('notes_get'),
    planItemsGet: dependencies.toolsByName.get('plan_items_get'),
    decisionsGet: dependencies.toolsByName.get('decisions_get'),
    handbookList: dependencies.toolsByName.get('handbook_pages_list'),
  }

  if (tools.target === undefined) {
    throw new ContextPackTargetError(
      `No MCP tool named "${targetToolName}" is registered for target type "${input.targetType}"`,
      targetToolName,
    )
  }

  const warnings: string[] = []
  const target = await invokeTargetRead(tools.target, input.targetType, input.targetId, input.actor)

  const context = input.context ?? {}

  const pinnedNoteIds = capIds(context.pinned_note_ids, CONTEXT_PACK_PINNED_NOTE_LIMIT)
  const openPlanIds = capIds(context.open_plan_ids, CONTEXT_PACK_PLAN_ITEM_LIMIT)
  const openDecisionIds = capIds(context.open_decision_ids, CONTEXT_PACK_DECISION_LIMIT)
  const handbookSlugs = context.handbook_slugs ?? []
  const related = context.related ?? {}

  const [pinnedNotes, openPlans, openDecisions, handbookPages, relatedRecords] =
    await Promise.all([
      collectRecords(tools.notesGet, pinnedNoteIds, input.actor, warnings, 'note'),
      collectRecords(tools.planItemsGet, openPlanIds, input.actor, warnings, 'plan_item'),
      collectRecords(tools.decisionsGet, openDecisionIds, input.actor, warnings, 'decision'),
      collectHandbookPages(tools.handbookList, handbookSlugs, input.actor, warnings),
      collectRelated(dependencies.toolsByName, related, input.actor, warnings),
    ])

  const markdown = renderPack({
    targetType: input.targetType,
    targetId: input.targetId,
    targetLabel: context.target_label,
    deepLink: context.deep_link,
    target,
    pinnedNotes,
    openPlans,
    openDecisions,
    handbookPages,
    relatedRecords,
    warnings,
  })

  return { markdown, warnings }
}

async function invokeTargetRead(
  tool: McpTool,
  targetType: AgentTaskTargetType,
  targetId: string,
  actor: Actor,
): Promise<unknown> {
  try {
    if (targetType === 'workspace') {
      // `dashboard_get` takes only an optional `limit`; call with defaults.
      return await tool.invoke({}, actor)
    }
    return await tool.invoke({ id: targetId }, actor)
  } catch (thrown: unknown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    throw new ContextPackTargetError(
      `Could not read the target ${targetType} ${targetId}: ${message}`,
      tool.name,
    )
  }
}

async function collectRecords(
  tool: McpTool | undefined,
  ids: readonly string[],
  actor: Actor,
  warnings: string[],
  label: string,
): Promise<readonly unknown[]> {
  if (tool === undefined || ids.length === 0) {
    return []
  }

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return await tool.invoke({ id }, actor)
      } catch (thrown: unknown) {
        warnings.push(
          `Could not load ${label} ${id}: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        )
        return undefined
      }
    }),
  )

  return results.filter((record): record is unknown => record !== undefined)
}

async function collectHandbookPages(
  tool: McpTool | undefined,
  slugs: readonly string[],
  actor: Actor,
  warnings: string[],
): Promise<readonly unknown[]> {
  if (tool === undefined || slugs.length === 0) {
    return []
  }

  try {
    // `handbook_pages_list` accepts `slug` as a repeated filter; passing the
    // array selects every named page in one call.
    const result = await tool.invoke({ slug: slugs, limit: slugs.length }, actor)
    if (result !== null && typeof result === 'object' && 'data' in result) {
      const data = (result as { data: unknown }).data
      if (Array.isArray(data)) {
        return data
      }
    }
    return []
  } catch (thrown: unknown) {
    warnings.push(
      `Could not load handbook pages: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    )
    return []
  }
}

async function collectRelated(
  toolsByName: ReadonlyMap<string, McpTool>,
  related: Readonly<Record<string, readonly string[]>>,
  actor: Actor,
  warnings: string[],
): Promise<Readonly<Record<string, readonly unknown[]>>> {
  const collected: Record<string, unknown[]> = {}

  await Promise.all(
    Object.entries(related).map(async ([bucketKey, ids]) => {
      const toolName = relatedBucketToolName(bucketKey)
      if (toolName === undefined) {
        return
      }
      const tool = toolsByName.get(toolName)
      if (tool === undefined) {
        return
      }
      const capped = capIds(ids, CONTEXT_PACK_RELATED_LIMIT)
      const records = await collectRecords(tool, capped, actor, warnings, bucketKey)
      if (records.length > 0) {
        collected[bucketKey] = [...records]
      }
    }),
  )

  return collected
}

/**
 * Core's dispatch uses `<singular>_ids` bucket keys (`person_ids`,
 * `company_ids`, `deal_ids`, and so on). Map each to the MCP read tool
 * that fetches one of them.
 */
function relatedBucketToolName(bucketKey: string): string | undefined {
  const singularToTool: Readonly<Record<string, string>> = {
    person_ids: 'people_get',
    company_ids: 'companies_get',
    deal_ids: 'deals_get',
    opportunity_ids: 'opportunities_get',
    partnership_ids: 'partnerships_get',
    raise_ids: 'raises_get',
    candidate_ids: 'candidates_get',
    role_ids: 'roles_get',
    position_ids: 'positions_get',
    note_ids: 'notes_get',
    plan_item_ids: 'plan_items_get',
    decision_ids: 'decisions_get',
  }

  return singularToTool[bucketKey]
}

function capIds(ids: readonly string[] | undefined, cap: number): readonly string[] {
  if (ids === undefined) {
    return []
  }
  return ids.slice(0, cap)
}

interface PackParts {
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
  readonly targetLabel: string | undefined
  readonly deepLink: string | undefined
  readonly target: unknown
  readonly pinnedNotes: readonly unknown[]
  readonly openPlans: readonly unknown[]
  readonly openDecisions: readonly unknown[]
  readonly handbookPages: readonly unknown[]
  readonly relatedRecords: Readonly<Record<string, readonly unknown[]>>
  readonly warnings: readonly string[]
}

/**
 * Renders the pack as one markdown block: a header per section, each
 * section a JSON array under a fenced code block. JSON is easier for the
 * model to parse than a bespoke text format and keeps the caller free from
 * knowing every record's shape.
 */
function renderPack(parts: PackParts): string {
  const lines: string[] = []

  lines.push('# Context pack')
  lines.push('')
  lines.push(
    'Kelpie loaded the following records for this run. The model must not ask for more; ' +
      'if something needed is missing, work with what is here or say so in the summary.',
  )
  lines.push('')

  const targetHeader =
    parts.targetLabel === undefined
      ? `## Target: ${parts.targetType} (${parts.targetId})`
      : `## Target: ${parts.targetLabel} — ${parts.targetType} (${parts.targetId})`
  lines.push(targetHeader)
  if (parts.deepLink !== undefined) {
    lines.push(`Deep link: ${parts.deepLink}`)
  }
  lines.push(jsonBlock(parts.target))

  if (parts.pinnedNotes.length > 0) {
    lines.push('## Pinned notes')
    lines.push(jsonBlock(parts.pinnedNotes))
  }
  if (parts.openPlans.length > 0) {
    lines.push('## Open plan items')
    lines.push(jsonBlock(parts.openPlans))
  }
  if (parts.openDecisions.length > 0) {
    lines.push('## Open decisions')
    lines.push(jsonBlock(parts.openDecisions))
  }
  if (parts.handbookPages.length > 0) {
    lines.push('## Handbook pages')
    lines.push(jsonBlock(parts.handbookPages))
  }
  for (const [bucket, records] of Object.entries(parts.relatedRecords)) {
    lines.push(`## Related: ${bucket}`)
    lines.push(jsonBlock(records))
  }

  if (parts.warnings.length > 0) {
    lines.push('## Warnings')
    for (const warning of parts.warnings) {
      lines.push(`- ${warning}`)
    }
  }

  return lines.join('\n')
}

function jsonBlock(value: unknown): string {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`
}
