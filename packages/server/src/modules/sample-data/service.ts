import { and, count, eq, inArray } from 'drizzle-orm'

import { toEventActor } from '../../lib/actor.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { moduleCapabilityName } from '../../runtime/moduleConfig.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import * as authRepository from '../auth/repository.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { attendances, eventAssociations, events } from '../events/schema.ts'
import { candidates, roles } from '../hiring/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people, personLinks } from '../people/schema.ts'
import { notes } from '../notes/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { planItems } from '../plans/schema.ts'
import { positions } from '../positions/schema.ts'
import { raises } from '../raises/schema.ts'
import { parseMemberRole, roleAllows } from '../workspace/roles.ts'
import { SAMPLE_DATA_FIXTURE } from './fixture.ts'

/**
 * Installs the sample workspace, in one transaction.
 *
 * The whole seed is one write. A failure part-way through rolls the whole
 * thing back, so a workspace never ends up with half of it.
 *
 * Idempotent by refusal: a workspace that already holds any companies or
 * people gets a 409. Installing twice would double the fixture, which is not
 * what an "install once" button says.
 *
 * A workspace that has switched a toggleable module off (deals, opportunities,
 * raises, partnerships, events) does not get fixture rows for that module.
 * Companies, people, hiring, and enquiries still install.
 */

