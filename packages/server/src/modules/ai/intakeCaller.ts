import { API_KEY_SCOPES, MEMBER_ROLES, expandApiKeyScopes, satisfiesApiKeyScope } from '@kelpie/schemas'
import type { ApiKeyScope } from '@kelpie/schemas'
import { z } from 'zod'

import { isScopedCredential } from '../../lib/apiKeyScopes.ts'

import type { Queryable } from '../../runtime/transaction.ts'
import * as apiKeyRepository from '../api-keys/repository.ts'
import { isOAuthActor } from '../auth/actor.ts'
import type { Actor } from '../auth/actor.ts'
import * as authRepository from '../auth/repository.ts'
import * as oauthRepository from '../oauth/repository.ts'
import { parseMemberRole } from '../workspace/roles.ts'
import type { MemberRole } from '../workspace/roles.ts'

/**
 * Who a person-intake run acts as, while it waits on the job queue.
 *
 * The run reads the CRM for the model with the caller's own actor, so a
 * viewer or a scoped key gets only what it could read with a direct call.
 * Kelpie AI's admin actor is never used for intake. The request is gone by the
 * time the job runs, so the run keeps a copy of the caller's identity in
 * `context` and builds the actor again at job start.
 *
 * Only identity is stored, never authority that can change. A member's role
 * is read again when the job starts. A key's scopes are kept as they were,
 * because a key's scopes do not change after it is made.
 */

const id = z.string().min(1)

export const storedCallerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), user_id: id, session_id: id }),
  z.strictObject({
    kind: z.literal('api_key'),
    api_key_id: id,
    /** Null for a workspace key. */
    user_id: id.nullable(),
    /** A workspace key's role. A personal key takes its member's role at job start. */
    role: z.enum(MEMBER_ROLES),
    scopes: z.array(z.enum(API_KEY_SCOPES)),
  }),
  z.strictObject({
    kind: z.literal('oauth'),
    grant_id: id,
    connection_id: id,
    client_id: id,
    user_id: id,
    scopes: z.array(z.enum(API_KEY_SCOPES)),
  }),
])

export type StoredCaller = z.infer<typeof storedCallerSchema>

/** The caller's identity, to store on a run. Undefined for an actor with no workspace. */
export function storeCaller(actor: Actor): StoredCaller | undefined {
  switch (actor.kind) {
    case 'session':
      return { kind: 'session', user_id: actor.userId, session_id: actor.sessionId }
    case 'api_key':
      return {
        kind: 'api_key',
        api_key_id: actor.apiKeyId,
        user_id: actor.userId,
        role: actor.role,
        scopes: [...actor.scopes],
      }
    case 'oauth':
      return {
        kind: 'oauth',
        grant_id: actor.grantId,
        connection_id: actor.connectionId,
        client_id: actor.clientId,
        user_id: actor.userId,
        scopes: [...actor.scopes],
      }
    case 'oauth_connection':
      return undefined
  }
}

/**
 * Who may read a run, as stored in `ai_runs.requested_by`. A person reads their
 * run whichever credential they use: a session, a personal key or an OAuth
 * grant. A workspace key has no person behind it, so only the same key reads
 * its run.
 */
export function requesterKey(actor: Actor): string {
  switch (actor.kind) {
    case 'session':
    case 'oauth':
    case 'oauth_connection':
      return `user:${actor.userId}`
    case 'api_key':
      return actor.userId === null ? `api_key:${actor.apiKeyId}` : `user:${actor.userId}`
  }
}

/**
 * The scopes a run's reader must hold, from the credential that started it
 * (`ai_runs.requested_scopes`). Null for a session or a key with full access,
 * which reach everything.
 */
export function startingScopes(actor: Actor): readonly ApiKeyScope[] | null {
  return actor.kind !== 'session' && isScopedCredential(actor) ? [...actor.scopes] : null
}

const storedScopesSchema = z.array(z.enum(API_KEY_SCOPES))

/**
 * Whether `reader` may see what a run started with `starting` read.
 *
 * The result holds records the run read with the starter's scopes. A person
 * may read their run with another credential, but only one that reaches at
 * least as far: otherwise a narrow key of theirs would see, through the run,
 * records it cannot read directly. A session or a full-access key reads
 * every run. A scoped reader needs every scope the starter held; a run a
 * session or a full-access key started needs an unscoped reader. A stored
 * value that does not parse counts as covering nothing.
 */
