import { roleBody, roleSchema } from '@kelpie/schemas'
import type { Role, RoleInput, RoleStatus } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'

/** `/v1/roles`. Create needs a title; the API opens the role. */

export interface CreateRoleInput extends RoleInput {
  readonly title: string
}

const roles = createResourceHooks<Role, CreateRoleInput, RoleInput>({
  name: 'roles',
  path: '/roles',
  decode: roleSchema.parse,
  createBody: roleBody,
  updateBody: roleBody,
  // Deleting a role takes its candidacies with it, and each one files an unlink
  // on a person's timeline, so both caches are stale the moment a role goes.
  alsoInvalidates: ['candidates', 'activities'],
})

/** The documented filters on `GET /v1/roles`. */
export interface RoleFilters {
  /** Matches the role's title, which is what the mockup's filter box matches. */
  readonly term?: string | undefined
  /** Roles in any of these statuses. Repeats on the wire. */
  readonly statuses?: readonly RoleStatus[] | undefined
  readonly limit?: number | undefined
  /** `field` ascending, `-field` descending. Only `title`, `created_at`, `updated_at` are sortable. */
  readonly sort?: string | undefined
}

function roleQuery(filters: RoleFilters): QueryParameters {
  return { q: filters.term, status: filters.statuses, limit: filters.limit, sort: filters.sort }
}

export function useRoles(
  filters: RoleFilters = {},
  options: ListOptions = {},
): RecordListResult<Role> {
  return roles.useList(roleQuery(filters), options)
}

export function useRole(id: string | undefined): RecordResult<Role> {
  return roles.useRecord(id)
}

export function useCreateRole(): MutationResult<CreateRoleInput, Role> {
  return roles.useCreate()
}

export function useUpdateRole(): MutationResult<UpdateArguments<RoleInput>, Role> {
  return roles.useUpdate()
}

export function useDeleteRole(): MutationResult<string, void> {
  return roles.useRemove()
}
