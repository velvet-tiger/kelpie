import { and, asc, count, eq, gt } from 'drizzle-orm'

import type { Database } from '../../lib/database.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { users } from '../auth/schema.ts'
import { deals } from '../deals/schema.ts'
import { decisions } from '../decisions/schema.ts'
import { handbookPages } from '../handbook/schema.ts'
import { notes } from '../notes/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { planItems } from '../plans/schema.ts'
import { raises } from '../raises/schema.ts'
import { invites, workspaceMembers, workspaceModuleSettings, workspaces } from './schema.ts'

/** Queries for workspaces, membership, and invites. The service decides; these read and write. */

export type Queryable = Database | Transaction

export type WorkspaceRecord = typeof workspaces.$inferSelect
export type MemberRecord = typeof workspaceMembers.$inferSelect
export type InviteRecord = typeof invites.$inferSelect

export async function insertWorkspace(
  db: Queryable,
  values: typeof workspaces.$inferInsert,
): Promise<WorkspaceRecord> {
  const [created] = await db.insert(workspaces).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting workspace ${values.id} returned no row`)
  }

  return created
}

export async function findWorkspace(db: Queryable, id: string): Promise<WorkspaceRecord | undefined> {
  const [found] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)

  return found
}

/**
 * A PATCH's changes, as they arrive: every key optional, and a key may be
 * present holding `undefined` because that is what a parsed request body looks
 * like. `Partial<T>` alone permits only the absence, not the `undefined`.
 *
 * Passing `undefined` through is safe rather than merely tolerated. Drizzle's
 * `mapUpdateSet` filters those entries out before building the `set` clause, so
 * a field the caller did not send is left alone instead of being written null.
 */
type Changes<T> = { [K in keyof T]?: T[K] | undefined }

export async function updateWorkspace(
  db: Queryable,
  id: string,
  changes: Changes<typeof workspaces.$inferInsert>,
): Promise<WorkspaceRecord | undefined> {
  const [updated] = await db.update(workspaces).set(changes).where(eq(workspaces.id, id)).returning()

  return updated
}

/**
 * Removes the workspace and, through `workspace_id` cascades, everything it
 * owned. No table outside this one holds a workspace's data.
 */
export async function deleteWorkspace(db: Queryable, id: string): Promise<void> {
  await db.delete(workspaces).where(eq(workspaces.id, id))
}

export async function insertMember(
  db: Queryable,
  values: typeof workspaceMembers.$inferInsert,
): Promise<MemberRecord> {
  const [created] = await db.insert(workspaceMembers).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting member ${values.id} returned no row`)
  }

  return created
}

export async function findMember(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<MemberRecord | undefined> {
  const [found] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.id, id)))
    .limit(1)

  return found
}

export async function updateMemberRole(
  db: Queryable,
  id: string,
  role: string,
  updatedAt: Date,
): Promise<MemberRecord | undefined> {
  const [updated] = await db
    .update(workspaceMembers)
    .set({ role, updatedAt })
    .where(eq(workspaceMembers.id, id))
    .returning()

  return updated
}

export async function deleteMember(db: Queryable, id: string): Promise<void> {
  await db.delete(workspaceMembers).where(eq(workspaceMembers.id, id))
}

/**
 * What a member is named on, counted per table.
 *
 * The `owner_id` and `author_id` columns are `ON DELETE RESTRICT`, so the
 * database would refuse the delete on its own. It would only name one table
 * while doing it, and `api.md` wants every referencing type in the `409`
 * details, so the counts are read first and the refusal is the service's.
 *
 * This is the one place the workspace module reads other modules' tables. The
 * alternative is each of them registering a "does this member matter to you"
 * hook, which is more machinery than one query list is worth today.
 *
 * @returns Only the types with at least one reference, in a fixed order.
 */
export async function countMemberReferences(
  db: Queryable,
  memberId: string,
): Promise<readonly { readonly type: string; readonly count: number }[]> {
  const sources = [
    { type: 'deal', table: deals, column: deals.ownerId },
    { type: 'opportunity', table: opportunities, column: opportunities.ownerId },
    { type: 'partnership', table: partnerships, column: partnerships.ownerId },
    { type: 'raise', table: raises, column: raises.ownerId },
    { type: 'plan_item', table: planItems, column: planItems.ownerId },
    { type: 'decision', table: decisions, column: decisions.ownerId },
    { type: 'note', table: notes, column: notes.authorId },
  ] as const

  const counted = await Promise.all(
    sources.map(async (source) => {
      const [row] = await db.select({ total: count() }).from(source.table).where(eq(source.column, memberId))

      return { type: source.type, count: row?.total ?? 0 }
    }),
  )

  return counted.filter((entry) => entry.count > 0)
}

/** A membership plus the identity behind it, which is what a member is to a reader. */
export interface MemberWithUser {
  readonly id: string
  readonly userId: string
  readonly role: string
  readonly joinedAt: Date
  readonly name: string
  readonly email: string
}

/**
 * Members with their user's name and email.
 *
 * Joined here rather than left to the caller: every list of members is read to
 * be shown to a human, and a membership row on its own carries nothing a human
 * recognises. Notes and activities attribute to a member id and resolve the name
 * through this list.
 */
export async function listMembers(db: Queryable, workspaceId: string): Promise<MemberWithUser[]> {
  return db
    .select({
      id: workspaceMembers.id,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      name: users.name,
      email: users.email,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(workspaceMembers.joinedAt)
}

/** One member in the same shape `listMembers` produces, for a write to answer with. */
export async function findMemberWithUser(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<MemberWithUser | undefined> {
  const [found] = await db
    .select({
      id: workspaceMembers.id,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      name: users.name,
      email: users.email,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.id, id)))
    .limit(1)

  return found
}

/**
 * The workspace's owner. Earliest-joined breaks a tie, so the answer does not
 * move if a second owner ever exists; the service is what keeps there being one.
 */
export async function findOwner(
  db: Queryable,
  workspaceId: string,
): Promise<MemberRecord | undefined> {
  const [found] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')))
    .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.id))
    .limit(1)

  return found
}

