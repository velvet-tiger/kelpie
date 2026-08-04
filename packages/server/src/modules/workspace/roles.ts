import { INVITABLE_ROLES, INVITE_STATUSES, MEMBER_ROLES } from '@kelpie/schemas'
import type { InvitableRole, InviteStatus, MemberRole } from '@kelpie/schemas'

/**
 * Workspace roles, ordered by authority. `owner` is a single seat per workspace,
 * enforced in the service layer because it is a per-workspace invariant rather
 * than a per-row one.
 *
 * The lists themselves live in `@kelpie/schemas`: `GET /v1/auth/me` returns a
 * role and the team page offers one, so the browser decodes against the same
 * values this file gates on.
 */

export { INVITABLE_ROLES, INVITE_STATUSES, MEMBER_ROLES }
export type { InvitableRole, InviteStatus, MemberRole }

const authority: Readonly<Record<MemberRole, number>> = {
  owner: 3,
  admin: 2,
  member: 1,
}

/** True when `role` is at least as authoritative as `required`. */
export function roleAllows(role: MemberRole, required: MemberRole): boolean {
  return authority[role] >= authority[required]
}

/**
 * Narrows a stored role string. Returns undefined for anything else, which can
 * only happen if a row is violating its own check constraint.
 */
export function parseMemberRole(value: string): MemberRole | undefined {
  return MEMBER_ROLES.find((role) => role === value)
}

export function parseInvitableRole(value: string): InvitableRole | undefined {
  return INVITABLE_ROLES.find((role) => role === value)
}
