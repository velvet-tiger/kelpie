import type { AgentTaskDefinition, AgentTaskTargetType, ApiKeyGranularScope } from '@kelpie/schemas'

/**
 * The scopes a bearer credential needs to resolve a task and to start a run,
 * beyond the `agent_tasks:write` its route needs.
 *
 * `agent_tasks:write` alone must not read a record or cause a write to one. A
 * resolve answers the name of its target, so it needs the read scope of the
 * target. A run makes an agent write for the caller, so the caller needs the
 * write scopes of what that run may write. A session and a full-access key
 * hold every scope, so nothing changes for them.
 */

/** What a caller must be able to read to learn the name of a target. */
const TARGET_READ_SCOPES: Readonly<Record<AgentTaskTargetType, ApiKeyGranularScope>> = {
  person: 'people:read',
  company: 'companies:read',
  deal: 'deals:read',
  opportunity: 'opportunities:read',
  partnership: 'partnerships:read',
  raise: 'raises:read',
  enquiry: 'enquiries:read',
  event: 'events:read',
  candidate: 'candidates:read',
  role: 'roles:read',
  handbook: 'handbook:read',
  // A workspace task sends the agent to the dashboard and lists record ids
  // from it. `workspace:read` is for members and invitations, which a resolve
  // does not answer.
  workspace: 'dashboard:read',
}

/**
 * What a run may write on each target type, apart from a Decision.
 *
 * This is the list of writes the hosted AI applies (`modules/ai`), stated as
 * scopes: a note on every target, the target's own fields where it has an
 * update, a Plan item on a pipeline record or an event, a Position from a
 * person or a candidate. A test in `modules/ai` fails when the two lists
 * disagree. Core cannot read the list from that module, which is optional.
 */
const RUN_WRITE_SCOPES: Readonly<Record<AgentTaskTargetType, readonly ApiKeyGranularScope[]>> = {
  person: ['notes:write', 'people:write', 'positions:write'],
  company: ['notes:write', 'companies:write'],
  deal: ['notes:write', 'deals:write', 'plan_items:write'],
  opportunity: ['notes:write', 'opportunities:write', 'plan_items:write'],
  partnership: ['notes:write', 'partnerships:write', 'plan_items:write'],
  raise: ['notes:write', 'raises:write', 'plan_items:write'],
  enquiry: ['notes:write', 'enquiries:write', 'plan_items:write'],
  event: ['notes:write', 'events:write', 'plan_items:write'],
  candidate: ['notes:write', 'positions:write'],
  role: ['notes:write'],
  handbook: ['notes:write'],
  workspace: ['notes:write'],
}

/** The scope a resolve of this target type needs. */
export function targetReadScope(targetType: AgentTaskTargetType): ApiKeyGranularScope {
  return TARGET_READ_SCOPES[targetType]
}

/**
 * The scopes a run of this task on this target type needs: the read scope of
 * the target, then the write scopes of everything the run may write. A task
 * that may create a Decision needs `decisions:write` too.
 */
export function runScopes(
  definition: Pick<AgentTaskDefinition, 'mayCreateDecision'>,
  targetType: AgentTaskTargetType,
): readonly ApiKeyGranularScope[] {
  return [
    TARGET_READ_SCOPES[targetType],
    ...RUN_WRITE_SCOPES[targetType],
    ...(definition.mayCreateDecision ? (['decisions:write'] as const) : []),
  ]
}
