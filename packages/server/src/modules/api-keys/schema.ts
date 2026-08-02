import { index, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { users } from '../auth/schema.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * Both kinds of key are bound to one workspace at creation (`api.md`). A null
 * `user_id` is a workspace key; a set one is a personal key acting as that user
 * within that workspace.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    secretHash: text('secret_hash').notNull().unique(),
    displayPrefix: text('display_prefix').notNull(),
    lastUsedAt: moment('last_used_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('api_keys_workspace_idx').on(table.workspaceId)],
)
