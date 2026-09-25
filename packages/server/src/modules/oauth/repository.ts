import { and, desc, eq, gt, inArray, isNull, lt, notExists } from 'drizzle-orm'

import type { Database } from '../../lib/database.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'
import { oauthClients, oauthGrants, oauthRequests, oauthTokens } from './schema.ts'
import type { OAuthTokenKind } from './schema.ts'

export type Queryable = Database | Transaction

export type OAuthClientRecord = typeof oauthClients.$inferSelect
export type OAuthRequestRecord = typeof oauthRequests.$inferSelect
export type OAuthGrantRecord = typeof oauthGrants.$inferSelect
export type OAuthTokenRecord = typeof oauthTokens.$inferSelect

// Clients

export async function findClientByClientId(
  db: Queryable,
  clientId: string,
): Promise<OAuthClientRecord | undefined> {
  const [found] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1)

  return found
}

export async function findClientById(db: Queryable, id: string): Promise<OAuthClientRecord | undefined> {
  const [found] = await db.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1)

  return found
}

export async function insertClient(
  db: Queryable,
  values: typeof oauthClients.$inferInsert,
): Promise<OAuthClientRecord> {
  const [created] = await db.insert(oauthClients).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting OAuth client ${values.id} returned no row`)
  }

  return created
}

/**
 * Writes a freshly fetched metadata document over its cached row, keyed by the
 * URL that is its `client_id`. An upsert, because two authorize requests for a
 * new client can arrive together.
 */
export async function upsertMetadataClient(
  db: Queryable,
  values: typeof oauthClients.$inferInsert,
): Promise<OAuthClientRecord> {
  const [saved] = await db
    .insert(oauthClients)
    .values(values)
    .onConflictDoUpdate({
      target: oauthClients.clientId,
      set: {
        clientName: values.clientName,
        clientUri: values.clientUri ?? null,
        logoUri: values.logoUri ?? null,
        redirectUris: values.redirectUris,
        metadataFetchedAt: values.metadataFetchedAt ?? null,
        updatedAt: values.updatedAt ?? new Date(),
      },
    })
    .returning()

  if (saved === undefined) {
    throw new Error(`Saving OAuth client ${values.clientId} returned no row`)
  }

  return saved
}

/**
 * Registered clients nobody connected. Dynamic registration is unauthenticated,
 * so without this the table grows with every abandoned attempt.
 */
export async function deleteUnusedRegisteredClients(db: Queryable, createdBefore: Date): Promise<number> {
  const deleted = await db
    .delete(oauthClients)
    .where(
      and(
        eq(oauthClients.kind, 'registered'),
        lt(oauthClients.createdAt, createdBefore),
        notExists(
          db
            .select({ id: oauthGrants.id })
            .from(oauthGrants)
            .where(eq(oauthGrants.clientRowId, oauthClients.id)),
        ),
      ),
    )
    .returning({ id: oauthClients.id })

  return deleted.length
}

// Requests

export async function insertRequest(
  db: Queryable,
  values: typeof oauthRequests.$inferInsert,
): Promise<OAuthRequestRecord> {
  const [created] = await db.insert(oauthRequests).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting OAuth request ${values.id} returned no row`)
  }

  return created
}

export async function findLiveRequest(
  db: Queryable,
  id: string,
  now: Date,
): Promise<OAuthRequestRecord | undefined> {
  const [found] = await db
    .select()
    .from(oauthRequests)
    .where(and(eq(oauthRequests.id, id), gt(oauthRequests.expiresAt, now)))
    .limit(1)

  return found
}

/**
 * Deletes a request and reports whether this call was the one that did, so two
 * tabs answering the same consent page cannot both mint a code.
 */
export async function takeRequest(db: Queryable, id: string): Promise<boolean> {
  const deleted = await db.delete(oauthRequests).where(eq(oauthRequests.id, id)).returning({ id: oauthRequests.id })

  return deleted.length > 0
}

export async function deleteExpiredRequests(db: Queryable, now: Date): Promise<void> {
  await db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, now))
}

// Grants

/** Approving the same client for the same workspace again replaces the scopes on the one row. */
export async function upsertGrant(
  db: Queryable,
  values: typeof oauthGrants.$inferInsert,
): Promise<OAuthGrantRecord> {
  const [saved] = await db
    .insert(oauthGrants)
    .values(values)
    .onConflictDoUpdate({
      target: [oauthGrants.workspaceId, oauthGrants.userId, oauthGrants.clientRowId],
      set: { scopes: values.scopes, updatedAt: values.updatedAt ?? new Date() },
    })
    .returning()

  if (saved === undefined) {
    throw new Error(`Saving OAuth grant ${values.id} returned no row`)
  }

  return saved
}

