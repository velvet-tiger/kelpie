import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm'
import type { PgColumn, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core'

import type { Database } from '../../lib/database.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { users } from '../auth/schema.ts'
import { companies } from '../companies/schema.ts'
import { consentPurposes } from '../consent-purposes/schema.ts'
import { deals } from '../deals/schema.ts'
import { decisions } from '../decisions/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { events } from '../events/schema.ts'
import { handbookPages } from '../handbook/schema.ts'
import { notes } from '../notes/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people } from '../people/schema.ts'
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
 * One column that names a member on a record, `ON DELETE RESTRICT` against
 * `workspace_members`. The database refuses to delete a member a row still
 * names, so every such column must be counted or cleared before a member row
 * goes.
 */
interface MemberReference {
  /** The record type a `409` names. */
  readonly type: string
  /** `table.column`. A test checks this list against the schema. */
  readonly label: string
  /**
   * Whether an admin can move these to someone else through the API. An
   * owner can be reassigned, so removing a member who still owns records is
   * refused until somebody does. A note's author cannot be, so removing a
   * member clears it instead of refusing for ever.
   */
  readonly reassignable: boolean
  readonly count: (db: Queryable, workspaceId: string, memberId: string) => Promise<number>
  readonly clear: (db: Queryable, workspaceId: string, memberId: string) => Promise<void>
}

/**
 * Builds the two queries for one column.
 *
 * A member id is globally unique, so the workspace term is defence in depth
 * rather than the thing that scopes the query. It keeps each query safe on its
 * own instead of by that invariant.
 */
function memberReference<Table extends PgTable>(
  reference: Pick<MemberReference, 'type' | 'label' | 'reassignable'>,
  table: Table,
  column: PgColumn,
  workspaceColumn: PgColumn,
  cleared: PgUpdateSetSource<Table>,
): MemberReference {
  // Drizzle's `from` cannot decide whether an unresolved generic table has a
  // selection, so the count reads it as the plain table type it extends.
  const counted: PgTable = table

  return {
    ...reference,
    async count(db, workspaceId, memberId) {
      const [row] = await db
        .select({ total: count() })
        .from(counted)
        .where(and(eq(column, memberId), eq(workspaceColumn, workspaceId)))

      return row?.total ?? 0
    },
    async clear(db, workspaceId, memberId) {
      await db
        .update(table)
        .set(cleared)
        .where(and(eq(column, memberId), eq(workspaceColumn, workspaceId)))
    },
  }
}

/**
 * Every column that names a member on a record, in the order a `409` lists
 * them.
 *
 * This is the one place the workspace module reads other modules' tables. The
 * alternative is each of them registering a "does this member matter to you"
 * hook, which is more machinery than one query list is worth today.
 *
 * Clearing writes no `updated_at` and emits no record event. It is what an
 * `ON DELETE SET NULL` would do: the record did not change, the person it
 * named went.
 */
const MEMBER_REFERENCES: readonly MemberReference[] = [
  memberReference(
    { type: 'deal', label: 'deals.owner_id', reassignable: true },
    deals,
    deals.ownerId,
    deals.workspaceId,
    { ownerId: null },
  ),
  memberReference(
    { type: 'enquiry', label: 'enquiries.owner_id', reassignable: true },
    enquiries,
    enquiries.ownerId,
    enquiries.workspaceId,
    { ownerId: null },
  ),
  memberReference(
    { type: 'event', label: 'events.owner_id', reassignable: true },
    events,
    events.ownerId,
    events.workspaceId,
    { ownerId: null },
  ),
  memberReference(
    { type: 'opportunity', label: 'opportunities.owner_id', reassignable: true },
    opportunities,
    opportunities.ownerId,
    opportunities.workspaceId,
    { ownerId: null },
  ),
  memberReference(
    { type: 'partnership', label: 'partnerships.owner_id', reassignable: true },
    partnerships,
    partnerships.ownerId,
    partnerships.workspaceId,
    { ownerId: null },
  ),
  memberReference(
    { type: 'raise', label: 'raises.owner_id', reassignable: true },
    raises,
    raises.ownerId,
    raises.workspaceId,
    { ownerId: null },
  ),
  memberReference(
    { type: 'plan_item', label: 'plan_items.owner_id', reassignable: true },
    planItems,
    planItems.ownerId,
    planItems.workspaceId,
    { ownerId: null },
  ),
  memberReference(
    { type: 'decision', label: 'decisions.owner_id', reassignable: true },
    decisions,
    decisions.ownerId,
    decisions.workspaceId,
    { ownerId: null },
  ),
  memberReference(
    { type: 'note', label: 'notes.author_id', reassignable: false },
    notes,
    notes.authorId,
    notes.workspaceId,
    { authorId: null },
  ),
]

/** The columns `MEMBER_REFERENCES` covers. Exported for the test that checks none is missing. */
export const MEMBER_REFERENCE_COLUMNS: readonly string[] = MEMBER_REFERENCES.map((reference) => reference.label)

/**
 * What a member owns that an admin must reassign before removing them,
 * counted per record type.
 *
 * The database would refuse the delete on its own. It would only name one
 * table while doing it, and the `409` details should name every type, so the
 * counts are read first and the refusal is the service's.
 *
 * @returns Only the types with at least one record, in a fixed order.
 */
export async function countMemberReferences(
  db: Queryable,
  workspaceId: string,
  memberId: string,
): Promise<readonly { readonly type: string; readonly count: number }[]> {
  const counted = await Promise.all(
    MEMBER_REFERENCES.filter((reference) => reference.reassignable).map(async (reference) => ({
      type: reference.type,
      count: await reference.count(db, workspaceId, memberId),
    })),
  )

  return counted.filter((entry) => entry.count > 0)
}

/**
 * Clears the author of every note this member wrote. The notes stay; they
 * read as written by a former member. Removing a member runs this, because
 * nothing else can relieve a member of a note they wrote.
 */
export async function clearNoteAuthorship(db: Queryable, workspaceId: string, memberId: string): Promise<void> {
  for (const reference of MEMBER_REFERENCES) {
    if (!reference.reassignable) {
      await reference.clear(db, workspaceId, memberId)
    }
  }
}

/**
 * Clears every column that names this member, owners and authors alike. The
 * records stay, with nobody named. Deleting an account runs this for each of
 * its memberships: the person is leaving, and the workspace's records are the
 * workspace's to keep.
 */
export async function clearMemberReferences(db: Queryable, workspaceId: string, memberId: string): Promise<void> {
  for (const reference of MEMBER_REFERENCES) {
    await reference.clear(db, workspaceId, memberId)
  }
}

/**
 * Reads a member and holds the row until the transaction ends.
 *
 * Naming a member on a record takes a key-share lock on this row, so while it
 * is held nobody can give the member anything new. That keeps what a removal
 * clears complete until the row is deleted.
 */
export async function findMemberForUpdate(tx: Transaction, id: string): Promise<MemberRecord | undefined> {
  const [found] = await tx.select().from(workspaceMembers).where(eq(workspaceMembers.id, id)).limit(1).for('update')

  return found
}

/** One of an account's memberships, with the workspace's name for a refusal to show. */
export interface AccountMembershipRecord {
  readonly memberId: string
  readonly workspaceId: string
  readonly workspaceName: string
}

/**
 * Every membership an account has, in workspace id order.
 *
 * The order is the lock order. Deleting an account locks each workspace in
 * turn, and two deletions that share workspaces must take them in the same
 * order, or each could hold one the other is waiting for.
 */
export async function listAccountMemberships(
  db: Queryable,
  userId: string,
): Promise<readonly AccountMembershipRecord[]> {
  return db
    .select({
      memberId: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      workspaceName: workspaces.name,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.workspaceId))
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
 * Makes the caller's transaction the only one that changes this workspace's
 * roles or removes one of its members, until it ends.
 *
 * Each of those writes decides from what it reads: who the owner is, and what
 * role the caller and the target have. Without the lock, two of them can read
 * the same state and then both write, and the workspace ends with two owners
 * or none. Read the members again after this returns; a read from before it
 * may be out of date.
 *
 * The lock is on the workspace row, at `NO KEY UPDATE` strength. A stronger
 * lock would also stop every insert of a row that refers to the workspace,
 * which is each write to it.
 */
export async function lockMembershipChanges(tx: Transaction, workspaceId: string): Promise<void> {
  await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('no key update')
}

/**
 * The workspace's owner. The service keeps there being exactly one, and the
 * `workspace_members_one_owner_idx` index refuses a second. The order is what
 * made the answer stable before that index existed.
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
 * and it gets the workspace's default member. That is the owner: the
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

/**
 * Records the workspace holds: people plus companies.
 *
 * Nothing else is a record for `records.limit`. Deals, notes and the rest grow
 * with what a team does, not with how many people and organisations it knows.
 */
export async function countRecordsInUse(db: Queryable, workspaceId: string): Promise<number> {
  const [[peopleRow], [companiesRow]] = await Promise.all([
    db.select({ total: count() }).from(people).where(eq(people.workspaceId, workspaceId)),
    db.select({ total: count() }).from(companies).where(eq(companies.workspaceId, workspaceId)),
  ])

  return (peopleRow?.total ?? 0) + (companiesRow?.total ?? 0)
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

/**
 * Starts a new request to send the invitation email: `email_request` goes up
 * by one in the statement that writes `changes`. Each job of an older request
 * then finds a number that is not its own, and stops.
 */
export async function beginInviteEmailRequest(
  db: Queryable,
  id: string,
  changes: Partial<typeof invites.$inferInsert>,
): Promise<InviteRecord | undefined> {
  const [updated] = await db
    .update(invites)
    .set({ ...changes, emailRequest: sql`${invites.emailRequest} + 1` })
    .where(eq(invites.id, id))
    .returning()

  return updated
}

/**
 * Changes an invitation only while `request` is its newest email request.
 * The check is part of the statement, so a resend that arrives between a
 * job's read and its write wins.
 *
 * @returns undefined when the invitation is gone or has a newer request.
 */
export async function updateInviteForEmailRequest(
  db: Queryable,
  id: string,
  request: number,
  changes: Partial<typeof invites.$inferInsert>,
): Promise<InviteRecord | undefined> {
  const [updated] = await db
    .update(invites)
    .set(changes)
    .where(and(eq(invites.id, id), eq(invites.emailRequest, request)))
    .returning()

  return updated
}

/**
 * Records an email failure on an invitation that has none, and only while
 * `request` is its newest email request. A failure that is already recorded
 * stays: it has the sender's own reason.
 *
 * @returns undefined when nothing was recorded.
 */
export async function recordInviteEmailFailureIfNone(
  db: Queryable,
  workspaceId: string,
  id: string,
  request: number,
  failure: { readonly emailFailedAt: Date; readonly emailFailure: string },
): Promise<InviteRecord | undefined> {
  const [updated] = await db
    .update(invites)
    .set(failure)
    .where(
      and(
        eq(invites.workspaceId, workspaceId),
        eq(invites.id, id),
        eq(invites.emailRequest, request),
        isNull(invites.emailFailedAt),
      ),
    )
    .returning()

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

/**
 * Spends an invitation: removes it, but only while `tokenHash` is still its
 * token and it is still open.
 *
 * The conditions are part of the delete, so an accept cannot use an invitation
 * that was revoked, resent with a new token, or accepted after the accept read
 * it. A second statement on the same row waits for this one and then finds
 * nothing.
 *
 * @returns False when there was nothing left to spend.
 */
export async function spendInvite(
  db: Queryable,
  id: string,
  tokenHash: string,
  now: Date,
): Promise<boolean> {
  const spent = await db
    .delete(invites)
    .where(
      and(
        eq(invites.id, id),
        eq(invites.tokenHash, tokenHash),
        eq(invites.status, 'pending'),
        gt(invites.expiresAt, now),
      ),
    )
    .returning({ id: invites.id })

  return spent.length > 0
}

export async function deleteInvite(db: Queryable, id: string): Promise<void> {
  await db.delete(invites).where(eq(invites.id, id))
}

export async function deleteAllHandbookPages(db: Queryable, workspaceId: string): Promise<number> {
  const deleted = await db
    .delete(handbookPages)
    .where(eq(handbookPages.workspaceId, workspaceId))
    .returning({ id: handbookPages.id })

  return deleted.length
}

export async function listHandbookPages(
  db: Queryable,
  workspaceId: string,
): Promise<(typeof handbookPages.$inferSelect)[]> {
  return db.select().from(handbookPages).where(eq(handbookPages.workspaceId, workspaceId))
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

export async function insertConsentPurposes(
  db: Queryable,
  values: readonly (typeof consentPurposes.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) {
    return
  }

  await db.insert(consentPurposes).values([...values])
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
