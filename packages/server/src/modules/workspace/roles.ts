/**
 * Workspace roles, ordered by authority. `owner` is a single seat per workspace,
 * enforced in the service layer because it is a per-workspace invariant rather
 * than a per-row one.
 */

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const

export type MemberRole = (typeof MEMBER_ROLES)[number]

/** Roles an invite may offer. Ownership transfers, it is never invited. */
export const INVITABLE_ROLES = ['admin', 'member'] as const

export type InvitableRole = (typeof INVITABLE_ROLES)[number]

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
