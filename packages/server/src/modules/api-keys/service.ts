import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { Actor } from '../auth/actor.ts'
import { roleAllows } from '../workspace/roles.ts'
import { mintKey } from './keys.ts'
import type { KeyKind } from './keys.ts'
import * as repository from './repository.ts'

/**
 * API key management.
 *
 * A workspace key belongs to the workspace and needs admin authority to create or
 * revoke. A personal key belongs to one member and is theirs alone: admins can
 * see that it exists but cannot use or manage it.
 */

export interface ApiKeyDependencies {
  readonly db: Database
  readonly createId: IdFactory
  readonly now: () => Date
  /** Injected only so tests can pin secrets. Production uses the crypto default. */
  readonly newToken?: () => string
}

export interface ApiKeyView {
  readonly id: string
  readonly name: string
  readonly kind: KeyKind
  readonly displayPrefix: string
  readonly lastUsedAt: Date | null
  readonly createdAt: Date
}

/** The one response that ever carries the secret. */
export interface MintedApiKey extends ApiKeyView {
  readonly secret: string
}

export interface ApiKeyService {
  create(actor: Actor, name: string, kind: KeyKind): Promise<MintedApiKey>
  list(actor: Actor, kind: KeyKind): Promise<readonly ApiKeyView[]>
  revoke(actor: Actor, id: string): Promise<void>
}

function toView(record: repository.ApiKeyRecord): ApiKeyView {
  return {
    id: record.id,
    name: record.name,
    kind: record.userId === null ? 'workspace' : 'personal',
    displayPrefix: record.displayPrefix,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
  }
}

export function createApiKeyService(dependencies: ApiKeyDependencies): ApiKeyService {
  /**
   * Keys are always workspace-bound, so an actor with no workspace cannot have
   * any. That is the state between signup and the first workspace create.
   */
  function requireWorkspace(actor: Actor): string {
    if (actor.workspaceId === null) {
      throw new AppError('forbidden', 'Create a workspace before creating API keys')
    }

    return actor.workspaceId
  }

  /**
   * Reads the role off the actor rather than re-querying the membership.
   * `credentials.ts` resolves it from the live `workspace_members` row on every
   * request, so it is already as fresh as a query here would be. A workspace key
   * has no member row and carries `admin` by definition.
   *
   * `role` is null only for a session with no membership, which `requireWorkspace`
   * has already refused: a session's workspace comes from that same row.
   */
  function requireAdmin(actor: Actor): void {
    if (actor.role === null || !roleAllows(actor.role, 'admin')) {
      throw new AppError('forbidden', 'This action needs the admin role')
    }
  }

  /** A personal key needs a person. A workspace key cannot mint or manage one. */
  function requireUser(actor: Actor): string {
    if (actor.userId === null) {
      throw new AppError('forbidden', 'A personal key belongs to a user, and this caller is not one')
    }

    return actor.userId
  }

  return {
    async create(actor, name, kind) {
      const workspaceId = requireWorkspace(actor)
      const userId = kind === 'workspace' ? null : requireUser(actor)

      if (kind === 'workspace') {
        requireAdmin(actor)
      }

      const minted = mintKey(kind, dependencies.newToken)
      const record = await repository.insertApiKey(dependencies.db, {
        id: dependencies.createId('apiKey'),
        workspaceId,
        userId,
        name,
        secretHash: minted.secretHash,
        displayPrefix: minted.displayPrefix,
      })

      // The only time the secret leaves this process. Nothing stores it.
      return { ...toView(record), secret: minted.secret }
    },

    async list(actor, kind) {
      const workspaceId = requireWorkspace(actor)

      if (kind === 'workspace') {
        requireAdmin(actor)

        return (await repository.listWorkspaceKeys(dependencies.db, workspaceId)).map(toView)
      }

      const records = await repository.listPersonalKeys(dependencies.db, workspaceId, requireUser(actor))

      return records.map(toView)
    },

    async revoke(actor, id) {
      const workspaceId = requireWorkspace(actor)
      const record = await repository.findApiKey(dependencies.db, workspaceId, id)

      // A key in another workspace is indistinguishable from one that never
      // existed, per `api.md`.
      if (record === undefined) {
        throw AppError.notFound('API key not found')
      }

      if (record.userId === null) {
        requireAdmin(actor)
      } else if (record.userId !== actor.userId) {
        // An admin can see a colleague's personal key exists but cannot revoke it;
        // removing their membership is how you cut off their access.
        throw AppError.notFound('API key not found')
      }

      await repository.deleteApiKey(dependencies.db, workspaceId, id)
    },
  }
}
