import type { Database } from '../lib/database.ts'
import { createIdFactory } from '../lib/ids.ts'
import { users } from '../modules/auth/schema.ts'
import { workspaceMembers, workspaces } from '../modules/workspace/schema.ts'

/**
 * The minimum a workspace-scoped test needs: a user, a workspace, and an owner
 * membership linking them. Everything else in the domain hangs off these.
 */

const createId = createIdFactory()

export interface WorkspaceFixture {
  readonly workspaceId: string
  readonly userId: string
  readonly memberId: string
}

/**
 * @param db Target database, already migrated.
 * @param slug Workspace slug. Unique per workspace, so tests that create two
 *   workspaces must pass different values.
 */
export async function insertWorkspaceFixture(db: Database, slug = 'acme'): Promise<WorkspaceFixture> {
  const userId = createId('user')
  const workspaceId = createId('workspace')
  const memberId = createId('teamMember')

  await db.insert(users).values({
    id: userId,
    email: `${slug}-owner@example.com`,
    name: 'Ada Lovelace',
    passwordHash: 'not-a-real-hash',
  })

  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'Acme',
    slug,
    timezone: 'Australia/Melbourne',
  })

  await db.insert(workspaceMembers).values({
    id: memberId,
    workspaceId,
    userId,
    role: 'owner',
  })

  return { workspaceId, userId, memberId }
}