export interface SampleDataDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly entitlements: EntitlementRegistry
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
  readonly enquiries: number
  readonly roles: number
  readonly candidates: number
  readonly events: number
  readonly attendances: number
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

  async function moduleIsOn(workspaceId: string, moduleId: string): Promise<boolean> {
    const entitlement = await dependencies.entitlements.check(
      workspaceId,
      moduleCapabilityName(moduleId),
    )

    return entitlement.kind === 'flag' ? entitlement.granted : true
  }

  return {
    async install(actor, workspaceId) {
      // The path parameter must match the actor's workspace, and it must be an
      // admin. `requireWorkspaceId` is what CRM endpoints call to reject an
      // actor with no workspace at all.
      requireWorkspaceId(actor)
      await requireAdmin(actor, workspaceId)

      const fixture = SAMPLE_DATA_FIXTURE
      const includeDeals = await moduleIsOn(workspaceId, 'deals')
      const includeOpportunities = await moduleIsOn(workspaceId, 'opportunities')
      const includeRaises = await moduleIsOn(workspaceId, 'raises')
      const includePartnerships = await moduleIsOn(workspaceId, 'partnerships')
      const includeEvents = await moduleIsOn(workspaceId, 'events')

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
                inArray(pipelineStages.kind, [
                  'deal',
                  'opportunity',
                  'raise',
                  'partnership',
                  'enquiry',
                ]),
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
          const enquiryIds = new Map<string, string>()
          const roleIds = new Map<string, string>()
          const candidateIds = new Map<string, string>()
          let planItemCount = 0
          let notesWritten = 0
          let eventCount = 0
          let attendanceCount = 0

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
              firstName: record.firstName,
              lastName: record.lastName,
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

          if (includeDeals) {
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

              await tx.insert(personLinks).values({
                id: dependencies.createId('personLink'),
                workspaceId,
                personId,
                targetType: 'deal',
                targetId: id,
              })
            }
          }
          }

          if (includeOpportunities) {
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
          }

          if (includeRaises) {
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

              await tx.insert(personLinks).values({
                id: dependencies.createId('personLink'),
                workspaceId,
                personId,
                targetType: 'raise',
                targetId: id,
              })
            }
          }
          }

          if (includePartnerships) {
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

              await tx.insert(personLinks).values({
                id: dependencies.createId('personLink'),
                workspaceId,
                personId,
                targetType: 'partnership',
                targetId: id,
              })
            }
          }
          }

          for (const record of fixture.enquiries) {
            const stageId = stageIdByKindAndSlug.get(
              stageLookupKey('enquiry', record.stageSlug),
            )

            if (stageId === undefined) {
              throw new Error(
                `Sample enquiry "${record.name}" names stage "${record.stageSlug}", which this workspace's enquiry pipeline does not carry`,
              )
            }

            const companyId =
              record.companyKey === null ? null : (companyIds.get(record.companyKey) ?? undefined)

            if (companyId === undefined) {
              throw new Error(
                `Sample enquiry "${record.name}" names unknown company "${String(record.companyKey)}"`,
              )
            }

            const id = dependencies.createId('enquiry')
            enquiryIds.set(record.key, id)

            await tx.insert(enquiries).values({
              id,
              workspaceId,
              name: record.name,
              source: record.source,
              stageId,
              companyId,
              summary: record.summary,
              tags: [...record.tags],
              createdAt: now,
              updatedAt: now,
            })

            for (const personKey of record.peopleKeys) {
              const personId = personIds.get(personKey)

              if (personId === undefined) {
                throw new Error(
                  `Sample enquiry "${record.name}" names unknown person "${personKey}"`,
                )
              }

              await tx.insert(personLinks).values({
                id: dependencies.createId('personLink'),
                workspaceId,
                personId,
                targetType: 'enquiry',
                targetId: id,
              })
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

          if (includeEvents) {
          for (const record of fixture.events) {
            const startsAt = new Date(now.getTime() + record.startOffsetHours * 60 * 60 * 1000)
            const endsAt = new Date(startsAt.getTime() + record.durationHours * 60 * 60 * 1000)
            const id = dependencies.createId('crmEvent')
            eventCount += 1

            await tx.insert(events).values({
              id,
              workspaceId,
              name: record.name,
              kind: record.kind,
              startsAt,
              endsAt,
              timezone: record.timezone,
              location: record.location,
              meetingUrl: record.meetingUrl,
              format: record.format,
              details: record.details,
              status: record.status,
              summary: record.summary,
              tags: [...record.tags],
              createdAt: now,
              updatedAt: now,
            })

            if (record.dealKey !== null && includeDeals) {
              const dealId = dealIds.get(record.dealKey)

              if (dealId === undefined) {
                throw new Error(
                  `Sample event "${record.name}" names unknown deal "${record.dealKey}"`,
                )
              }

              await tx.insert(eventAssociations).values({
                id: dependencies.createId('eventAssociation'),
                workspaceId,
                eventId: id,
                targetType: 'deal',
                targetId: dealId,
                createdAt: now,
              })
            }

            for (const attendee of record.attendees) {
              const personId = personIds.get(attendee.personKey)

              if (personId === undefined) {
                throw new Error(
                  `Sample event "${record.name}" names unknown person "${attendee.personKey}"`,
                )
              }

              attendanceCount += 1

              await tx.insert(attendances).values({
                id: dependencies.createId('attendance'),
                workspaceId,
                eventId: id,
                personId,
                status: attendee.status,
                source: attendee.source,
                createdAt: now,
                updatedAt: now,
              })
            }
          }
          }

          for (const record of fixture.plans) {
            if (!includeDeals) {
              continue
            }

            const dealId = dealIds.get(record.targetDealKey)

            if (dealId === undefined) {
              throw new Error(
                `Sample plan item "${record.title}" names unknown deal "${record.targetDealKey}"`,
              )
            }

            planItemCount += 1

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
              enquiryIds,
              candidateIds,
            })

            if (targetId === undefined) {
              if (isOptionalModuleNoteTarget(record.targetType)) {
                continue
              }

              throw new Error(
                `Sample note names unknown ${record.targetType} "${record.targetKey}"`,
              )
            }

            notesWritten += 1

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

          return {
            companies: fixture.companies.length,
            people: fixture.people.length,
            positions: fixture.positions.length,
            deals: dealIds.size,
            planItems: planItemCount,
            notes: notesWritten,
            opportunities: opportunityIds.size,
            raises: raiseIds.size,
            partnerships: partnershipIds.size,
            enquiries: enquiryIds.size,
            roles: roleIds.size,
            candidates: candidateIds.size,
            events: eventCount,
            attendances: attendanceCount,
          }
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
  readonly enquiryIds: ReadonlyMap<string, string>
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
    case 'enquiry':
      return maps.enquiryIds.get(targetKey)
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

function isOptionalModuleNoteTarget(targetType: string): boolean {
  return (
    targetType === 'deal' ||
    targetType === 'opportunity' ||
    targetType === 'raise' ||
    targetType === 'partnership'
  )
}
