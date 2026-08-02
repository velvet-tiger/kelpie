import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm'

import type { Database } from '../../lib/database.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { passwordResetTokens, sessions, users } from './schema.ts'

/**
 * Drizzle queries for accounts and sessions. No business logic: the service
 * decides, these read and write.
 *
 * Users and sessions are global rather than workspace-scoped, so unlike the CRM
 * repositories these do not take a `workspaceId` first argument.
 */

/** Either the pool or an open transaction. Repositories never open one themselves. */
export type Queryable = Database | Transaction

export type UserRecord = typeof users.$inferSelect
export type SessionRecord = typeof sessions.$inferSelect

export async function findUserByEmail(db: Queryable, email: string): Promise<UserRecord | undefined> {
  const [found] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  return found
}

export async function findUserById(db: Queryable, userId: string): Promise<UserRecord | undefined> {
  const [found] = await db.select().from(users).where(eq(users.id, userId)).limit(1)

  return found
}

export async function insertUser(db: Queryable, values: typeof users.$inferInsert): Promise<UserRecord> {
  const [created] = await db.insert(users).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting user ${values.id} returned no row`)
  }

  return created
}

export async function updateUserPassword(
  db: Queryable,
  userId: string,
  passwordHash: string,
  now: Date,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, updatedAt: now })
    .where(eq(users.id, userId))
}

export async function insertSession(
  db: Queryable,
  values: typeof sessions.$inferInsert,
): Promise<SessionRecord> {
  const [created] = await db.insert(sessions).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting session ${values.id} returned no row`)
  }

  return created
}

/** Only returns sessions that have not expired; an expired row is not a session. */
export async function findLiveSessionByTokenHash(
  db: Queryable,
  tokenHash: string,
  now: Date,
): Promise<SessionRecord | undefined> {
  const [found] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1)

  return found
}

export async function listSessionsForUser(db: Queryable, userId: string): Promise<SessionRecord[]> {
  return db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.lastActiveAt))
}

export async function touchSession(db: Queryable, sessionId: string, now: Date): Promise<void> {
  await db.update(sessions).set({ lastActiveAt: now }).where(eq(sessions.id, sessionId))
}

export async function deleteSession(db: Queryable, userId: string, sessionId: string): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ id: sessions.id })

  return deleted.length
}

export async function deleteAllSessionsForUser(db: Queryable, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))
}

/** Signs every other device out while leaving the caller where they are. */
export async function deleteOtherSessionsForUser(
  db: Queryable,
  userId: string,
  keepSessionId: string,
): Promise<void> {
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
}

export async function setActiveWorkspace(
  db: Queryable,
  sessionId: string,
  workspaceId: string,
): Promise<void> {
  await db.update(sessions).set({ activeWorkspaceId: workspaceId }).where(eq(sessions.id, sessionId))
}

export async function insertPasswordResetToken(
  db: Queryable,
  values: typeof passwordResetTokens.$inferInsert,
): Promise<void> {
  await db.insert(passwordResetTokens).values(values)
}

/** Unused and unexpired. A used or stale token is not a token. */
export async function findUsablePasswordResetToken(
  db: Queryable,
  tokenHash: string,
  now: Date,
): Promise<typeof passwordResetTokens.$inferSelect | undefined> {
  const [found] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now),
      ),
    )
    .limit(1)

  return found
}

export async function markPasswordResetTokenUsed(db: Queryable, id: string, now: Date): Promise<void> {
  await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(eq(passwordResetTokens.id, id))
}

/** The membership a session's active workspace resolves to, if any. */
export async function findMembership(
  db: Queryable,
  workspaceId: string,
  userId: string,
): Promise<typeof workspaceMembers.$inferSelect | undefined> {
  const [found] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1)

  return found
}

/** The workspace a returning user lands in when their session has no active one. */
export async function findFirstMembership(
  db: Queryable,
  userId: string,
): Promise<typeof workspaceMembers.$inferSelect | undefined> {
  const [found] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaceMembers.joinedAt)
    .limit(1)

  return found
}
