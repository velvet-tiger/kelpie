import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'

import type { Database } from '../../lib/database.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { apiKeys } from './schema.ts'

export type Queryable = Database | Transaction

export type ApiKeyRecord = typeof apiKeys.$inferSelect

export async function insertApiKey(
  db: Queryable,
  values: typeof apiKeys.$inferInsert,
): Promise<ApiKeyRecord> {
  const [created] = await db.insert(apiKeys).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting api key ${values.id} returned no row`)
  }

  return created
}

export async function findBySecretHash(
  db: Queryable,
  secretHash: string,
): Promise<ApiKeyRecord | undefined> {
  const [found] = await db.select().from(apiKeys).where(eq(apiKeys.secretHash, secretHash)).limit(1)

  return found
}

/** Workspace keys: those with no user behind them. */
export async function listWorkspaceKeys(db: Queryable, workspaceId: string): Promise<ApiKeyRecord[]> {
  return db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.userId)))
    .orderBy(desc(apiKeys.createdAt))
}

/** Personal keys belonging to one user in one workspace. */
export async function listPersonalKeys(
  db: Queryable,
  workspaceId: string,
  userId: string,
): Promise<ApiKeyRecord[]> {
  return db
    .select()
    .from(apiKeys)
    .where(
      and(eq(apiKeys.workspaceId, workspaceId), isNotNull(apiKeys.userId), eq(apiKeys.userId, userId)),
    )
    .orderBy(desc(apiKeys.createdAt))
}

export async function findApiKey(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<ApiKeyRecord | undefined> {
  const [found] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, id)))
    .limit(1)

  return found
}

export async function deleteApiKey(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, id)))
    .returning({ id: apiKeys.id })

  return deleted.length
}

export async function touchLastUsed(db: Queryable, id: string, now: Date): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, id))
}
