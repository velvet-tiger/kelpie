import {
  PERSON_INTAKE_KIND_LABELS,
  PERSON_INTAKE_PERSON_KEY,
  personIntakeIdentifyResponseWireSchema,
  personIntakeResearchResponseWireSchema,
} from '@kelpie/schemas'
import type { PersonIntakeCandidateWire, PersonIntakeItemWire, PersonIntakeResultStatus } from '@kelpie/schemas'
import type { z } from 'zod'

import { AppError, describeThrown } from '../../lib/errors.ts'
import type { Logger } from '../../lib/logger.ts'
import type { McpTool } from '../../runtime/module.ts'
import { actorWorkspaceId } from '../auth/actor.ts'
import type { Actor } from '../auth/actor.ts'
import type { AiPortResolution } from './executor.ts'
import {
  renderIdentifyInstructions,
  renderIdentifyMessage,
  renderResearchInstructions,
  renderResearchMessage,
} from './intakePrompt.ts'
import {
  IDENTIFY_REPLY_JSON_SCHEMA,
  RESEARCH_REPLY_JSON_SCHEMA,
  identifyReplySchema,
  keepSources,
  normaliseCandidates,
  normaliseResearch,
  researchReplySchema,
} from './intakeReply.ts'
import type { AiCompletionResult, AiMessage, AiProviderPort, AiWebSource } from './provider.ts'
import type { AiService } from './service.ts'

/**
 * Person intake: paste notes, and Kelpie AI identifies the person, researches
 * them, and proposes records. Spec: `plans/features/person-intake.md` in the
 * working folder's docs.
 *
 * `identify` and `research` are synchronous AI runs: each is admitted and
 * metered like a queued run (`AiService.startSyncRun`), then makes its model
 * call inside the request and settles its own row. The model gets no Kelpie
 * tools, only the provider's web search when the workspace allows it.
 *
 * Kelpie reads the CRM for the model (existing People, candidate Companies)
 * through the in-process MCP tools with the **caller's** actor, and `apply`
 * writes through the same tools with the same actor. So every read and write
 * passes the role checks and validation a direct API call would, and the
 * records are the user's, not the AI's.
 */

export type WireIdentifyResponse = z.infer<typeof personIntakeIdentifyResponseWireSchema>
export type WireResearchResponse = z.infer<typeof personIntakeResearchResponseWireSchema>

export interface WireApplyResult {
  readonly key: string
  readonly kind: PersonIntakeItemWire['kind']
  readonly status: PersonIntakeResultStatus
  readonly id: string | null
  readonly label: string
  readonly detail: string | null
}

export interface ResearchInput {
  readonly text: string
  readonly candidate: PersonIntakeCandidateWire
  readonly existingPersonId: string | null
}

export interface PersonIntake {
  identify(actor: Actor, text: string): Promise<WireIdentifyResponse>
  research(actor: Actor, input: ResearchInput): Promise<WireResearchResponse>
  apply(actor: Actor, items: readonly PersonIntakeItemWire[]): Promise<readonly WireApplyResult[]>
}

export interface PersonIntakeDependencies {
  readonly service: AiService
  readonly resolvePort: (workspaceId: string) => Promise<AiPortResolution>
  /** Every MCP tool in the assembly. Read at call time, after boot. */
  readonly listTools: () => readonly McpTool[]
  readonly maxTokens: number
  /** As on the executor: true when the key is the workspace's own. */
  readonly exposeProviderErrors: boolean
  readonly log: Logger
}

/** Searches per call. Identify only needs to find the person; research reads more. */
const IDENTIFY_MAX_SEARCHES = 4
const RESEARCH_MAX_SEARCHES = 8

/** How many existing records the CRM lookups offer. */
const EXISTING_PEOPLE_LIMIT = 5
const EXISTING_COMPANIES_LIMIT = 8

const PROVIDER_FAILURE_MESSAGE = 'The AI service was unavailable. Try again shortly.'

