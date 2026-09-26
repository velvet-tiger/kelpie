import type { AgentTaskTargetType } from '@kelpie/schemas'

import {
  OPERATIONS_BY_TARGET,
  UPDATE_FIELD_ALLOWLIST,
} from './proposal.ts'
import type { OperationKind } from './proposal.ts'

/**
 * The prompt wrapper.
 *
 * Core produces the general request (`renderBasePrompt` in
 * `@kelpie/server`) and dispatches it as the `base_prompt` field. This
 * module wraps the base with system-level instructions that tell the model
 * to return one JSON reply in the operation vocabulary; Kelpie applies each
 * operation on its behalf.
 *
 * The wrapper is deliberately minimal. It no longer has to override
 * language the base does not contain — the "operating via MCP/API" opening
 * and the "Done when… applied allowed updates" tail belong to the
 * external-agent prompt, which never reaches the model in the hosted flow.
 */

/** Renders the system-level instructions handed to the provider. */
export function renderInstructions(targetType: AgentTaskTargetType): string {
  const kinds = OPERATIONS_BY_TARGET[targetType]
  const fields = UPDATE_FIELD_ALLOWLIST[targetType]

  const lines: string[] = []

  lines.push(
    'You are the Kelpie hosted AI. You have no tools. Every change you want to make must ' +
      'be expressed as an operation in the JSON object you return; Kelpie applies each ' +
      'operation on your behalf, validates it against the workspace, and records the outcome.',
  )
  lines.push('')
  lines.push('Kelpie has loaded the target and its neighbours into the context pack below the ' +
    'task briefing. Do not attempt any reads of your own. You are done when you return a ' +
    'valid JSON reply.')
  lines.push('')
  lines.push('Rules:')
  lines.push('- Return one JSON object with `summary` (a short string, what you did and why) ' +
    'and `operations` (an array). Nothing else.')
  lines.push('- Use only the operation kinds listed for this target below.')
  lines.push('- In `update_target`, use only the field names listed for this target below. ' +
    'Any other field is ignored.')
  lines.push('- Prefer `append_note` when you are unsure. A high-signal note is better than ' +
    'a guessed field.')
  lines.push('- Do not invent ids. Refer to a note or company only by an id that appears in ' +
    'the context pack.')
  lines.push('- Do not propose pipeline stage moves, deletes, or messages to send. The schema ' +
    'has no way to express them.')
  lines.push('')
  lines.push(`Allowed operation kinds for this ${targetType}: ${describeKinds(kinds)}`)
  lines.push(`Allowed \`update_target.fields\` keys for this ${targetType}: ${describeFields(fields)}`)

  return lines.join('\n')
}

/**
 * Builds the user message the model sees on the first turn: the core-rendered
 * task briefing, then the context pack.
 */
export function renderUserMessage(taskPrompt: string, contextPackMarkdown: string): string {
  return `${taskPrompt}\n\n---\n\n${contextPackMarkdown}`
}

/**
 * Builds the repair message for the second turn when the first reply did not
 * parse. Names the issues so the model can correct itself without a new
 * task briefing.
 */
export function renderRepairMessage(issues: readonly string[]): string {
  const bulletList = issues.map((issue) => `- ${issue}`).join('\n')
  return (
    'Your previous reply did not match the required JSON shape. ' +
    'Return one JSON object with `summary` and `operations` and fix these issues:\n' +
    bulletList
  )
}

function describeKinds(kinds: readonly OperationKind[]): string {
  return kinds.length === 0 ? '(none — return only a summary)' : kinds.join(', ')
}

function describeFields(fields: readonly string[]): string {
  return fields.length === 0
    ? '(none — do not include `update_target`)'
    : fields.join(', ')
}
