import type { AgentRunStatus } from '@kelpie/schemas'
import { and, eq } from 'drizzle-orm'

import { keysetCondition, orderByWindow, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { agentRegistrations, agentRuns } from './schema.ts'

export type AgentRecord = typeof agentRegistrations.$inferSelect
export type AgentColumns = typeof agentRegistrations.$inferInsert
export type RunRecord = typeof agentRuns.$inferSelect
export type RunColumns = typeof agentRuns.$inferInsert

export const AGENT_SORTS: SortableFields<AgentRecord> = {
  created_at: timestampSort(agentRegistrations.createdAt, (agent) => agent.createdAt),
  updated_at: timestampSort(agentRegistrations.updatedAt, (agent) => agent.updatedAt),
}

export const DEFAULT_AGENT_SORT = '-created_at'

export const RUN_SORTS: SortableFields<RunRecord> = {
  created_at: timestampSort(agentRuns.createdAt, (run) => run.createdAt),
}

/** Newest first: a run log is read to find out what just happened. */
export const DEFAULT_RUN_SORT = '-created_at'

export interface RunFilters {
  readonly agentId?: string | undefined
  readonly status?: AgentRunStatus | undefined
}

export function listAgents(
  db: Queryable,
  workspaceId: string,
  window: ListWindow<AgentRecord>,
): Promise<AgentRecord[]> {
  return db
    .select()
    .from(agentRegistrations)
    .where(
      and(eq(agentRegistrations.workspaceId, workspaceId), keysetCondition(window, agentRegistrations.id)),
    )
    .orderBy(...orderByWindow(window, agentRegistrations.id))
    .limit(window.fetchLimit)
}

export async function findAgent(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<AgentRecord | undefined> {
  const [found] = await db
    .select()
    .from(agentRegistrations)
    .where(and(eq(agentRegistrations.workspaceId, workspaceId), eq(agentRegistrations.id, id)))
    .limit(1)

  return found
}

export async function insertAgent(db: Queryable, values: AgentColumns): Promise<AgentRecord> {
  const [created] = await db.insert(agentRegistrations).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting agent registration ${values.id} returned no row`)
  }

  return created
}

export async function updateAgent(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<AgentColumns>,
): Promise<AgentRecord | undefined> {
  const [updated] = await db
    .update(agentRegistrations)
    .set(changes)
    .where(and(eq(agentRegistrations.workspaceId, workspaceId), eq(agentRegistrations.id, id)))
    .returning()

  return updated
}

export async function deleteAgent(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(agentRegistrations)
    .where(and(eq(agentRegistrations.workspaceId, workspaceId), eq(agentRegistrations.id, id)))
    .returning({ id: agentRegistrations.id })

  return deleted.length
}

export function listRuns(
  db: Queryable,
  workspaceId: string,
  filters: RunFilters,
  window: ListWindow<RunRecord>,
): Promise<RunRecord[]> {
  return db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        filters.agentId === undefined ? undefined : eq(agentRuns.agentId, filters.agentId),
        filters.status === undefined ? undefined : eq(agentRuns.status, filters.status),
        keysetCondition(window, agentRuns.id),
      ),
    )
    .orderBy(...orderByWindow(window, agentRuns.id))
    .limit(window.fetchLimit)
}

export async function findRun(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<RunRecord | undefined> {
  const [found] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.id, id)))
    .limit(1)

  return found
}

export async function insertRun(db: Queryable, values: RunColumns): Promise<RunRecord> {
  const [created] = await db.insert(agentRuns).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting agent run ${values.id} returned no row`)
  }

  return created
}

/**
 * Moves a run through its dispatch lifecycle. By id alone, like the delivery
 * engine's status write: only the dispatcher calls this, and it holds the row
 * it just inserted.
 */
export async function updateRun(
  db: Queryable,
  id: string,
  changes: Partial<RunColumns>,
): Promise<void> {
  await db.update(agentRuns).set(changes).where(eq(agentRuns.id, id))
}
