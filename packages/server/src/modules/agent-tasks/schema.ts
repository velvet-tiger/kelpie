import { sql } from 'drizzle-orm'
import { check, index, pgTable, text } from 'drizzle-orm/pg-core'

import { createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * Agents the workspace has registered to receive task dispatches. Kelpie bundles
 * no AI; these are the customer's own agents.
 */
export const agentRegistrations = pgTable(
  'agent_registrations',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    endpoint: text('endpoint').notNull(),
    authHeaderEncrypted: text('auth_header_encrypted'),
    lastRunAt: moment('last_run_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('agent_registrations_workspace_idx').on(table.workspaceId)],
)

/**
 * `task_id` is a catalog string, not a foreign key: the task catalog ships in
 * code, so a run outlives any catalog edit.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentRegistrations.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    status: text('status').notNull().default('queued'),
    prompt: text('prompt').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('agent_runs_workspace_idx').on(table.workspaceId),
    index('agent_runs_agent_idx').on(table.agentId),
    check(
      'agent_runs_status_check',
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed')`,
    ),
  ],
)