export async function findGrant(db: Queryable, id: string): Promise<OAuthGrantRecord | undefined> {
  const [found] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, id)).limit(1)

  return found
}

export interface GrantListing {
  readonly grant: OAuthGrantRecord
  readonly client: OAuthClientRecord
  readonly workspaceName: string
}

/** Every workspace, not only the active one: a person manages their own connections. */
export async function listGrantsForUser(db: Queryable, userId: string): Promise<GrantListing[]> {
  const rows = await db
    .select({ grant: oauthGrants, client: oauthClients, workspaceName: workspaces.name })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientRowId))
    .innerJoin(workspaces, eq(workspaces.id, oauthGrants.workspaceId))
    .where(eq(oauthGrants.userId, userId))
    .orderBy(desc(oauthGrants.createdAt))

  return rows
}

export async function deleteGrant(db: Queryable, userId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(oauthGrants)
    .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, userId)))
    .returning({ id: oauthGrants.id })

  return deleted.length
}

export async function deleteGrantById(db: Queryable, id: string): Promise<void> {
  await db.delete(oauthGrants).where(eq(oauthGrants.id, id))
}

export async function deleteGrantsForMember(db: Queryable, workspaceId: string, userId: string): Promise<void> {
  await db
    .delete(oauthGrants)
    .where(and(eq(oauthGrants.workspaceId, workspaceId), eq(oauthGrants.userId, userId)))
}

export async function touchGrant(db: Queryable, id: string, now: Date): Promise<void> {
  await db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, id))
}

// Tokens

export async function insertToken(
  db: Queryable,
  values: typeof oauthTokens.$inferInsert,
): Promise<OAuthTokenRecord> {
  const [created] = await db.insert(oauthTokens).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting OAuth token ${values.id} returned no row`)
  }

  return created
}

export async function findTokenByHash(
  db: Queryable,
  kind: OAuthTokenKind,
  tokenHash: string,
): Promise<OAuthTokenRecord | undefined> {
  const [found] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.kind, kind)))
    .limit(1)

  return found
}

/**
 * Marks a single-use token spent. Answers false when another request spent it
 * first, which is how a replay is detected without a read-then-write race.
 */
export async function spendToken(db: Queryable, id: string, now: Date): Promise<boolean> {
  const spent = await db
    .update(oauthTokens)
    .set({ usedAt: now })
    .where(and(eq(oauthTokens.id, id), isNull(oauthTokens.usedAt)))
    .returning({ id: oauthTokens.id })

  return spent.length > 0
}

/**
 * Ends every access and refresh token under a grant. Used when the user
 * approves the same client again, so a narrower choice takes effect at once
 * rather than when the old tokens expire.
 */
export async function deleteIssuedTokensForGrant(db: Queryable, grantId: string): Promise<void> {
  await db
    .delete(oauthTokens)
    .where(and(eq(oauthTokens.grantId, grantId), inArray(oauthTokens.kind, ['access', 'refresh'])))
}

export async function deleteToken(db: Queryable, id: string): Promise<void> {
  await db.delete(oauthTokens).where(eq(oauthTokens.id, id))
}

export async function deleteExpiredTokens(db: Queryable, now: Date): Promise<void> {
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, now))
}

export interface LiveAccessToken {
  readonly token: OAuthTokenRecord
  readonly grant: OAuthGrantRecord
  readonly clientId: string
}

/** The access token behind a bearer secret, if it is live, with the grant it acts under. */
export async function findLiveAccessToken(
  db: Queryable,
  tokenHash: string,
  now: Date,
): Promise<LiveAccessToken | undefined> {
  const [found] = await db
    .select({ token: oauthTokens, grant: oauthGrants, clientId: oauthClients.clientId })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientRowId))
    .where(
      and(
        eq(oauthTokens.tokenHash, tokenHash),
        eq(oauthTokens.kind, 'access'),
        gt(oauthTokens.expiresAt, now),
      ),
    )
    .limit(1)

  return found
}

// Workspaces

export interface MembershipChoice {
  readonly id: string
  readonly name: string
  readonly role: string
}

export async function listMembershipsForUser(db: Queryable, userId: string): Promise<MembershipChoice[]> {
  return db
    .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaces.name)
}

