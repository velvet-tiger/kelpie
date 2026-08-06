import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { enumSetArg, idArg, idSetArg, listWindowShape, registerCrudTools, termArg, toSet } from '../crudTools.ts'
import type { CandidatesService } from './candidates.ts'
import type { RolesService } from './roles.ts'
import {
  candidateResponse,
  createCandidateBody,
  createRoleBody,
  roleResponse,
  toCreateCandidateInput,
  toCreateRoleInput,
  toUpdateCandidateInput,
  toUpdateRoleInput,
  updateCandidateBody,
  updateRoleBody,
} from './routes.ts'
import { CANDIDATE_STATUSES, ROLE_STATUSES } from './schema.ts'

/** `roles_*` and `candidates_*`. Same schemas and mappers as `/v1/roles` and `/v1/candidates`. */

const roleListArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  status: enumSetArg(ROLE_STATUSES).optional().describe('open, closed, or both.'),
})

const candidateListArgs = z.strictObject({
  ...listWindowShape,
  role_id: idSetArg.optional().describe('One role\'s pipeline.'),
  person_id: idSetArg.optional().describe('Every role these people are up for.'),
  status: enumSetArg(CANDIDATE_STATUSES).optional().describe('The candidacy\'s pipeline state.'),
})

export function registerHiringTools(
  mcp: McpToolRegistry,
  services: { readonly roles: RolesService; readonly candidates: CandidatesService },
): void {
  registerCrudTools(mcp, {
    resource: 'roles',
    subject: 'role',
    about: 'An opening this workspace is hiring for. Candidates attach to a role, never to a person.',
    service: services.roles,
    render: roleResponse,
    listArgs: roleListArgs,
    toFilters: (args) => ({ term: args.q, statuses: toSet(args.status) }),
    createArgs: createRoleBody,
    toCreateInput: toCreateRoleInput,
    updateArgs: updateRoleBody.extend({ id: idArg }),
    toUpdateInput: toUpdateRoleInput,
  })

  registerCrudTools(mcp, {
    resource: 'candidates',
    subject: 'candidate',
    about:
      'One person\'s candidacy for one role: status, interview stage while in process, ' +
      'and who referred them. Interview notes attach here, not to the person.',
    service: services.candidates,
    render: candidateResponse,
    listArgs: candidateListArgs,
    toFilters: (args) => ({
      roleIds: toSet(args.role_id),
      personIds: toSet(args.person_id),
      statuses: toSet(args.status),
    }),
    createArgs: createCandidateBody,
    toCreateInput: toCreateCandidateInput,
    updateArgs: updateCandidateBody.extend({ id: idArg }),
    toUpdateInput: toUpdateCandidateInput,
  })
}
