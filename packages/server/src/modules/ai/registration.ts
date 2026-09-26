import type { IdFactory } from '../../lib/ids.ts'
import { and, eq, isNotNull } from 'drizzle-orm'

import { agentRegistrations } from '../agent-tasks/schema.ts'
import type { Queryable } from '../../runtime/transaction.ts'

/**
 * The one file that writes core's `agent_registrations`.
 *
 * Kelpie AI shows up in the workspace's Run dialog exactly like any customer-
 * registered agent: as a row in that table with an `endpoint` and a sealed
 * `authorization` header. Core's dispatch engine POSTs to it and opens the
 * header with the same `createSecretCipher(SECRET_ENCRYPTION_KEY)` this
 * module seals with, so no core change is needed to make the loopback work.
 *
 * The row is marked `managed_by = 'ai'`. Core then refuses `PATCH` and
 * `DELETE /v1/agents/:id` on it, and the MCP page links to `settings_path`
 * in place of Remove. The row is found by `managed_by`, never by name, so an
 * admin's own agent called "Kelpie AI" is left alone. Core's partial unique
 * index on `(workspace_id, managed_by)` makes the write a single upsert.
 */

export const KELPIE_AGENT_NAME = 'Kelpie AI'

/** This module's id, written to `managed_by`. Matches `id` in `index.ts`. */
export const AI_MODULE_ID = 'ai'

/** The admin page that configures the row, written to `settings_path`. */
export const AI_SETTINGS_PATH = '/admin/ai'

export interface EnsureRegistrationInput {
  readonly workspaceId: string
  readonly endpoint: string
  /** The header value already sealed with the deployment's cipher. */
  readonly authHeaderEncrypted: string
}

export async function ensureKelpieRegistration(
  db: Queryable,
  createId: IdFactory,
  input: EnsureRegistrationInput,
  now: Date,
): Promise<void> {
  await db
    .insert(agentRegistrations)
    .values({
      // The `ag_<ulid>` prefix is core's, from its own `idPrefixes`; the row is
      // indistinguishable from one core would have inserted.
      id: createId('agentRegistration'),
      workspaceId: input.workspaceId,
      name: KELPIE_AGENT_NAME,
      endpoint: input.endpoint,
      authHeaderEncrypted: input.authHeaderEncrypted,
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
        endpoint: input.endpoint,
        authHeaderEncrypted: input.authHeaderEncrypted,
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
