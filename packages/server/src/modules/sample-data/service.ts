import { and, count, eq, inArray } from 'drizzle-orm'

import { toEventActor } from '../../lib/actor.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import * as authRepository from '../auth/repository.ts'
import { companies } from '../companies/schema.ts'
import { dealPeople, deals } from '../deals/schema.ts'
import { candidates, roles } from '../hiring/schema.ts'
import { notes } from '../notes/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnershipPeople, partnerships } from '../partnerships/schema.ts'
import { people } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { planItems } from '../plans/schema.ts'
import { positions } from '../positions/schema.ts'
import { raisePeople, raises } from '../raises/schema.ts'
import { parseMemberRole, roleAllows } from '../workspace/roles.ts'
import { SAMPLE_DATA_FIXTURE } from './fixture.ts'
import type { Fixture } from './fixture.ts'

/**
 * Installs the sample workspace, in one transaction.
 *
 * The whole seed is one write. A failure part-way through rolls the whole
 * thing back, so a workspace never ends up with half of it.
 *
 * Idempotent by refusal: a workspace that already holds any companies or
 * people gets a 409. Installing twice would double the fixture, which is not
 * what an "install once" button says.
 */

export interface SampleDataDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
}

export interface SampleDataCounts {
  readonly companies: number
  readonly people: number
  readonly positions: number
  readonly deals: number
  readonly planItems: number
  readonly notes: number
  readonly opportunities: number
  readonly raises: number
  readonly partnerships: number
  readonly roles: number
  readonly candidates: number
}

export interface SampleDataService {
  install(actor: Actor, workspaceId: string): Promise<SampleDataCounts>
}

