import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { citext, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { users } from '../auth/schema.ts'

/**
 * Workspaces and membership. Deleting a workspace cascades everything it owns,
 * which is what every other table's `workspace_id` reference relies on.
 */

export const workspaces = pgTable('workspaces', {
  id: primaryId(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull(),
  tagline: text('tagline'),
  oneLiner: text('one_liner'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    joinedAt: moment('joined_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('workspace_members_workspace_user_key').on(table.workspaceId, table.userId),
    index('workspace_members_workspace_idx').on(table.workspaceId),
    check('workspace_members_role_check', sql`${table.role} in ('owner', 'admin', 'member')`),
  ],
)

export const invites = pgTable(
  'invites',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    role: text('role').notNull(),
    invitedBy: text('invited_by').references(() => workspaceMembers.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: moment('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('invites_workspace_idx').on(table.workspaceId),
    check('invites_role_check', sql`${table.role} in ('admin', 'member')`),
    check('invites_status_check', sql`${table.status} in ('pending', 'expired')`),
  ],
)

/**
 * A workspace's own choice for one toggleable module (`modules.md`). No row
 * means enabled: the default every module ships with, and the state a
 * workspace that has never opened the settings screen is in.
 *
 * `module_id` is not a foreign key. The modules a deploy ships with live in
 * `apps/kelpie/kelpie.config.ts`, not a database table, so there is nothing
 * here to reference; `runtime/moduleConfig.ts` is what rejects an unknown id.
 */
export const workspaceModuleSettings = pgTable(
  'workspace_module_settings',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    enabled: boolean('enabled').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('workspace_module_settings_workspace_module_key').on(table.workspaceId, table.moduleId),
    index('workspace_module_settings_workspace_idx').on(table.workspaceId),
  ],
)

/** What a replayed `Idempotency-Key` request gets back instead of re-executing. */
export interface StoredIdempotentResponse {
  readonly status: number
  readonly body: unknown
}

/**
 * Replayed `Idempotency-Key` requests return the stored response instead of
 * re-executing (`api.md`). Workspace-scoped because a key is only meaningful
 * within the workspace whose credentials sent it.
 *
 * `response` is nullable: the middleware reserves the row (inserts it with a
 * null response) before running the handler, so a concurrent replay of the
 * same key can see the request is in flight and answer `409` instead of
 * running the handler twice. It is filled in once the handler returns.
 *
 * `id` follows the `<prefix>_<ulid>` convention (`idem`, `lib/ids.ts`) for
 * consistency with every other table, but it is never returned by any
 * endpoint — this table has no routes of its own — so it does not appear in
 * `api.md`'s public prefix table.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').$type<StoredIdempotentResponse>(),
    expiresAt: moment('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique('idempotency_keys_workspace_key_key').on(table.workspaceId, table.key)],
)