export function readerCovers(reader: Actor, starting: readonly string[] | null): boolean {
  if (reader.kind === 'session' || !isScopedCredential(reader)) return true
  if (starting === null) return false
  if (isOAuthActor(reader) && reader.scopes.length === 0) return false

  const parsed = storedScopesSchema.safeParse(starting)
  if (!parsed.success) return false

  return [...expandApiKeyScopes(parsed.data)].every((scope) => satisfiesApiKeyScope(reader.scopes, scope))
}

export type ResolvedCaller =
  | { readonly ok: true; readonly actor: Actor }
  | { readonly ok: false; readonly reason: string }

const LEFT_WORKSPACE = 'The person who started this run is no longer a member of the workspace'
const SESSION_ENDED = 'The session that started this run has ended.'
const KEY_GONE = 'The API key that started this run was deleted'
const GRANT_GONE = 'The OAuth access that started this run was revoked'

/**
 * The actor a run acts as at job start, or why there is none.
 *
 * Built from the same lookups request-time credential resolution makes
 * (`modules/auth/credentials.ts`): the live session, the membership row by
 * workspace and user, the key row, the grant row. They are core's repository functions, the
 * existing port for these questions. There is no service in the module
 * context that answers "is this user a member, and with what role" without
 * already holding an actor for them, and the `workspace_members_list` tool
 * needs an actor that is a member to answer at all. So the job decides on the
 * same rows a fresh request would, and a member removed since the start, a
 * session signed out or expired since, or a key or grant revoked since, makes
 * no model call.
 */
export async function resolveStoredCaller(
  db: Queryable,
  workspaceId: string,
  caller: StoredCaller,
  now: Date,
): Promise<ResolvedCaller> {
  switch (caller.kind) {
    case 'session': {
      const session = await authRepository.findLiveSessionById(db, caller.session_id, caller.user_id, now)
      if (session === undefined) return { ok: false, reason: SESSION_ENDED }

      const membership = await memberOf(db, workspaceId, caller.user_id)
      if (membership === undefined) return { ok: false, reason: LEFT_WORKSPACE }

      return {
        ok: true,
        actor: {
          kind: 'session',
          userId: caller.user_id,
          sessionId: caller.session_id,
          workspaceId,
          role: membership.role,
          memberId: membership.memberId,
        },
      }
    }
    case 'api_key': {
      const key = await apiKeyRepository.findApiKey(db, workspaceId, caller.api_key_id)
      if (key === undefined) return { ok: false, reason: KEY_GONE }

      if (caller.user_id === null) {
        return {
          ok: true,
          actor: {
            kind: 'api_key',
            apiKeyId: caller.api_key_id,
            userId: null,
            workspaceId,
            role: caller.role,
            scopes: caller.scopes,
            memberId: null,
          },
        }
      }

      const membership = await memberOf(db, workspaceId, caller.user_id)
      if (membership === undefined) return { ok: false, reason: LEFT_WORKSPACE }

      return {
        ok: true,
        actor: {
          kind: 'api_key',
          apiKeyId: caller.api_key_id,
          userId: caller.user_id,
          workspaceId,
          role: membership.role,
          scopes: caller.scopes,
          memberId: membership.memberId,
        },
      }
    }
    case 'oauth': {
      const grant = await oauthRepository.findGrant(db, caller.grant_id)
      if (grant === undefined || grant.workspaceId !== workspaceId || grant.userId !== caller.user_id) {
        return { ok: false, reason: GRANT_GONE }
      }

      const membership = await memberOf(db, workspaceId, caller.user_id)
      if (membership === undefined) return { ok: false, reason: LEFT_WORKSPACE }

      return {
        ok: true,
        actor: {
          kind: 'oauth',
          grantId: caller.grant_id,
          connectionId: caller.connection_id,
          clientId: caller.client_id,
          userId: caller.user_id,
          workspaceId,
          role: membership.role,
          scopes: caller.scopes,
          memberId: membership.memberId,
        },
      }
    }
  }
}

async function memberOf(
  db: Queryable,
  workspaceId: string,
  userId: string,
): Promise<{ readonly memberId: string; readonly role: MemberRole } | undefined> {
  const membership = await authRepository.findMembership(db, workspaceId, userId)
  if (membership === undefined) return undefined

  const role = parseMemberRole(membership.role)
  if (role === undefined) {
    throw new Error(`workspace_members.role holds "${membership.role}", which its check constraint forbids`)
  }

  return { memberId: membership.id, role }
}
