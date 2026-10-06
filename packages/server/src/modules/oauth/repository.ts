import { and, asc, desc, eq, gt, isNull, lt, notExists } from 'drizzle-orm'

import type { Database } from '../../lib/database.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'
import { oauthClients, oauthConnections, oauthGrants, oauthRequests, oauthTokens } from './schema.ts'
import type { OAuthTokenKind } from './schema.ts'

export type Queryable = Database | Transaction

export type OAuthClientRecord = typeof oauthClients.$inferSelect
export type OAuthRequestRecord = typeof oauthRequests.$inferSelect
export type OAuthConnectionRecord = typeof oauthConnections.$inferSelect
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

// Connections

export async function insertConnection(
  db: Queryable,
  values: typeof oauthConnections.$inferInsert,
): Promise<OAuthConnectionRecord> {
  const [created] = await db.insert(oauthConnections).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting OAuth connection ${values.id} returned no row`)
  }

  return created
}

export async function findConnection(db: Queryable, id: string): Promise<OAuthConnectionRecord | undefined> {
  const [found] = await db.select().from(oauthConnections).where(eq(oauthConnections.id, id)).limit(1)

  return found
}

/** Ends the connection: every grant, code and token under it goes through the cascade. */
export async function deleteConnectionById(db: Queryable, id: string): Promise<void> {
  await db.delete(oauthConnections).where(eq(oauthConnections.id, id))
}

export async function deleteConnection(db: Queryable, userId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(oauthConnections)
    .where(and(eq(oauthConnections.id, id), eq(oauthConnections.userId, userId)))
    .returning({ id: oauthConnections.id })

  return deleted.length
}

/**
 * Deletes the connections that have no grant left, and their tokens with them.
 *
 * A connection loses a grant when the user revokes one workspace, approves the
 * same client for that workspace again, leaves the workspace, or the workspace
 * is deleted. A token under a connection with no grant reaches nothing, and
 * this is what removes it. Called after each of those that the module sees,
 * and on the token path as housekeeping for the ones it does not.
 */
export async function deleteConnectionsWithoutGrants(db: Queryable): Promise<void> {
  await db
    .delete(oauthConnections)
    .where(
      notExists(
        db
          .select({ id: oauthGrants.id })
          .from(oauthGrants)
          .where(eq(oauthGrants.connectionId, oauthConnections.id)),
      ),
    )
}

// Grants

/**
 * Approving the same client for the same workspace again moves the one row to
 * the new connection, with the new scopes. Its old connection loses that
 * workspace.
 */
export async function upsertGrant(
  db: Queryable,
  values: typeof oauthGrants.$inferInsert,
): Promise<OAuthGrantRecord> {
  const [saved] = await db
    .insert(oauthGrants)
    .values(values)
    .onConflictDoUpdate({
      target: [oauthGrants.workspaceId, oauthGrants.userId, oauthGrants.clientRowId],
      set: {
        connectionId: values.connectionId,
        scopes: values.scopes,
        updatedAt: values.updatedAt ?? new Date(),
      },
    })
    .returning()

  if (saved === undefined) {
    throw new Error(`Saving OAuth grant ${values.id} returned no row`)
  }

  return saved
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

export async function findGrant(db: Queryable, id: string): Promise<OAuthGrantRecord | undefined> {
  const [found] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, id)).limit(1)

  return found
}

export async function deleteGrant(db: Queryable, userId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(oauthGrants)
    .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, userId)))
    .returning({ id: oauthGrants.id })

  return deleted.length
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

export async function deleteToken(db: Queryable, id: string): Promise<void> {
  await db.delete(oauthTokens).where(eq(oauthTokens.id, id))
}

export async function deleteExpiredTokens(db: Queryable, now: Date): Promise<void> {
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, now))
}

/**
 * A workspace a connection covers, with the membership that makes it usable.
 * `membership` is null when the user is no longer a member: the grant is then
 * dead, whether or not the `workspace.member.removed` subscriber has run.
 */
export interface ConnectionGrant {
  readonly grant: OAuthGrantRecord
  readonly workspaceName: string
  readonly membership: { readonly id: string; readonly role: string } | null
}

export interface LiveAccessToken {
  readonly token: OAuthTokenRecord
  readonly connection: OAuthConnectionRecord
  readonly clientId: string
  /** Oldest first, so the order a client sees does not change between requests. */
  readonly grants: readonly ConnectionGrant[]
}

/** The access token behind a bearer secret, if it is live, with the grants of its connection. */
export async function findLiveAccessToken(
  db: Queryable,
  tokenHash: string,
  now: Date,
): Promise<LiveAccessToken | undefined> {
  const [found] = await db
    .select({ token: oauthTokens, connection: oauthConnections, clientId: oauthClients.clientId })
    .from(oauthTokens)
    .innerJoin(oauthConnections, eq(oauthConnections.id, oauthTokens.connectionId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthConnections.clientRowId))
    .where(
      and(
        eq(oauthTokens.tokenHash, tokenHash),
        eq(oauthTokens.kind, 'access'),
        gt(oauthTokens.expiresAt, now),
      ),
    )
    .limit(1)

  if (found === undefined) {
    return undefined
  }

  const grants = await db
    .select({
      grant: oauthGrants,
      workspaceName: workspaces.name,
      memberId: workspaceMembers.id,
      memberRole: workspaceMembers.role,
    })
    .from(oauthGrants)
    .innerJoin(workspaces, eq(workspaces.id, oauthGrants.workspaceId))
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, oauthGrants.workspaceId),
        eq(workspaceMembers.userId, oauthGrants.userId),
      ),
    )
    .where(eq(oauthGrants.connectionId, found.connection.id))
    .orderBy(asc(oauthGrants.createdAt), asc(oauthGrants.id))

  return {
    ...found,
    grants: grants.map((row) => ({
      grant: row.grant,
      workspaceName: row.workspaceName,
      membership: row.memberId === null || row.memberRole === null ? null : { id: row.memberId, role: row.memberRole },
    })),
  }
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