export function createSampleDataService(dependencies: SampleDataDependencies): SampleDataService {
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
    async install(actor, workspaceId) {
      // The path parameter must match the actor's workspace, and it must be an
      // admin. `requireWorkspaceId` is what CRM endpoints call to reject an
      // actor with no workspace at all.
      requireWorkspaceId(actor)
      await requireAdmin(actor, workspaceId)

      const fixture = SAMPLE_DATA_FIXTURE

      return dependencies.transaction(
        async ({ tx }) => {
          const [companiesTally] = await tx
            .select({ value: count() })
            .from(companies)
            .where(eq(companies.workspaceId, workspaceId))

          const [peopleTally] = await tx
            .select({ value: count() })
            .from(people)
            .where(eq(people.workspaceId, workspaceId))

          const alreadyHasData =
            (companiesTally?.value ?? 0) > 0 || (peopleTally?.value ?? 0) > 0

          if (alreadyHasData) {
            throw AppError.conflict('This workspace already has CRM data')
          }

          // Every stage this workspace carries, grouped by kind so a deal, an
          // opportunity, a raise and a partnership all resolve their fixture
          // stage slugs against the same read.
          const allStages = await tx
            .select({
              id: pipelineStages.id,
              slug: pipelineStages.slug,
              kind: pipelineStages.kind,
            })
            .from(pipelineStages)
            .where(
              and(
                eq(pipelineStages.workspaceId, workspaceId),
                inArray(pipelineStages.kind, ['deal', 'opportunity', 'raise', 'partnership']),
              ),
            )

          const stageIdByKindAndSlug = new Map<string, string>()

          for (const row of allStages) {
            stageIdByKindAndSlug.set(stageLookupKey(row.kind, row.slug), row.id)
          }

          const now = dependencies.now()
          const companyIds = new Map<string, string>()
          const personIds = new Map<string, string>()
          const dealIds = new Map<string, string>()
          const opportunityIds = new Map<string, string>()
          const raiseIds = new Map<string, string>()
          const partnershipIds = new Map<string, string>()
          const roleIds = new Map<string, string>()
          const candidateIds = new Map<string, string>()

          for (const record of fixture.companies) {
            const id = dependencies.createId('company')
            companyIds.set(record.key, id)

            await tx.insert(companies).values({
              id,
              workspaceId,
              name: record.name,
              domain: record.domain,
              industry: record.industry,
              description: record.description,
              stage: record.stage,
              sizeBand: record.sizeBand,
              hq: record.hq,
              website: record.website,
              accountType: record.accountType,
              icpFit: record.icpFit,
              techStack: [...record.techStack],
              summary: record.summary,
              tags: [...record.tags],
              createdAt: now,
              updatedAt: now,
            })
          }

          for (const record of fixture.people) {
            const id = dependencies.createId('person')
            personIds.set(record.key, id)

            await tx.insert(people).values({
              id,
              workspaceId,
              name: record.name,
              email: record.email,
              location: record.location,
              preferredChannel: record.preferredChannel,
              influence: record.influence,
              relationship: record.relationship,
              summary: record.summary,
              tags: [...record.tags],
              createdAt: now,
              updatedAt: now,
            })
          }

          for (const record of fixture.positions) {
            const personId = personIds.get(record.personKey)
            const companyId = companyIds.get(record.companyKey)

            if (personId === undefined || companyId === undefined) {
              throw new Error(
                `Sample position links unknown keys: person=${record.personKey}, company=${record.companyKey}`,
              )
            }

            await tx.insert(positions).values({
              id: dependencies.createId('position'),
              workspaceId,
              personId,
              companyId,
              title: record.title,
              createdAt: now,
              updatedAt: now,
            })
          }

          for (const record of fixture.deals) {
            const stageId = stageIdByKindAndSlug.get(stageLookupKey('deal', record.stageSlug))
            const companyId = companyIds.get(record.companyKey)

            if (stageId === undefined) {
              throw new Error(
                `Sample deal "${record.name}" names stage "${record.stageSlug}", which this workspace's deal pipeline does not carry`,
              )
            }

            if (companyId === undefined) {
              throw new Error(
                `Sample deal "${record.name}" names unknown company "${record.companyKey}"`,
              )
            }

            const id = dependencies.createId('deal')
            dealIds.set(record.key, id)

            await tx.insert(deals).values({
              id,
              workspaceId,
              name: record.name,
              companyId,
              stageId,
              valueCents: record.valueCents,
              currency: record.currency,
              expectedClose: record.expectedClose,
              competitors: [],
              risks: record.risks,
              whyWin: record.whyWin,
              summary: record.summary,
              tags: [...record.tags],
              createdAt: now,
              updatedAt: now,
            })

            for (const personKey of record.peopleKeys) {
              const personId = personIds.get(personKey)

              if (personId === undefined) {
                throw new Error(
                  `Sample deal "${record.name}" names unknown person "${personKey}"`,
                )
              }

              await tx.insert(dealPeople).values({ dealId: id, personId })
            }
          }

          for (const record of fixture.opportunities) {
            const stageId = stageIdByKindAndSlug.get(
              stageLookupKey('opportunity', record.stageSlug),
            )

            if (stageId === undefined) {
              throw new Error(
                `Sample opportunity "${record.name}" names stage "${record.stageSlug}", which this workspace's opportunity pipeline does not carry`,
              )
            }

            const companyId =
              record.companyKey === null ? null : (companyIds.get(record.companyKey) ?? undefined)

            if (companyId === undefined) {
              throw new Error(
                `Sample opportunity "${record.name}" names unknown company "${String(record.companyKey)}"`,
              )
            }

            const id = dependencies.createId('opportunity')
            opportunityIds.set(record.key, id)

            await tx.insert(opportunities).values({
              id,
              workspaceId,
              name: record.name,
              kind: record.kind,
              stageId,
              companyId,
              expectedClose: record.expectedClose,
              summary: record.summary,
              tags: [...record.tags],
              createdAt: now,
              updatedAt: now,
            })
          }

          for (const record of fixture.raises) {
            const stageId = stageIdByKindAndSlug.get(stageLookupKey('raise', record.stageSlug))
            const companyId = companyIds.get(record.companyKey)

            if (stageId === undefined) {
              throw new Error(
                `Sample raise "${record.name}" names stage "${record.stageSlug}", which this workspace's raise pipeline does not carry`,
              )
            }

            if (companyId === undefined) {
              throw new Error(
                `Sample raise "${record.name}" names unknown company "${record.companyKey}"`,
              )
            }

            const id = dependencies.createId('raise')
            raiseIds.set(record.key, id)

            await tx.insert(raises).values({
              id,
              workspaceId,
              name: record.name,
              companyId,
              stageId,
              checkSizeCents: record.checkSizeCents,
              currency: record.currency,
              thesisFit: record.thesisFit,
              expectedClose: record.expectedClose,
              summary: record.summary,
              tags: [...record.tags],
              createdAt: now,
              updatedAt: now,
            })

            for (const personKey of record.peopleKeys) {
              const personId = personIds.get(personKey)

              if (personId === undefined) {
                throw new Error(
                  `Sample raise "${record.name}" names unknown person "${personKey}"`,
                )
              }

              await tx.insert(raisePeople).values({ raiseId: id, personId })
            }
          }

          for (const record of fixture.partnerships) {
            const stageId = stageIdByKindAndSlug.get(
              stageLookupKey('partnership', record.stageSlug),
            )
            const companyId = companyIds.get(record.companyKey)

            if (stageId === undefined) {
              throw new Error(
                `Sample partnership "${record.name}" names stage "${record.stageSlug}", which this workspace's partnership pipeline does not carry`,
              )
            }

            if (companyId === undefined) {
              throw new Error(
                `Sample partnership "${record.name}" names unknown company "${record.companyKey}"`,
              )
            }

            const id = dependencies.createId('partnership')
            partnershipIds.set(record.key, id)

            await tx.insert(partnerships).values({
              id,
              workspaceId,
              name: record.name,
              companyId,
              stageId,
              kind: record.kind,
              nextTouchpoint: record.nextTouchpoint,
              goals: record.goals,
              successLooksLike: record.successLooksLike,
              summary: record.summary,
              tags: [...record.tags],
              createdAt: now,
              updatedAt: now,
            })

            for (const personKey of record.peopleKeys) {
              const personId = personIds.get(personKey)

              if (personId === undefined) {
                throw new Error(
                  `Sample partnership "${record.name}" names unknown person "${personKey}"`,
                )
              }

              await tx.insert(partnershipPeople).values({ partnershipId: id, personId })
            }
          }

          for (const record of fixture.roles) {
            const id = dependencies.createId('role')
            roleIds.set(record.key, id)

            await tx.insert(roles).values({
              id,
              workspaceId,
              title: record.title,
              status: record.status,
              createdAt: now,
              updatedAt: now,
            })
          }

          for (const record of fixture.candidates) {
            const roleId = roleIds.get(record.roleKey)
            const personId = personIds.get(record.personKey)
            const referrerPersonId =
              record.referrerPersonKey === null
                ? null
                : (personIds.get(record.referrerPersonKey) ?? undefined)

            if (roleId === undefined) {
              throw new Error(
                `Sample candidate "${record.key}" names unknown role "${record.roleKey}"`,
              )
            }

            if (personId === undefined) {
              throw new Error(
                `Sample candidate "${record.key}" names unknown person "${record.personKey}"`,
              )
            }

            if (referrerPersonId === undefined) {
              throw new Error(
                `Sample candidate "${record.key}" names unknown referrer "${String(record.referrerPersonKey)}"`,
              )
            }

            const id = dependencies.createId('candidate')
            candidateIds.set(record.key, id)

            await tx.insert(candidates).values({
              id,
              workspaceId,
              roleId,
              personId,
              status: record.status,
              // The interview_stage column carries a value only while the
              // candidate is in process. Every other status clears it, which
              // the service does the same way `hiring` does for a PATCH.
              interviewStage: record.status === 'in_process' ? record.interviewStage : null,
              referrerPersonId,
              createdAt: now,
              updatedAt: now,
            })
          }

          for (const record of fixture.plans) {
            const dealId = dealIds.get(record.targetDealKey)

            if (dealId === undefined) {
              throw new Error(
                `Sample plan item "${record.title}" names unknown deal "${record.targetDealKey}"`,
              )
            }

            await tx.insert(planItems).values({
              id: dependencies.createId('planItem'),
              workspaceId,
              targetType: record.targetType,
              targetId: dealId,
              date: record.date,
              title: record.title,
              status: record.status,
              createdAt: now,
              updatedAt: now,
            })
          }

          for (const record of fixture.notes) {
            const targetId = resolveNoteTargetId(record.targetType, record.targetKey, {
              companyIds,
              personIds,
              dealIds,
              opportunityIds,
              raiseIds,
              partnershipIds,
              candidateIds,
            })

            if (targetId === undefined) {
              throw new Error(
                `Sample note names unknown ${record.targetType} "${record.targetKey}"`,
              )
            }

            await tx.insert(notes).values({
              id: dependencies.createId('note'),
              workspaceId,
              targetType: record.targetType,
              targetId,
              body: record.body,
              pinned: record.pinned,
              createdAt: now,
              updatedAt: now,
            })
          }

          return countsFor(fixture)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },
  }
}

interface KeyMaps {
  readonly companyIds: ReadonlyMap<string, string>
  readonly personIds: ReadonlyMap<string, string>
  readonly dealIds: ReadonlyMap<string, string>
  readonly opportunityIds: ReadonlyMap<string, string>
  readonly raiseIds: ReadonlyMap<string, string>
  readonly partnershipIds: ReadonlyMap<string, string>
  readonly candidateIds: ReadonlyMap<string, string>
}

function resolveNoteTargetId(
  targetType: string,
  targetKey: string,
  maps: KeyMaps,
): string | undefined {
  switch (targetType) {
    case 'company':
      return maps.companyIds.get(targetKey)
    case 'person':
      return maps.personIds.get(targetKey)
    case 'deal':
      return maps.dealIds.get(targetKey)
    case 'opportunity':
      return maps.opportunityIds.get(targetKey)
    case 'raise':
      return maps.raiseIds.get(targetKey)
    case 'partnership':
      return maps.partnershipIds.get(targetKey)
    case 'candidate':
      return maps.candidateIds.get(targetKey)
    default:
      // A new RECORD_TARGET_TYPES value in the fixture requires a case here;
      // falling through silently would drop a note on the floor.
      return undefined
  }
}

/**
 * The lookup key `stageIdByKindAndSlug` uses. A slug is only unique per kind
 * (`won` is a stage in both `deal` and `opportunity`), so the map is keyed by
 * both fields joined.
 */
function stageLookupKey(kind: string, slug: string): string {
  return `${kind}::${slug}`
}

function countsFor(fixture: Fixture): SampleDataCounts {
  return {
    companies: fixture.companies.length,
    people: fixture.people.length,
    positions: fixture.positions.length,
    deals: fixture.deals.length,
    planItems: fixture.plans.length,
    notes: fixture.notes.length,
    opportunities: fixture.opportunities.length,
    raises: fixture.raises.length,
    partnerships: fixture.partnerships.length,
    roles: fixture.roles.length,
    candidates: fixture.candidates.length,
  }
}
