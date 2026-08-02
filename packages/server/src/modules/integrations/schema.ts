import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { users } from '../auth/schema.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * Core owns the connection lifecycle; the provider itself ships as a module and
 * declares `provider_id`. Module-owned provider tables reference this row.
 *
 * `user_id` is set for personal connections such as a Gmail mailbox, null for
 * workspace-wide ones.
 */
export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    config: jsonb('config').notNull().default({}),
    secretsEncrypted: text('secrets_encrypted'),
    lastSyncAt: moment('last_sync_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('integration_connections_workspace_idx').on(table.workspaceId)],
)
