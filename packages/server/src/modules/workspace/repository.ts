import { and, eq } from 'drizzle-orm'

import type { Database } from '../../lib/database.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { handbookPages } from '../handbook/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { invites, workspaceMembers, workspaces } from './schema.ts'

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

export async function updateWorkspace(
  db: Queryable,
  id: string,
  changes: Partial<typeof workspaces.$inferInsert>,
): Promise<WorkspaceRecord | undefined> {
  const [updated] = await db.update(workspaces).set(changes).where(eq(workspaces.id, id)).returning()

  return updated
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

export async function listMembers(db: Queryable, workspaceId: string): Promise<MemberRecord[]> {
  return db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(workspaceMembers.joinedAt)
}

/**
 * Seats already spoken for: members plus invites still outstanding.
 *
 * A pending invite counts, otherwise a workspace on its last seat could send ten
 * invitations and let whoever accepts first through while the others fail.
 */
export async function countSeatsInUse(db: Queryable, workspaceId: string): Promise<number> {
  const [members, pending] = await Promise.all([
    db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
    db
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.workspaceId, workspaceId), eq(invites.status, 'pending'))),
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
