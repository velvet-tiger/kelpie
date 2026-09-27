import type { IdFactory } from '../../lib/ids.ts'
import { and, eq, isNotNull } from 'drizzle-orm'

import { agentRegistrations } from '../agent-tasks/schema.ts'
import type { Queryable } from '../../runtime/transaction.ts'

/**
 * The one file that writes core's `agent_registrations`.
 *
 * The module's agent shows up in the workspace's Run dialog exactly like any
 * customer-registered agent: as a row in that table, named for the install's
 * AI service (`AI_SERVICE_LABELS`): "Kelpie AI" or "Custom provider". The row is marked
 * `managed_by = 'ai'`, and that is what routes a run to this module: core's
 * agent-tasks engine calls the dispatcher this module provides
 * (`context.agentDispatch`) in-process, and never reads the row's endpoint or
 * auth header. Core also refuses `PATCH` and `DELETE /v1/agents/:id` on the
 * row, and the MCP page links to `settings_path` in place of Remove.
 *
 * The row is found by `managed_by`, never by name, so an admin's own agent
 * with the same name is left alone. An upsert also renames the row, so an
 * install that changes its service renames the row on the next save. Core's partial unique index on
 * `(workspace_id, managed_by)` makes the write a single upsert.
 */

/** This module's id, written to `managed_by`. Matches `id` in `index.ts`. */
export const AI_MODULE_ID = 'ai'

/** The admin page that configures the row, written to `settings_path`. */
export const AI_SETTINGS_PATH = '/admin/ai'

/**
 * What the row's required `endpoint` column holds. Not a URL anything calls:
 * dispatch is in-process. It says so to a reader of the table, and an upsert
 * overwrites the loopback URL an older version of this module stored.
 */
export const AI_AGENT_ENDPOINT = `module:${AI_MODULE_ID}`

export async function ensureKelpieRegistration(
  db: Queryable,
  createId: IdFactory,
  workspaceId: string,
  name: string,
  now: Date,
): Promise<void> {
  await db
    .insert(agentRegistrations)
    .values({
      // The `ag_<ulid>` prefix is core's, from its own `idPrefixes`; the row is
      // indistinguishable from one core would have inserted.
      id: createId('agentRegistration'),
      workspaceId,
      name,
      endpoint: AI_AGENT_ENDPOINT,
      authHeaderEncrypted: null,
      managedBy: AI_MODULE_ID,
      settingsPath: AI_SETTINGS_PATH,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [agentRegistrations.workspaceId, agentRegistrations.managedBy],
      // Names the partial index: its predicate must match for Postgres to use it.
      targetWhere: isNotNull(agentRegistrations.managedBy),
      set: {
        name,
        endpoint: AI_AGENT_ENDPOINT,
        authHeaderEncrypted: null,
        settingsPath: AI_SETTINGS_PATH,
        updatedAt: now,
      },
    })
}

export async function removeKelpieRegistration(
  db: Queryable,
  workspaceId: string,
): Promise<void> {
  await db
    .delete(agentRegistrations)
    .where(
      and(
        eq(agentRegistrations.workspaceId, workspaceId),
        eq(agentRegistrations.managedBy, AI_MODULE_ID),
      ),
    )
}
