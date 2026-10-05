import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { citext, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { users } from '../auth/schema.ts'

/**
 * Workspaces and membership. Deleting a workspace cascades everything it owns,
 * which is what every other table's `workspace_id` reference relies on.
 */

export const workspaces = pgTable('workspaces', {
  id: primaryId(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
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
    /**
     * When the invitation email failed for the last time, and why: the mail
     * system refused it for good, or the last retry failed. Both are null
     * while no failure is recorded. A later successful send and a resend set
     * them back to null.
     */
    emailFailedAt: moment('email_failed_at'),
    emailFailure: text('email_failure'),
    /**
     * The number of the newest request to send the invitation email: 0 when
     * the invitation is made, and one more for each resend. Each email job
     * carries the number of its own request. A job whose number is not this
     * one is for an older request: it sends nothing and records nothing.
     */
    emailRequest: integer('email_request').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('invites_workspace_idx').on(table.workspaceId),
    check('invites_role_check', sql`${table.role} in ('admin', 'member')`),
    check('invites_status_check', sql`${table.status} in ('pending', 'expired')`),
    check(
      'invites_email_failure_check',
      sql`(${table.emailFailedAt} is null) = (${table.emailFailure} is null)`,
    ),
  ],
)

/**
 * A workspace's own choice for one toggleable module
 * (`docs/extending/writing-a-module.md`). No row
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
  /**
   * True when the response held a secret and so was not kept. The request ran
   * and must not run again, but there is nothing to replay: `body` is null.
   */
  readonly withheld?: true
}

/**
 * Replayed `Idempotency-Key` requests return the stored response instead of
 * re-executing (`docs/agents/api-and-webhooks.md`). Scoped to the workspace and to the actor, because a
 * key is only meaningful to the credential that sent it.
 *
 * `response` is nullable: the middleware reserves the row (inserts it with a
 * null response) before running the handler, so a concurrent replay of the
 * same key can see the request is in flight and answer `409` instead of
 * running the handler twice. It is filled in once the handler returns.
 *
 * `id` follows the `<prefix>_<ulid>` convention (`idem`, `lib/ids.ts`) for
 * consistency with every other table, but it is never returned by any endpoint —
 * this table has no routes of its own — so it is not one of the public id
 * prefixes.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /**
     * Who sent the request: a user, an API key or an OAuth grant. A key is
     * replayed only to the actor that first sent it. `''` is a row from before
     * the column existed, which no actor matches.
     */
    actorKey: text('actor_key').notNull().default(''),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').$type<StoredIdempotentResponse>(),
    expiresAt: moment('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('idempotency_keys_workspace_actor_key_key').on(table.workspaceId, table.actorKey, table.key),
  ],
)
