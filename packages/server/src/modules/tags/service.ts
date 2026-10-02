import { TAG_TARGET_TYPES } from '@kelpie/schemas'
import type { TagTargetType } from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { listTags } from './repository.ts'
import type { TagRow } from './repository.ts'

/** How many tags come back when the caller does not say. Enough for one dropdown. */
export const DEFAULT_TAG_LIMIT = 20

/** The longest `?q=` accepted. A tag longer than this is not one a person types. */
export const MAX_TAG_TERM_LENGTH = 100

export interface TagRequest {
  /** Absent or empty means every taggable type. */
  readonly targetTypes?: readonly TagTargetType[] | undefined
  readonly term?: string | undefined
  readonly limit?: number | undefined
}

export interface TagResults {
  readonly query: string | null
  readonly limit: number
  readonly tags: readonly TagRow[]
}

export interface TagsService {
  list(actor: Actor, request: TagRequest): Promise<TagResults>
}

export interface TagsServiceDependencies {
  readonly db: Database
}

export function createTagsService(dependencies: TagsServiceDependencies): TagsService {
  return {
    async list(actor: Actor, request: TagRequest): Promise<TagResults> {
      const workspaceId = requireWorkspaceId(actor)
      const limit = request.limit ?? DEFAULT_TAG_LIMIT
      const trimmed = request.term?.trim() ?? ''
      const term = trimmed.length === 0 ? null : trimmed
      const targetTypes =
        request.targetTypes === undefined || request.targetTypes.length === 0
          ? TAG_TARGET_TYPES
          : request.targetTypes

      const tags = await listTags(dependencies.db, { workspaceId, targetTypes, term, limit })

      return { query: term, limit, tags }
    },
  }
}