/** Mail domains that name a mailbox provider, not an employer. */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'fastmail.com',
])

/** Writes happen in this order, so a dependency is always written first. */
const APPLY_ORDER: readonly PersonIntakeItemWire['kind'][] = [
  'company',
  'person',
  'position',
  'note',
  'partnership',
  'deal',
  'enquiry',
]

type JsonCall<Value> =
  | {
      readonly ok: true
      readonly value: Value
      readonly webSources: readonly AiWebSource[]
      readonly inputTokens: number
      readonly outputTokens: number
    }
  | {
      readonly ok: false
      readonly error: AppError
      readonly inputTokens: number
      readonly outputTokens: number
    }

function requireWorkspace(actor: Actor): string {
  const workspaceId = actorWorkspaceId(actor)

  if (workspaceId === null) {
    throw AppError.notFound('This session has no workspace')
  }

  return workspaceId
}

function indexByName(tools: readonly McpTool[]): ReadonlyMap<string, McpTool> {
  return new Map(tools.map((tool) => [tool.name, tool]))
}

function requireTool(tools: ReadonlyMap<string, McpTool>, name: string): McpTool {
  const tool = tools.get(name)

  if (tool === undefined) {
    throw new AppError('internal_error', `The ${name} tool is not registered in this deployment`)
  }

  return tool
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function listData(result: unknown): Record<string, unknown>[] {
  return isRecord(result) && Array.isArray(result.data) ? result.data.filter(isRecord) : []
}

function createdId(result: unknown): string | null {
  return isRecord(result) ? stringField(result, 'id') : null
}

/** A tool refusal the user can read: an `AppError` says why, anything else is a generic failure. */
function refusalDetail(thrown: unknown): string {
  return thrown instanceof AppError ? thrown.message : 'The write failed'
}

function emailDomain(email: string | null): string | null {
  const domain = email?.split('@')[1]?.trim().toLowerCase()

  return domain === undefined || domain === '' || FREE_MAIL_DOMAINS.has(domain) ? null : domain
}

/** A failed model call that still spent tokens, so the run log can record them. */
class IntakeCallError extends AppError {
  readonly tokens: { readonly input: number; readonly output: number }

  constructor(error: AppError, input: number, output: number) {
    super(error.code, error.message, error.details)
    this.tokens = { input, output }
  }
}

export function createPersonIntake(dependencies: PersonIntakeDependencies): PersonIntake {
  async function portFor(workspaceId: string, runId: string): Promise<AiProviderPort> {
    const resolution = await dependencies.resolvePort(workspaceId)

    if (resolution.kind === 'unavailable') {
      await dependencies.service.settleSyncRun(runId, { status: 'failed', failureReason: resolution.reason })
      throw AppError.conflict(resolution.reason)
    }

    return resolution.port
  }

  function failureFor(result: AiCompletionResult): AppError | null {
    if (result.stopReason === 'refusal') {
      return AppError.conflict(result.failure?.message ?? 'The model declined this request')
    }
    if (result.stopReason === 'failed') {
      const message = result.failure?.message
      return new AppError(
        'internal_error',
        dependencies.exposeProviderErrors && message !== undefined ? message : PROVIDER_FAILURE_MESSAGE,
      )
    }
    if (result.stopReason === 'max_tokens') {
      return AppError.conflict('The reply was cut off at AI_MAX_TOKENS. Try shorter notes.')
    }

    return null
  }

  function parseReply<Value>(text: string, schema: z.ZodType<Value>): { value: Value } | { issues: string[] } {
    let raw: unknown

    try {
      raw = JSON.parse(text)
    } catch (thrown: unknown) {
      return { issues: [`The reply was not valid JSON: ${describeThrown(thrown)}`] }
    }

    const parsed = schema.safeParse(raw)

    return parsed.success
      ? { value: parsed.data }
      : { issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`) }
  }

  /** One model call and, when the reply does not parse, one repair turn. The same shape as the executor. */
  async function callForJson<Value>(
    port: AiProviderPort,
    request: {
      readonly model: string
      readonly instructions: string
      readonly message: string
      readonly schemaName: string
      readonly jsonSchema: Record<string, unknown>
      readonly schema: z.ZodType<Value>
      readonly maxSearches: number | null
    },
  ): Promise<JsonCall<Value>> {
    const messages: AiMessage[] = [{ role: 'user', text: request.message }]
    const webSources: AiWebSource[] = []
    let inputTokens = 0
    let outputTokens = 0

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await port.complete({
        model: request.model,
        maxTokens: dependencies.maxTokens,
        instructions: request.instructions,
        messages,
        responseFormat: { name: request.schemaName, schema: request.jsonSchema },
        // The repair turn only fixes the JSON; it has what it found already.
        webSearch: request.maxSearches === null || attempt > 0 ? undefined : { maxUses: request.maxSearches },
      })

      inputTokens += result.usage.inputTokens
      outputTokens += result.usage.outputTokens
      webSources.push(...(result.webSources ?? []))

      const failure = failureFor(result)
      if (failure !== null) {
        if (result.stopReason === 'failed') {
          dependencies.log.warn('ai intake provider call failed', {
            code: result.failure?.code ?? 'unknown',
            error: result.failure?.message ?? 'no message',
          })
        }
        return { ok: false, error: failure, inputTokens, outputTokens }
      }

      const parsed = parseReply(result.text, request.schema)
      if ('value' in parsed) {
        return { ok: true, value: parsed.value, webSources, inputTokens, outputTokens }
      }

      if (attempt === 0) {
        messages.push({ role: 'assistant', text: result.text })
        messages.push({
          role: 'user',
          text:
            'Your previous reply did not match the required JSON shape. Return one JSON object that matches ' +
            `the schema and fix these issues:\n${parsed.issues.map((issue) => `- ${issue}`).join('\n')}`,
        })
      } else {
        return {
          ok: false,
          error: AppError.conflict(`The model did not return a valid reply: ${parsed.issues.slice(0, 3).join('; ')}`),
          inputTokens,
          outputTokens,
        }
      }
    }

    // Unreachable: the loop returns on both attempts.
    return { ok: false, error: new AppError('internal_error', PROVIDER_FAILURE_MESSAGE), inputTokens, outputTokens }
  }

  /**
   * Runs `body` inside a synchronous AI run: admits it, and settles the row
   * whatever happens, so a thrown error never leaves it `running`.
   */
  async function withSyncRun<Result>(
    workspaceId: string,
    taskId: string,
    prompt: string,
    body: (sync: { readonly runId: string; readonly model: string; readonly webSearch: boolean }) => Promise<{
      readonly result: Result
      readonly inputTokens: number
      readonly outputTokens: number
    }>,
  ): Promise<Result> {
    const sync = await dependencies.service.startSyncRun(workspaceId, taskId, prompt)
    const runId = sync.run.id
    let settled = false

    try {
      const outcome = await body({ runId, model: sync.model, webSearch: sync.webSearch })
      settled = true
      await dependencies.service.settleSyncRun(runId, {
        status: 'succeeded',
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
      })

      return outcome.result
    } catch (thrown: unknown) {
      if (!settled) {
        const tokens = thrown instanceof IntakeCallError ? thrown.tokens : undefined
        await dependencies.service
          .settleSyncRun(runId, {
            status: 'failed',
            failureReason: thrown instanceof AppError ? thrown.message : PROVIDER_FAILURE_MESSAGE,
            ...(tokens === undefined ? {} : { inputTokens: tokens.input, outputTokens: tokens.output }),
          })
          .catch((settleError: unknown) => {
            dependencies.log.error('ai intake run could not be settled', { runId, error: describeThrown(settleError) })
          })
      }
      if (!(thrown instanceof AppError)) {
        dependencies.log.error('ai intake threw', { runId, error: describeThrown(thrown) })
        throw new AppError('internal_error', PROVIDER_FAILURE_MESSAGE)
      }
      throw thrown
    }
  }

  async function existingPeopleFor(
    tools: ReadonlyMap<string, McpTool>,
    actor: Actor,
    candidate: PersonIntakeCandidateWire,
  ): Promise<PersonIntakeCandidateWire['existing_people']> {
    const peopleList = requireTool(tools, 'people_list')
    const terms = [candidate.email, candidate.name].filter((term): term is string => term !== null && term !== '')
    const found = new Map<string, PersonIntakeCandidateWire['existing_people'][number]>()

    for (const term of terms) {
      const rows = listData(await peopleList.invoke({ q: term, limit: EXISTING_PEOPLE_LIMIT }, actor))
      for (const row of rows) {
        const id = stringField(row, 'id')
        if (id === null || found.has(id)) continue
        found.set(id, { id, name: stringField(row, 'name') ?? '', email: stringField(row, 'email') })
      }
    }

    return [...found.values()].slice(0, EXISTING_PEOPLE_LIMIT)
  }

  async function existingCompaniesFor(
    tools: ReadonlyMap<string, McpTool>,
    actor: Actor,
    terms: readonly string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const companiesList = requireTool(tools, 'companies_list')
    const found = new Map<string, Record<string, unknown>>()

    for (const term of terms) {
      const rows = listData(await companiesList.invoke({ q: term, limit: EXISTING_COMPANIES_LIMIT }, actor))
      for (const row of rows) {
        const id = stringField(row, 'id')
        if (id !== null && !found.has(id) && found.size < EXISTING_COMPANIES_LIMIT) found.set(id, row)
      }
    }

    return found
  }

  return {
    async identify(actor, text) {
      const workspaceId = requireWorkspace(actor)
      const tools = indexByName(dependencies.listTools())

      return withSyncRun(workspaceId, 'person_intake.identify', text, async (sync) => {
        const port = await portFor(workspaceId, sync.runId)
        const call = await callForJson(port, {
          model: sync.model,
          instructions: renderIdentifyInstructions(sync.webSearch),
          message: renderIdentifyMessage(text),
          schemaName: 'kelpie_person_intake_identify',
          jsonSchema: IDENTIFY_REPLY_JSON_SCHEMA,
          schema: identifyReplySchema,
          maxSearches: sync.webSearch ? IDENTIFY_MAX_SEARCHES : null,
        })

        if (!call.ok) throw new IntakeCallError(call.error, call.inputTokens, call.outputTokens)

        const candidates = normaliseCandidates(call.value)
        for (const [index, candidate] of candidates.entries()) {
          candidates[index] = { ...candidate, existing_people: await existingPeopleFor(tools, actor, candidate) }
        }

        const response = personIntakeIdentifyResponseWireSchema.parse({
          candidates,
          question: candidates.length === 0 ? (call.value.question ?? 'Add more detail about this person.') : null,
          sources: keepSources(call.value.sources, sync.webSearch ? call.webSources : undefined, text),
          run_id: sync.runId,
        })

        return {
          result: response,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
        }
      })
    },

    async research(actor, input) {
      const workspaceId = requireWorkspace(actor)
      const tools = indexByName(dependencies.listTools())

      // Read what the CRM already holds before the run starts, so a wrong
      // Person id is a plain 404 and costs no AI run.
      let existingPerson: string | null = null
      const heldPositions = new Set<string>()
      const companyTerms = new Set<string>()

      if (input.existingPersonId !== null) {
        const person = await requireTool(tools, 'people_get').invoke({ id: input.existingPersonId }, actor)
        const positions = listData(
          await requireTool(tools, 'positions_list').invoke({ person_id: input.existingPersonId, limit: 50 }, actor),
        )

        existingPerson = '```json\n' + JSON.stringify(person, null, 2) + '\n```'
        for (const position of positions) {
          const companyId = stringField(position, 'company_id')
          if (companyId !== null) heldPositions.add(`${companyId}:${(stringField(position, 'title') ?? '').toLowerCase()}`)
        }
      }

      if (input.candidate.company_name !== null && input.candidate.company_name !== '') {
        companyTerms.add(input.candidate.company_name)
      }
      const domain = emailDomain(input.candidate.email)
      if (domain !== null) companyTerms.add(domain)

      const companies = await existingCompaniesFor(tools, actor, [...companyTerms])
      const existingCompanies =
        companies.size === 0
          ? 'None found.'
          : [...companies.values()]
              .map((company) => {
                const id = stringField(company, 'id') ?? ''
                const companyDomain = stringField(company, 'domain')
                return `- ${stringField(company, 'name') ?? ''} (id ${id}${companyDomain === null ? '' : `, ${companyDomain}`})`
              })
              .join('\n')

      return withSyncRun(workspaceId, 'person_intake.research', input.text, async (sync) => {
        const port = await portFor(workspaceId, sync.runId)
        const call = await callForJson(port, {
          model: sync.model,
          instructions: renderResearchInstructions(sync.webSearch),
          message: renderResearchMessage({
            text: input.text,
            candidate: input.candidate,
            existingPerson,
            existingCompanies,
          }),
          schemaName: 'kelpie_person_intake_research',
          jsonSchema: RESEARCH_REPLY_JSON_SCHEMA,
          schema: researchReplySchema,
          maxSearches: sync.webSearch ? RESEARCH_MAX_SEARCHES : null,
        })

        if (!call.ok) throw new IntakeCallError(call.error, call.inputTokens, call.outputTokens)

        const sources = keepSources(call.value.sources, sync.webSearch ? call.webSources : undefined, input.text)
        const items = normaliseResearch({
          reply: call.value,
          existingPersonId: input.existingPersonId,
          offeredCompanyIds: new Set(companies.keys()),
          heldPositions,
          sources,
        })

        const response = personIntakeResearchResponseWireSchema.parse({
          summary: call.value.summary,
          items,
          sources,
          run_id: sync.runId,
        })

        return {
          result: response,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
        }
      })
    },

    async apply(actor, items) {
      requireWorkspace(actor)
      const tools = indexByName(dependencies.listTools())
      const ids = new Map<string, string>()
      const labels = new Map<string, string>()
      const results: WireApplyResult[] = []

      const persons = items.filter((item) => item.kind === 'person')
      if (persons.length > 1 || persons.some((item) => item.key !== PERSON_INTAKE_PERSON_KEY)) {
        throw AppError.validationFailed('The items are not valid', [
          { field: 'items', message: `Send at most one person item, keyed "${PERSON_INTAKE_PERSON_KEY}"` },
        ])
      }
      if (new Set(items.map((item) => item.key)).size !== items.length) {
        throw AppError.validationFailed('The items are not valid', [{ field: 'items', message: 'Item keys must be unique' }])
      }

      const ordered = [...items].sort((left, right) => APPLY_ORDER.indexOf(left.kind) - APPLY_ORDER.indexOf(right.kind))

      for (const item of ordered) {
        const label = labelFor(item, labels)
        const missing = dependenciesOf(item).find((key) => !ids.has(key))

        if (missing !== undefined) {
          results.push({
            key: item.key,
            kind: item.kind,
            status: 'skipped',
            id: null,
            label,
            detail: `Needs the ${describeKey(missing, items)}, which was not created`,
          })
          continue
        }

        try {
          const written = await applyItem(tools, actor, item, ids)
          ids.set(item.key, written.id)
          labels.set(item.key, label)
          results.push({ key: item.key, kind: item.kind, status: written.status, id: written.id, label, detail: null })
        } catch (thrown: unknown) {
          if (!(thrown instanceof AppError)) {
            dependencies.log.warn('ai intake write failed', { kind: item.kind, error: describeThrown(thrown) })
          }
          results.push({ key: item.key, kind: item.kind, status: 'failed', id: null, label, detail: refusalDetail(thrown) })
        }
      }

      return results
    },
  }
}

function dependenciesOf(item: PersonIntakeItemWire): readonly string[] {
  switch (item.kind) {
    case 'person':
    case 'company':
      return []
    case 'note':
      return [PERSON_INTAKE_PERSON_KEY]
    case 'position':
    case 'partnership':
    case 'deal':
      return [PERSON_INTAKE_PERSON_KEY, item.company_key]
    case 'enquiry':
      return item.company_key === null ? [PERSON_INTAKE_PERSON_KEY] : [PERSON_INTAKE_PERSON_KEY, item.company_key]
  }
}

function describeKey(key: string, items: readonly PersonIntakeItemWire[]): string {
  const item = items.find((candidate) => candidate.key === key)

  if (item === undefined) {
    return key === PERSON_INTAKE_PERSON_KEY ? 'person' : 'company'
  }

  return `${PERSON_INTAKE_KIND_LABELS[item.kind].toLowerCase()} ${labelFor(item, new Map())}`
}

function labelFor(item: PersonIntakeItemWire, labels: ReadonlyMap<string, string>): string {
  switch (item.kind) {
    case 'person':
    case 'company':
    case 'partnership':
    case 'deal':
    case 'enquiry':
      return item.fields.name
    case 'position': {
      const company = labels.get(item.company_key)
      const title = item.title === '' ? 'Position' : item.title
      return company === undefined ? title : `${title} at ${company}`
    }
    case 'note':
      return 'Research note'
  }
}

/** A list field on update: what the record has, plus what is new. */
function union(existing: unknown, added: readonly string[] | undefined): string[] | undefined {
  if (added === undefined) return undefined

  const current = Array.isArray(existing) ? existing.filter((value): value is string => typeof value === 'string') : []
  const merged = [...current]
  for (const value of added) {
    if (!merged.some((entry) => entry.toLowerCase() === value.toLowerCase())) merged.push(value)
  }

  return merged.length === current.length ? undefined : merged
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/**
 * The update body for an existing Person. Update adds; it never overwrites:
 * a scalar field is set only when the record's is blank, and a list gains
 * the new entries. The name and the enum fields (which always hold a value)
 * are left alone.
 */
export function mergePersonUpdate(
  existing: Record<string, unknown>,
  fields: Extract<PersonIntakeItemWire, { kind: 'person' }>['fields'],
): Record<string, unknown> {
  const update: Record<string, unknown> = {}

  for (const key of ['email', 'timezone', 'summary'] as const) {
    const value = fields[key]
    if (value !== undefined && value !== null && value !== '' && isBlank(existing[key])) update[key] = value
  }

  const phones = union(existing.phones, fields.phones)
  if (phones !== undefined) update.phones = phones

  const tags = union(existing.tags, fields.tags)
  if (tags !== undefined) update.tags = tags

  if (fields.social_profiles !== undefined) {
    const current = Array.isArray(existing.social_profiles) ? existing.social_profiles.filter(isRecord) : []
    const networks = new Set(current.map((profile) => profile.network))
    const added = fields.social_profiles.filter((profile) => !networks.has(profile.network))
    if (added.length > 0) {
      update.social_profiles = [
        ...current.map((profile) => ({ network: profile.network, url: profile.url })),
        ...added,
      ]
    }
  }

  return update
}

async function applyItem(
  tools: ReadonlyMap<string, McpTool>,
  actor: Actor,
  item: PersonIntakeItemWire,
  ids: ReadonlyMap<string, string>,
): Promise<{ readonly id: string; readonly status: PersonIntakeResultStatus }> {
  const personId = ids.get(PERSON_INTAKE_PERSON_KEY)
  const idOf = (key: string): string => {
    const id = ids.get(key)
    if (id === undefined) throw new AppError('internal_error', `No id for ${key}`)
    return id
  }
  const created = (result: unknown, status: PersonIntakeResultStatus): { id: string; status: PersonIntakeResultStatus } => {
    const id = createdId(result)
    if (id === null) throw new AppError('internal_error', 'The write returned no id')
    return { id, status }
  }

  switch (item.kind) {
    case 'company': {
      if (item.action === 'existing') {
        if (item.existing_id === null) throw AppError.validationFailed('No company id', [{ field: 'existing_id', message: 'Required' }])
        return created(await requireTool(tools, 'companies_get').invoke({ id: item.existing_id }, actor), 'linked')
      }
      return created(await requireTool(tools, 'companies_create').invoke(item.fields, actor), 'created')
    }
    case 'person': {
      if (item.action === 'create') {
        return created(await requireTool(tools, 'people_create').invoke(item.fields, actor), 'created')
      }
      if (item.existing_id === null) throw AppError.validationFailed('No person id', [{ field: 'existing_id', message: 'Required' }])

      const existing = await requireTool(tools, 'people_get').invoke({ id: item.existing_id }, actor)
      const update = isRecord(existing) ? mergePersonUpdate(existing, item.fields) : {}

      if (Object.keys(update).length === 0) {
        return { id: item.existing_id, status: 'linked' }
      }

      return created(await requireTool(tools, 'people_update').invoke({ id: item.existing_id, ...update }, actor), 'updated')
    }
    case 'position': {
      const personKeyId = idOf(PERSON_INTAKE_PERSON_KEY)
      const companyId = idOf(item.company_key)
      // The email-domain linker may already have linked a new Person to the
      // Company their email names, with no title. Fill that in rather than
      // add a second link, and do not repeat a title the Person holds there.
      const held = listData(
        await requireTool(tools, 'positions_list').invoke({ person_id: personKeyId, company_id: companyId, limit: 50 }, actor),
      )
      const sameTitle = held.find((position) => (stringField(position, 'title') ?? '').toLowerCase() === item.title.toLowerCase())
      if (sameTitle !== undefined) {
        return created(sameTitle, 'linked')
      }
      const untitled = held.find((position) => (stringField(position, 'title') ?? '') === '')
      if (untitled !== undefined) {
        return created(
          await requireTool(tools, 'positions_update').invoke({ id: stringField(untitled, 'id'), title: item.title }, actor),
          'updated',
        )
      }
      return created(
        await requireTool(tools, 'positions_create').invoke({ person_id: personKeyId, company_id: companyId, title: item.title }, actor),
        'created',
      )
    }
    case 'note':
      return created(
        await requireTool(tools, 'notes_create').invoke(
          { target_type: 'person', target_id: idOf(PERSON_INTAKE_PERSON_KEY), body: item.body, pinned: true },
          actor,
        ),
        'created',
      )
    case 'partnership':
      return created(
        await requireTool(tools, 'partnerships_create').invoke(
          { ...item.fields, company_id: idOf(item.company_key), person_ids: personId === undefined ? [] : [personId] },
          actor,
        ),
        'created',
      )
    case 'deal':
      return created(
        await requireTool(tools, 'deals_create').invoke(
          { ...item.fields, company_id: idOf(item.company_key), person_ids: personId === undefined ? [] : [personId] },
          actor,
        ),
        'created',
      )
    case 'enquiry':
      return created(
        await requireTool(tools, 'enquiries_create').invoke(
          {
            ...item.fields,
            company_id: item.company_key === null ? null : idOf(item.company_key),
            person_ids: personId === undefined ? [] : [personId],
          },
          actor,
        ),
        'created',
      )
  }
}
