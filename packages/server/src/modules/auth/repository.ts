import { and, asc, desc, eq, gt, isNull, ne } from 'drizzle-orm'

import type { Database } from '../../lib/database.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'
import {
  emailVerificationTokens,
  passwordResetTokens,
  sessions,
  userPreferences,
  users,
} from './schema.ts'

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
export type UserPreferencesRecord = typeof userPreferences.$inferSelect

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

/** `null` clears the password, leaving the account reachable only through a module or a reset. */
export async function updateUserPassword(
  db: Queryable,
  userId: string,
  passwordHash: string | null,
  now: Date,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, updatedAt: now })
    .where(eq(users.id, userId))
}

/**
 * Writes name and email. Not the password: that one has its own function because
 * it also ends sessions, and the two must not be reachable through one call.
 *
 * `emailVerifiedAt` rides along with an email change: the service resets it to
 * null in the same call rather than a second write, so there is no window where
 * the row holds a new address and the old address's verification.
 */
export async function updateUserProfile(
  db: Queryable,
  userId: string,
  changes: { readonly name?: string; readonly email?: string; readonly emailVerifiedAt?: Date | null },
  now: Date,
): Promise<UserRecord | undefined> {
  const [updated] = await db
    .update(users)
    .set({ ...changes, updatedAt: now })
    .where(eq(users.id, userId))
    .returning()

  return updated
}

export async function findPreferences(
  db: Queryable,
  userId: string,
): Promise<UserPreferencesRecord | undefined> {
  const [found] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1)

  return found
}

/**
 * Inserts the row or replaces it, since the caller always has a complete set of
 * values. Repeating a save writes the same row rather than failing on the
 * primary key.
 */
export async function upsertPreferences(
  db: Queryable,
  values: typeof userPreferences.$inferInsert,
): Promise<UserPreferencesRecord> {
  const [saved] = await db
    .insert(userPreferences)
    .values(values)
    .onConflictDoUpdate({ target: userPreferences.userId, set: values })
    .returning()

  if (saved === undefined) {
    throw new Error(`Upserting preferences for ${values.userId} returned no row`)
  }

  return saved
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

/**
 * Marks a reset token used. Answers false when it is already used or has
 * expired, which is how two requests holding the same link are told apart
 * without a read-then-write race: the second one waits on the row, then finds
 * `used_at` set and updates nothing.
 */
export async function spendPasswordResetToken(db: Queryable, id: string, now: Date): Promise<boolean> {
  const spent = await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.id, id),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now),
      ),
    )
    .returning({ id: passwordResetTokens.id })

  return spent.length > 0
}

/**
 * Marks every unused reset token of one account used, so no link sent before
 * the password moved can move it again. Marked rather than deleted, like a
 * spent token, so each one is refused as a replay.
 */
export async function closeOpenPasswordResetTokens(db: Queryable, userId: string, now: Date): Promise<void> {
  await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)))
}

export async function insertEmailVerificationToken(
  db: Queryable,
  values: typeof emailVerificationTokens.$inferInsert,
): Promise<void> {
  await db.insert(emailVerificationTokens).values(values)
}

/** Unused and unexpired. A used or stale token is not a token. */
export async function findUsableEmailVerificationToken(
  db: Queryable,
  tokenHash: string,
  now: Date,
): Promise<typeof emailVerificationTokens.$inferSelect | undefined> {
  const [found] = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, tokenHash),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, now),
      ),
    )
    .limit(1)

  return found
}

/** Marks a verification token used. Answers false when it is already used or has expired. */
export async function spendEmailVerificationToken(db: Queryable, id: string, now: Date): Promise<boolean> {
  const spent = await db
    .update(emailVerificationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailVerificationTokens.id, id),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, now),
      ),
    )
    .returning({ id: emailVerificationTokens.id })

  return spent.length > 0
}

/**
 * Sets `email_verified_at` if it is not already set.
 *
 * Guarded in the `WHERE` clause rather than read-then-write, so accepting a
 * second invite or confirming a stale token after the account is already
 * verified is a no-op instead of overwriting the original verification time.
 */
export async function markEmailVerified(db: Queryable, userId: string, now: Date): Promise<void> {
  await db
    .update(users)
    .set({ emailVerifiedAt: now })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)))
}

/**
 * Sets `email_verified_at` for the address a verification link was sent to.
 *
 * The address is in the `WHERE` clause, so an account that moves to another
 * address between the caller's check and this write is left unverified.
 */
export async function markEmailAddressVerified(
  db: Queryable,
  userId: string,
  email: string,
  now: Date,
): Promise<void> {
  await db
    .update(users)
    .set({ emailVerifiedAt: now })
    .where(and(eq(users.id, userId), eq(users.email, email), isNull(users.emailVerifiedAt)))
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

/** Every workspace this account belongs to, oldest membership first. */
export interface AccountWorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly timezone: string
  readonly role: string
}

export async function listWorkspacesForUser(
  db: Queryable,
  userId: string,
): Promise<AccountWorkspaceRecord[]> {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      timezone: workspaces.timezone,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.joinedAt))
}
