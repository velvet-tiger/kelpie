import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import type { PersonIntake } from './intake.ts'
import { applyBody, identifyBody, researchBody } from './intakeRoutes.ts'

/**
 * `person_intake_*`, mirroring `/v1/ai/person-intake/*`. Each tool takes the
 * route's body schema and answers the route's body, so the two cannot answer
 * differently. Each tool calls the same `PersonIntake` service as its route,
 * with the caller's own actor.
 *
 * A start answers at once with `{ run_id }` and costs the workspace one AI run.
 * The caller reads the run with `person_intake_run_get` until it settles.
 */

const runIdArg = z.string().describe('The run id that identify or research returned, like ai_….')

export function registerPersonIntakeTools(mcp: McpToolRegistry, intake: PersonIntake): void {
  mcp.tool({
    name: 'person_intake_identify',
    description:
      'Start an identify run from pasted notes about a person. Kelpie AI names the person and ' +
      'proposes candidates, with web search when the workspace allows it. Returns { run_id } at ' +
      'once. Read the run with person_intake_run_get until it succeeds. Each start costs the ' +
      'workspace one AI run. Mirrors POST /v1/ai/person-intake/identify.',
    scope: 'ai:write',
    inputSchema: identifyBody,
    invoke: (args, actor) => intake.identify(actor, args.text),
  })

  mcp.tool({
    name: 'person_intake_research',
    description:
      'Start a research run for one candidate from identify. Kelpie AI proposes the records to ' +
      'create or link. Pass existing_person_id to research a Person already in the CRM. Returns ' +
      '{ run_id } at once. Read the run with person_intake_run_get. Each start costs the workspace ' +
      'one AI run. Mirrors POST /v1/ai/person-intake/research.',
    scope: 'ai:write',
    inputSchema: researchBody,
    invoke: (args, actor) =>
      intake.research(actor, {
        text: args.text,
        candidate: args.candidate,
        existingPersonId: args.existing_person_id,
      }),
  })

  mcp.tool({
    name: 'person_intake_run_get',
    description:
      'Read an identify or research run. Status is queued, running, succeeded or failed. The ' +
      'result is kept for one hour after the run succeeds. Only the caller who started the run ' +
      'can read it. Mirrors GET /v1/ai/person-intake/runs/{id}.',
    scope: 'ai:write',
    inputSchema: z.strictObject({ id: runIdArg }),
    invoke: (args, actor) => intake.readRun(actor, args.id),
  })

  mcp.tool({
    name: 'person_intake_apply',
    description:
      'Write the items a member chose from an identify or research result, as the caller. Each ' +
      'item goes through the same checks as the CRUD tools. The answer says what was created, ' +
      'linked, updated or refused, item by item. Synchronous, and makes no model call. Mirrors ' +
      'POST /v1/ai/person-intake/apply.',
    scope: 'ai:write',
    inputSchema: applyBody,
    invoke: async (args, actor) => ({ results: await intake.apply(actor, args.items) }),
  })
}
