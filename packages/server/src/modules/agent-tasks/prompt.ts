import type { AgentTaskDefinition, AgentTaskTargetType } from '@kelpie/schemas'

/**
 * Renders the markdown prompt a ResolvedTask carries. Pure: every fact arrives
 * as an argument, so the template is unit-testable and Copy and Run cannot
 * drift — both read the strings this file produces.
 *
 * Two renderers, one shared body.
 *
 *   - {@link renderBasePrompt} returns the general request: the task title,
 *     the target, the required reads, the handbook pages, related ids,
 *     workspace signals, the task instructions, and the write policy. It
 *     says nothing about *how* the receiver should apply the changes.
 *   - {@link renderExternalAgentPrompt} wraps the base with framing for an
 *     agent that calls the CRM itself — the opening line about MCP / the
 *     public API and the closing "Done when… applied allowed updates" tail.
 *
 * The resolved-task and dispatch payloads carry both. The copy-prompt UI
 * flow serves the external-agent version by default; the hosted AI in the
 * cloud reads the base and adds its own structured-output framing. Two
 * consumers, two wrappers, one body.
 */

/** A handbook page the task requires, resolved to this workspace's own copy. */
export interface HandbookPageReference {
  readonly slug: string
  readonly title: string
  readonly deepLink: string
}

/** One id list under "Related ids". `truncated` keeps a capped list honest. */
export interface RelatedIdList {
  readonly ids: readonly string[]
  readonly truncated: boolean
}

/** One sweep bucket under "Workspace signals". `total` is exact; `ids` are capped. */
export interface WorkspaceSignal {
  readonly label: string
  readonly total: number
  readonly ids: readonly string[]
}

export interface PromptInputs {
  readonly workspaceName: string
  readonly targetLabel: string
  readonly deepLink: string
  readonly handbookPages: readonly HandbookPageReference[]
  readonly pinnedNoteIds: readonly string[]
  readonly openPlanIds: readonly string[]
  readonly openDecisionIds: readonly string[]
  readonly related: Readonly<Record<string, RelatedIdList>>
  readonly signals: readonly WorkspaceSignal[]
}

function codeList(ids: readonly string[], empty: string): string {
  return ids.length > 0 ? ids.map((id) => `\`${id}\``).join(', ') : empty
}

function handbookLines(pages: readonly HandbookPageReference[]): string {
  if (pages.length === 0) {
    return '- (none)'
  }

  return pages.map((page) => `- \`${page.slug}\` — ${page.title} (\`${page.deepLink}\`)`).join('\n')
}

function relatedSection(related: Readonly<Record<string, RelatedIdList>>): string {
  const lines = Object.entries(related)
    .filter(([, list]) => list.ids.length > 0)
    .map(([key, list]) => {
      const suffix = list.truncated ? ` (first ${String(list.ids.length)}; more exist)` : ''

      return `- ${key}${suffix}: ${list.ids.join(', ')}`
    })

  return lines.length > 0 ? `\n## Related ids\n${lines.join('\n')}\n` : ''
}

function signalsSection(signals: readonly WorkspaceSignal[]): string {
  if (signals.length === 0) {
    return ''
  }

  const lines = signals.map((signal) => {
    if (signal.total === 0) {
      return `- ${signal.label}: none`
    }

    const shown = signal.ids.join(', ')
    const suffix = signal.total > signal.ids.length ? ` (first ${String(signal.ids.length)})` : ''

    return `- ${signal.label}: ${String(signal.total)} total — ${shown}${suffix}`
  })

  return `\n## Workspace signals\n${lines.join('\n')}\n`
}

/**
 * The first required read. A workspace task has no single record to load; the
 * dashboard is the workspace's own context pack, and pointing the agent at the
 * endpoint keeps the signals live rather than frozen at resolve time.
 */
function firstRead(targetType: AgentTaskTargetType): string {
  if (targetType === 'workspace') {
    return 'Load the workspace dashboard: `GET /v1/dashboard` (MCP: `dashboard_get`). It carries open pipeline counts, overdue and due-soon Plan items, upcoming partnership touchpoints, stale contacts, and recent activity.'
  }

  return 'Load the target record and agent fields.'
}

/**
 * The shared body. Renders everything a receiver needs to *understand* the
 * task, without telling it how to apply results. Callers wrap this with an
 * opening and closing that matches how the receiver will execute (call the
 * CRM, or return structured data for a caller to apply).
 */
export function renderBasePrompt(
  definition: AgentTaskDefinition,
  targetType: AgentTaskTargetType,
  targetId: string,
  inputs: PromptInputs,
): string {
  return `# Agent task: ${definition.label}

## Task
- **Id:** \`${definition.id}\`
- **Intent:** ${definition.description}

## Target
- **Type:** \`${targetType}\`
- **Id:** \`${targetId}\`
- **Label:** ${inputs.targetLabel}
- **UI:** ${inputs.deepLink}

## Required reads
1. ${firstRead(targetType)}
2. Prefer pinned notes: ${codeList(inputs.pinnedNoteIds, '(none pinned)')}.
3. Open Plan items: ${codeList(inputs.openPlanIds, '(none)')}.
4. Open Decisions: ${codeList(inputs.openDecisionIds, '(none)')}.
5. Handbook pages:
${handbookLines(inputs.handbookPages)}
${relatedSection(inputs.related)}${signalsSection(inputs.signals)}
## Instructions
${definition.instructions}

## Write policy
${definition.writePolicy}
`
}

/**
 * The external-agent-framed prompt. Adds the opening line about MCP / the
 * public API and the closing "Done when" tail to the base. This is what the
 * Copy button hands to the user and what dispatch sends by default; an
 * agent that runs its own tool loop against the CRM reads this and works
 * from it directly.
 */
export function renderExternalAgentPrompt(
  definition: AgentTaskDefinition,
  targetType: AgentTaskTargetType,
  targetId: string,
  inputs: PromptInputs,
): string {
  const opening = `# Agent task: ${definition.label}

You are operating on the Kelpie workspace **${inputs.workspaceName}** via MCP / the public API.
Bring your own model. Kelpie does not bundle AI.
`

  // The base opens with its own `# Agent task:` header; strip it so the
  // combined prompt has one heading rather than two.
  const base = renderBasePrompt(definition, targetType, targetId, inputs)
  const bodyWithoutHeading = base.replace(/^# Agent task:[^\n]*\n\n?/u, '')

  return `${opening}
${bodyWithoutHeading}
## Done when
You have applied allowed updates via MCP/API (or asked the human when blocked), and summarised what changed.
`
}

/**
 * Backwards-compatible alias for the pre-split renderer. Existing callers
 * that produced the "wrapped" prompt keep working. New callers pick
 * {@link renderBasePrompt} or {@link renderExternalAgentPrompt} directly.
 */
export const renderPrompt = renderExternalAgentPrompt
