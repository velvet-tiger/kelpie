import { and, eq, isNotNull } from 'drizzle-orm'

import { toEventActor } from '../../lib/actor.ts'
import type { Database } from '../../lib/database.ts'
import { autoLinkCompanyByDomain } from '../../lib/emailDomainAutoLink.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import * as authRepository from '../auth/repository.ts'
import { companies } from '../companies/schema.ts'
import { parseMemberRole, roleAllows } from '../workspace/roles.ts'

/**
 * Rebuild every email-domain link across the workspace.
 *
 * Iterates each Company that carries a domain and runs the same sweep the
 * companies service runs on a domain change — every workspace Person whose
 * email is at that domain gets a titleless Position where none exists yet.
 *
 * Idempotent: a follow-up run adds nothing. Add-only, consumer-host-skipping,
 * and workspace-scoped, same as the inline auto-linker.
 *
 * One transaction per Company, not one for the whole sweep. A workspace can
 * carry thousands of Companies, and a single transaction that long would
 * hold row-share locks against every write elsewhere for the whole run.
 */

export interface EmailDomainLinkerDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
}

export interface RelinkCounts {
  /** Companies with a non-null domain that were considered. Consumer hosts are counted but skipped. */
  readonly companiesScanned: number
  /** New Positions the sweep inserted this run. */
  readonly positionsCreated: number
}

export interface EmailDomainLinkerService {
  relink(actor: Actor, workspaceId: string): Promise<RelinkCounts>
}

export function createEmailDomainLinkerService(
  dependencies: EmailDomainLinkerDependencies,
): EmailDomainLinkerService {
  async function requireAdmin(actor: Actor, workspaceId: string): Promise<void> {
    if (actor.workspaceId !== workspaceId) {
      throw AppError.notFound('Workspace not found')
    }

    if (actor.kind === 'api_key' && actor.userId === null) {
      if (!roleAllows(actor.role, 'admin')) {
        throw new AppError('forbidden', 'This action needs the admin role')
      }
      return
    }

    const userId = actor.userId

    if (userId === null) {
      throw AppError.notFound('Workspace not found')
    }

    const membership = await authRepository.findMembership(dependencies.db, workspaceId, userId)

    if (membership === undefined) {
      throw AppError.notFound('Workspace not found')
    }

    const role = parseMemberRole(membership.role)

    if (role === undefined) {
      throw new Error(`workspace_members.role holds "${membership.role}", which its check forbids`)
    }

    if (!roleAllows(role, 'admin')) {
      throw new AppError('forbidden', 'This action needs the admin role')
    }
  }

  return {
    async relink(actor, workspaceId) {
      requireWorkspaceId(actor)
      await requireAdmin(actor, workspaceId)

      // Every workspace Company that carries a domain — the ones the sweep
      // can match against. Pooled read outside the per-company transactions:
      // the work-list is one query, each write opens its own scope.
      const rows = await dependencies.db
        .select()
        .from(companies)
        .where(and(eq(companies.workspaceId, workspaceId), isNotNull(companies.domain)))

      let created = 0

      // One transaction per Company, not one for the whole sweep. A workspace
      // can carry thousands of Companies; a single transaction that long would
      // hold row-share locks against every write elsewhere for the whole run.
      for (const company of rows) {
        const inserted = await dependencies.transaction(
          async ({ tx, events }) =>
            autoLinkCompanyByDomain(tx, events, workspaceId, company, {
              createId: dependencies.createId,
              now: dependencies.now,
              recordActivity: dependencies.recordActivity,
            }),
          { workspaceId, actor: toEventActor(actor) },
        )
        created += inserted.length
      }

      return { companiesScanned: rows.length, positionsCreated: created }
    },
  }
}