/**
 * The member a record is assigned to when nobody chose one.
 *
 * A public form submit has no actor, so a Deal it creates has no natural owner
 * and `forms.md` gives it the workspace's default member. That is the owner: the
 * account that created the workspace, and the one person guaranteed to be able
 * to reassign it.
 *
 * @returns undefined only for a workspace with no members, which membership
 *   creation makes unreachable through the API.
 */
export function findDefaultMember(
  db: Queryable,
  workspaceId: string,
): Promise<MemberRecord | undefined> {
  return findOwner(db, workspaceId)
}

/**
 * Seats already spoken for: members plus invitations still open.
 *
 * An open invite counts, otherwise a workspace on its last seat could send ten
 * invitations and let whoever accepts first through while the others fail. One
 * that has expired does not, because nobody can accept it.
 */
export async function countSeatsInUse(
  db: Queryable,
  workspaceId: string,
  now: Date,
): Promise<number> {
  const [members, pending] = await Promise.all([
    db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
    db
      .select({ id: invites.id })
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, workspaceId),
          eq(invites.status, 'pending'),
          gt(invites.expiresAt, now),
        ),
      ),
  ])

  return members.length + pending.length
}

export async function insertInvite(
  db: Queryable,
  values: typeof invites.$inferInsert,
): Promise<InviteRecord> {
  const [created] = await db.insert(invites).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting invite ${values.id} returned no row`)
  }

  return created
}

export async function listInvites(db: Queryable, workspaceId: string): Promise<InviteRecord[]> {
  return db.select().from(invites).where(eq(invites.workspaceId, workspaceId)).orderBy(invites.createdAt)
}

export async function findInvite(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<InviteRecord | undefined> {
  const [found] = await db
    .select()
    .from(invites)
    .where(and(eq(invites.workspaceId, workspaceId), eq(invites.id, id)))
    .limit(1)

  return found
}

export async function updateInvite(
  db: Queryable,
  id: string,
  changes: Partial<typeof invites.$inferInsert>,
): Promise<InviteRecord | undefined> {
  const [updated] = await db.update(invites).set(changes).where(eq(invites.id, id)).returning()

  return updated
}

/**
 * Every invitation to this address in this workspace, expired ones included.
 *
 * The column is `citext`, so an address invited as `Grace@Example.com` is found
 * by `grace@example.com` and the caller does not have to case-fold twice.
 */
export async function listInvitesForEmail(
  db: Queryable,
  workspaceId: string,
  email: string,
): Promise<InviteRecord[]> {
  return db
    .select()
    .from(invites)
    .where(and(eq(invites.workspaceId, workspaceId), eq(invites.email, email)))
    .orderBy(invites.createdAt)
}

/** The same set, removed. Expiry is not a filter: a dead invitation is still noise. */
export async function deleteInvitesForEmail(
  db: Queryable,
  workspaceId: string,
  email: string,
): Promise<void> {
  await db.delete(invites).where(and(eq(invites.workspaceId, workspaceId), eq(invites.email, email)))
}

export async function findInviteByTokenHash(
  db: Queryable,
  tokenHash: string,
): Promise<InviteRecord | undefined> {
  const [found] = await db.select().from(invites).where(eq(invites.tokenHash, tokenHash)).limit(1)

  return found
}

export async function deleteInvite(db: Queryable, id: string): Promise<void> {
  await db.delete(invites).where(eq(invites.id, id))
}

export async function insertHandbookPages(
  db: Queryable,
  values: readonly (typeof handbookPages.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) {
    return
  }

  await db.insert(handbookPages).values([...values])
}

export async function insertPipelineStages(
  db: Queryable,
  values: readonly (typeof pipelineStages.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) {
    return
  }

  await db.insert(pipelineStages).values([...values])
}

export type ModuleSettingRecord = typeof workspaceModuleSettings.$inferSelect

export async function listModuleSettings(db: Queryable, workspaceId: string): Promise<ModuleSettingRecord[]> {
  return db
    .select()
    .from(workspaceModuleSettings)
    .where(eq(workspaceModuleSettings.workspaceId, workspaceId))
}

/** Undefined means the workspace has never toggled this module, not that it is disabled. */
export async function findModuleSetting(
  db: Queryable,
  workspaceId: string,
  moduleId: string,
): Promise<ModuleSettingRecord | undefined> {
  const [found] = await db
    .select()
    .from(workspaceModuleSettings)
    .where(and(eq(workspaceModuleSettings.workspaceId, workspaceId), eq(workspaceModuleSettings.moduleId, moduleId)))
    .limit(1)

  return found
}

/**
 * Sets a workspace's choice for one module, inserting the row on its first
 * toggle and overwriting `enabled` on every one after.
 */
export async function upsertModuleSetting(
  db: Queryable,
  values: typeof workspaceModuleSettings.$inferInsert,
): Promise<ModuleSettingRecord> {
  const [row] = await db
    .insert(workspaceModuleSettings)
    .values(values)
    .onConflictDoUpdate({
      target: [workspaceModuleSettings.workspaceId, workspaceModuleSettings.moduleId],
      set: { enabled: values.enabled, updatedAt: values.updatedAt },
    })
    .returning()

  if (row === undefined) {
    throw new Error(
      `Upserting the "${values.moduleId}" module setting for workspace ${values.workspaceId} returned no row`,
    )
  }

  return row
}
