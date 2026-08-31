import {
  IMPORT_PREVIEW_ROWS,
  IMPORT_REPORTED_ERRORS,
  MAX_IMPORT_ROWS,
  OBJECT_COLUMNS,
  SYNC_IMPORT_ROWS,
  findMatchKey,
  requiredColumns,
} from '@kelpie/schemas'
import type {
  ImportColumnMap,
  ImportConflictMode,
  ImportCounts,
  ImportJobStatus,
  ImportObject,
  ImportPreviewRow,
  ImportRowError,
  ImportSource,
  MatchKeyOption,
  OnMissingCompany,
} from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import { AppError, describeThrown } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { Logger } from '../../lib/logger.ts'
import { normaliseDomain, normaliseEmail } from '../../lib/normalisation.ts'
import type { BufferedEvents, Queryable, TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { RecordObjectType } from '../../runtime/events.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import '../companies/events.ts'
import '../deals/events.ts'
import '../people/events.ts'
import '../positions/events.ts'
import './events.ts'

/**
 * Fires the created event owned by the record's module for one imported row.
 * Split from the loop so TypeScript can correlate the object type with its
 * typed event name at each call site.
 */
function emitImportedRecordCreated(
  events: BufferedEvents,
  objectType: RecordObjectType,
  recordId: string,
): void {
  switch (objectType) {
    case 'person':
      events.emit('people.person.created', { type: 'person', id: recordId }, {})
      return
    case 'company':
      events.emit('companies.company.created', { type: 'company', id: recordId }, {})
      return
    case 'position':
      events.emit('positions.position.created', { type: 'position', id: recordId }, {})
      return
    case 'deal':
      events.emit('deals.deal.created', { type: 'deal', id: recordId }, {})
      return
    // The remaining `RecordObjectType` values are not produced by an import.
    default:
      throw new Error(`import produced an unexpected object type: ${objectType}`)
  }
}

function emitImportedRecordUpdated(
  events: BufferedEvents,
  objectType: RecordObjectType,
  recordId: string,
  changed: readonly string[],
): void {
  switch (objectType) {
    case 'person':
      events.emit('people.person.updated', { type: 'person', id: recordId }, { changed })
      return
    case 'company':
      events.emit(
        'companies.company.updated',
        { type: 'company', id: recordId },
        { changed },
      )
      return
    case 'position':
      events.emit(
        'positions.position.updated',
        { type: 'position', id: recordId },
        { changed },
      )
      return
    case 'deal':
      events.emit('deals.deal.updated', { type: 'deal', id: recordId }, { changed })
      return
    default:
      throw new Error(`import produced an unexpected object type: ${objectType}`)
  }
}
import { CsvFormatError, csvLine, fileDigest, parseCsv } from './csv.ts'
import type { CsvRow, ParsedCsv } from './csv.ts'
import { templateHeadersFor } from './exportRows.ts'
import { buildMatchKey, mapRow, splitList } from './mapping.ts'
import { applyWrite } from './writes.ts'
import { countPlans, planRow, planRows } from './plan.ts'
import type { ImportLookups, MappedRow, PlanContext, PlannedRow } from './plan.ts'
import { defaultColumnMap } from './presets.ts'
import * as repository from './repository.ts'
import type { ImportJobRecord, KeyedRecord } from './repository.ts'
import { streamExport } from './streams.ts'

/**
 * CSV import jobs and CSV export, per `import-export.md`.
 *
 * The shape of a job is: upload, which stores the file; a dry run, which plans
 * each line against the workspace and reports what would happen; then a commit,
 * which applies the file while re-resolving every match. Re-resolving is the
 * point — the workspace can change between the two calls, and lines earlier in
 * the same file create records later lines must match against. It is also what
 * makes a commit idempotent: run it twice and the second pass finds the records
 * the first one made.
 *
 * Only the commit writes `import_job_rows`. A dry run plans from the stored file
 * in memory and keeps nothing but its counts, its first errors and its preview,
 * because a forecast nobody committed is not a thing to store ten thousand rows
 * for. That is also why a corrected mapping — which is a new job over the same
 * file — costs one row rather than the file again.
 */

export interface ImportExportDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
  readonly log: Logger
}

/** A job as the API returns one: the stored row minus tenancy, with its errors and preview. */
export interface ImportJobView {
  readonly id: string
  readonly source: ImportSource
  readonly object: ImportObject
  readonly status: string
  readonly conflictMode: ImportConflictMode
  readonly onMissingCompany: OnMissingCompany
  readonly matchKey: string
  readonly columnMap: ImportColumnMap
  readonly consentPurposeId: string | null
  readonly sourceHeaders: readonly string[]
  readonly fileName: string | null
  readonly counts: ImportCounts
  readonly errors: readonly ImportRowError[]
  readonly warnings: readonly ImportRowError[]
  readonly preview: readonly ImportPreviewRow[]
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateImportJobInput {
  readonly source: ImportSource
  readonly object: ImportObject
  readonly conflictMode: ImportConflictMode
  readonly onMissingCompany: OnMissingCompany
  readonly matchKeyId: string
  /** Absent means "derive one from the source preset and the file's own headers". */
  readonly columnMap: ImportColumnMap | undefined
  /**
   * People imports only. Required whenever the mapping names `consent_status`
   * or `consent_at`, refused with `422` for any other object.
   */
  readonly consentPurposeId: string | null
  readonly fileName: string | null
  readonly csv: string
}

export interface ImportExportService {
  createJob(actor: Actor, input: CreateImportJobInput): Promise<ImportJobView>
  getJob(actor: Actor, id: string): Promise<ImportJobView>
  /**
   * @param csv The same file the dry run read. A job holds only its digest, so
   *   the caller brings the bytes back and a different file is refused.
   */
  commit(actor: Actor, id: string, csv: string): Promise<ImportJobView>
  deleteJob(actor: Actor, id: string): Promise<void>
  /** CSV lines for a whole object, a page of records at a time. */
  exportCsv(actor: Actor, object: ImportObject): AsyncGenerator<string>
  templateCsv(object: ImportObject): string
}

const EMPTY_COUNTS: ImportCounts = { total: 0, create: 0, update: 0, skip: 0, error: 0 }

/**
 * The statuses a job may be deleted in: everything except the two a background
 * pass is working through.
 *
 * `pending` is here because a job stranded in it by a crash is exactly the
 * unreachable garbage this delete exists to clear. `validating` and
 * `committing` are not, because the detached pass holds the rows and would carry
 * on writing records against a job that is no longer there.
 */
const DELETABLE_STATUSES: readonly ImportJobStatus[] = [
  'pending',
  'ready',
  'completed',
  'failed',
]

/** Rows committed between two writes of the job's running counts, so polling shows progress. */
const COMMIT_PROGRESS_INTERVAL = 100

/** The stored job minus tenancy, the failure reason, and the file digest. */
function toView(job: ImportJobRecord): ImportJobView {
  const {
    workspaceId: _workspaceId,
    failureReason: _failureReason,
    fileSha256: _fileSha256,
    ...rest
  } = job

  return {
    ...rest,
    source: rest.source as ImportSource,
    object: rest.object as ImportObject,
    conflictMode: rest.conflictMode as ImportConflictMode,
    onMissingCompany: rest.onMissingCompany as OnMissingCompany,
  }
}

/** The distinct non-null values of one column across a file, for a lookup's `in (…)`. */
function distinct(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== null))]
}

export function createImportExportService(
  dependencies: ImportExportDependencies,
): ImportExportService {
  async function requireJob(workspaceId: string, id: string): Promise<ImportJobRecord> {
    const job = await repository.findJob(dependencies.db, workspaceId, id)

    // A job in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (job === undefined) {
      throw AppError.notFound('Import job not found')
    }

    return job
  }

  function requireMatchKey(object: ImportObject, matchKeyId: string): MatchKeyOption {
    const matchKey = findMatchKey(object, matchKeyId)

    if (matchKey === undefined) {
      throw AppError.validationFailed(`"${matchKeyId}" is not a match key for ${object}`, [
        { field: 'match_key', message: 'Use one of the keys this object declares' },
      ])
    }

    return matchKey
  }

  /**
   * Checks a column map against the object it claims to describe and the file it
   * will be applied to.
   *
   * All three problems are reported at once, and a mapping mistake is the one a
   * caller is most likely to make twice.
   */
  function requireUsableColumnMap(
    object: ImportObject,
    matchKey: MatchKeyOption,
    columnMap: ImportColumnMap,
    headers: readonly string[],
  ): void {
    const known = new Set(OBJECT_COLUMNS[object].map((column) => column.key))
    const present = new Set(headers)
    const problems = [
      ...Object.keys(columnMap)
        .filter((column) => !known.has(column))
        .map((column) => ({
          field: `column_map.${column}`,
          message: `${object} has no column called "${column}"`,
        })),
      ...Object.entries(columnMap)
        .filter(([, header]) => header !== null && !present.has(header))
        .map(([column, header]) => ({
          field: `column_map.${column}`,
          message: `The file has no column headed "${String(header)}"`,
        })),
      ...requiredColumns(object, matchKey)
        .filter((column) => (columnMap[column] ?? null) === null)
        .map((column) => ({
          field: `column_map.${column}`,
          message: 'Required, and required columns must be mapped',
        })),
    ]

    if (problems.length > 0) {
      throw AppError.validationFailed('That column map cannot read this file', problems)
    }
  }

  /**
   * The stored records that already hold any of the match keys this file uses.
   *
   * Both sides of a comparison go through `buildMatchKey`, so a row and the
   * record it should match reduce to the same string by construction rather than
   * by two implementations agreeing.
   */
  async function findExistingKeys(
    db: Queryable,
    workspaceId: string,
    object: ImportObject,
    matchKey: MatchKeyOption,
    rows: readonly MappedRow[],
  ): Promise<ReadonlyMap<string, string>> {
    const column = (name: string): readonly string[] =>
      distinct(rows.map((row) => (row.mapped[name] ?? '').trim() || null))
    const emails = distinct(rows.map((row) => normaliseEmail(row.mapped.person_email ?? '')))
    const domains = distinct(rows.map((row) => normaliseDomain(row.mapped.company_domain ?? '')))

    const records: readonly KeyedRecord[] = await (async (): Promise<readonly KeyedRecord[]> => {
      switch (object) {
        case 'companies':
          return repository.findCompanyKeys(
            db,
            workspaceId,
            distinct(rows.map((row) => normaliseDomain(row.mapped.domain ?? ''))),
            matchKey.id === 'name' ? column('name').map((name) => name.toLowerCase()) : [],
          )
        case 'people':
          return repository.findPeopleKeys(
            db,
            workspaceId,
            distinct(rows.map((row) => normaliseEmail(row.mapped.email ?? ''))),
          )
        case 'positions':
          return repository.findPositionKeys(db, workspaceId, emails)
        case 'deals':
          return matchKey.id === 'external_id'
            ? repository.findDealKeysByExternalId(db, workspaceId, column('external_id'))
            : repository.findDealKeysByCompany(db, workspaceId, domains)
      }
    })()

    const keys = new Map<string, string>()

    for (const record of records) {
      const key = buildMatchKey(matchKey, record.parts)

      // First writer wins, so a workspace holding two records under one key
      // matches the same one every time rather than following whichever the
      // planner saw last.
      if (key !== null && !keys.has(key)) {
        keys.set(key, record.id)
      }
    }

    return keys
  }

  /** The references a plan resolves: people, companies, members, and deal stages. */
  async function buildLookups(
    db: Queryable,
    workspaceId: string,
    object: ImportObject,
    matchKey: MatchKeyOption,
    rows: readonly MappedRow[],
  ): Promise<ImportLookups> {
    const existing = await findExistingKeys(db, workspaceId, object, matchKey, rows)

    if (object === 'companies') {
      return {
        existing,
        personIdByEmail: new Map(),
        companyIdByDomain: new Map(),
        companyIdByName: new Map(),
        memberIdByEmail: new Map(),
        dealStageIdByName: new Map(),
      }
    }

    // People only need companies, and only when a row carries an affiliation.
    // Both a domain map and a name map, because a row may identify its company
    // either way.
    if (object === 'people') {
      const domains = distinct(rows.map((row) => normaliseDomain(row.mapped.company_domain ?? '')))
      const names = distinct(
        rows.map((row) => (row.mapped.company_name ?? '').trim().toLowerCase() || null),
      )
      const [byDomain, byName] = await Promise.all([
        repository.findCompanyIdsByDomain(db, workspaceId, domains),
        repository.findCompanyIdsByName(db, workspaceId, names),
      ])

      return {
        existing,
        personIdByEmail: new Map(),
        companyIdByDomain: new Map(
          byDomain.flatMap((row) => (row.domain === null ? [] : [[row.domain, row.id] as const])),
        ),
        companyIdByName: new Map(byName.map((row) => [row.name.toLowerCase(), row.id] as const)),
        memberIdByEmail: new Map(),
        dealStageIdByName: new Map(),
      }
    }

    const emails = distinct([
      ...rows.map((row) => normaliseEmail(row.mapped.person_email ?? '')),
      ...rows.flatMap((row) =>
        splitList(row.mapped.person_emails).map((address) => normaliseEmail(address)),
      ),
    ])
    const domains = distinct(rows.map((row) => normaliseDomain(row.mapped.company_domain ?? '')))
    const [peopleRows, companyRows] = await Promise.all([
      repository.findPersonIdsByEmail(db, workspaceId, emails),
      repository.findCompanyIdsByDomain(db, workspaceId, domains),
    ])

    if (object === 'positions') {
      return {
        existing,
        personIdByEmail: new Map(
          peopleRows.flatMap((row) => (row.email === null ? [] : [[row.email, row.id] as const])),
        ),
        companyIdByDomain: new Map(
          companyRows.flatMap((row) => (row.domain === null ? [] : [[row.domain, row.id] as const])),
        ),
        companyIdByName: new Map(),
        memberIdByEmail: new Map(),
        dealStageIdByName: new Map(),
      }
    }

    const [members, stages] = await Promise.all([
      repository.listMemberEmails(db, workspaceId),
      repository.listDealStages(db, workspaceId),
    ])

    // A stage answers to its slug and to its label. The slug is the stable one
    // an export writes; the label is what a person typed into the spreadsheet.
    const stagesByName = new Map<string, string>()

    for (const stage of stages) {
      stagesByName.set(stage.slug.toLowerCase(), stage.id)
      stagesByName.set(stage.label.toLowerCase(), stage.id)
    }

    return {
      existing,
      personIdByEmail: new Map(
        peopleRows.flatMap((row) => (row.email === null ? [] : [[row.email, row.id] as const])),
      ),
      companyIdByDomain: new Map(
        companyRows.flatMap((row) => (row.domain === null ? [] : [[row.domain, row.id] as const])),
      ),
      companyIdByName: new Map(),
      memberIdByEmail: new Map(members.map((member) => [member.email.toLowerCase(), member.id])),
      dealStageIdByName: stagesByName,
    }
  }

  function contextFor(job: ImportJobRecord, lookups: ImportLookups): PlanContext {
    return {
      object: job.object as ImportObject,
      matchKey: requireMatchKey(job.object as ImportObject, job.matchKey),
      conflictMode: job.conflictMode as ImportConflictMode,
      onMissingCompany: job.onMissingCompany as OnMissingCompany,
      consentPurposeId: job.consentPurposeId,
      lookups,
    }
  }

  /** A parsed file, mapped to Kelpie columns through the job's own column map. */
  function readFile(
    job: ImportJobRecord,
    parsed: ParsedCsv,
  ): { rows: MappedRow[]; values: Map<number, CsvRow> } {
    return {
      rows: parsed.rows.map((row) => ({ row: row.number, mapped: mapRow(row.values, job.columnMap) })),
      values: new Map(parsed.rows.map((row) => [row.number, row])),
    }
  }

  /**
   * Checks a file handed back at commit against the one the dry run forecast.
   *
   * The counts a caller approved describe one particular file. Without this the
   * commit would apply whatever arrived and report it under a forecast taken
   * from something else.
   *
   * @throws AppError 409 when it is a different file, or when the job predates
   *   the digest and there is nothing to compare against.
   */
  function requireForecastFile(job: ImportJobRecord, csv: string): void {
    if (job.fileSha256 === null) {
      throw AppError.conflict('This job was created before its file was fingerprinted', [
        { field: 'file', message: 'Upload the file again as a new job' },
      ])
    }

    if (fileDigest(csv) !== job.fileSha256) {
      throw AppError.conflict('That is not the file this job dry-ran', [
        {
          field: 'file',
          message: 'Commit the file the dry run read, or upload this one as a new job',
        },
      ])
    }
  }

  function toOutcome(planned: PlannedRow): repository.RowOutcome {
    const { plan } = planned

    return {
      rowNumber: planned.row,
      action: plan.action,
      errors: plan.action === 'error' ? plan.errors : [],
      warnings: plan.action === 'create' || plan.action === 'update' ? (plan.warnings ?? []) : [],
    }
  }

  /**
   * The first errors and the first preview rows, as a caller reads them off a
   * job.
   *
   * Takes outcomes rather than plans, because the dry run and the commit produce
   * the same three facts about a line and the job reports whichever ran last.
   */
  function reportOf(
    outcomes: readonly repository.RowOutcome[],
    mapped: readonly MappedRow[],
  ): {
    errors: readonly ImportRowError[]
    warnings: readonly ImportRowError[]
    preview: readonly ImportPreviewRow[]
  } {
    const byRow = new Map(mapped.map((row) => [row.row, row.mapped]))

    return {
      errors: outcomes
        .filter((outcome) => outcome.action === 'error')
        .slice(0, IMPORT_REPORTED_ERRORS)
        .flatMap((outcome) =>
          outcome.errors.map((problem) => ({
            row: outcome.rowNumber,
            field: problem.field,
            message: problem.message,
          })),
        ),
      warnings: outcomes
        .filter((outcome) => outcome.warnings.length > 0)
        .slice(0, IMPORT_REPORTED_ERRORS)
        .flatMap((outcome) =>
          outcome.warnings.map((problem) => ({
            row: outcome.rowNumber,
            field: problem.field,
            message: problem.message,
          })),
        ),
      preview: outcomes.slice(0, IMPORT_PREVIEW_ROWS).map((outcome) => ({
        row: outcome.rowNumber,
        action: outcome.action,
        values: byRow.get(outcome.rowNumber) ?? {},
      })),
    }
  }

  /**
   * Plans every line of a job's file and records the forecast on the job.
   *
   * Writes no `import_job_rows`: a dry run is a forecast, and the three things a
   * caller reads off it are the counts, the first errors and the preview. Runs
   * inside the request for a small file and detached for a large one, which is
   * the only difference between the two paths.
   *
   * Takes the parse rather than reading it back, because the job does not hold
   * the file. The detached path closes over it for as long as it runs, which is
   * the same lifetime the request would have had.
   */
  async function runDryRun(workspaceId: string, jobId: string, parsed: ParsedCsv): Promise<void> {
    const job = await requireJob(workspaceId, jobId)
    const { rows } = readFile(job, parsed)
    const lookups = await buildLookups(
      dependencies.db,
      workspaceId,
      job.object as ImportObject,
      requireMatchKey(job.object as ImportObject, job.matchKey),
      rows,
    )
    const planned = planRows(contextFor(job, lookups), rows)

    await repository.updateJob(dependencies.db, workspaceId, jobId, {
      status: 'ready',
      counts: countPlans(planned),
      ...reportOf(planned.map(toOutcome), rows),
      updatedAt: dependencies.now(),
    })
  }

  /**
   * Marks a job failed with the reason.
   *
   * A background pass has nobody to throw to: the request that started it has
   * already answered. The job is where the caller looks next, so that is where
   * the failure has to land.
   */
  async function failJob(workspaceId: string, jobId: string, error: unknown): Promise<void> {
    const reason = describeThrown(error)

    dependencies.log.error('import job failed', { jobId, error: reason })

    await repository
      .updateJob(dependencies.db, workspaceId, jobId, {
        status: 'failed',
        failureReason: reason,
        updatedAt: dependencies.now(),
      })
      .catch((writeError: unknown) => {
        dependencies.log.error('could not record an import failure', {
          jobId,
          error: describeThrown(writeError),
        })
      })
  }

  /**
   * Runs work detached from the request that asked for it.
   *
   * The same shape `runtime/transaction.ts` uses to publish events: not awaited,
   * and a rejection is logged rather than lost. A crash between here and the
   * final status leaves the job in its transient status with nothing to move it
   * on — stated in the README, because there is no durable queue to fix it with.
   */
  function detach(workspaceId: string, jobId: string, work: () => Promise<void>): void {
    void work().catch((error: unknown) => failJob(workspaceId, jobId, error))
  }

  /** Applies one line, in its own transaction, and returns what it did. */
  async function commitRow(
    workspaceId: string,
    actor: Actor,
    job: ImportJobRecord,
    line: CsvRow,
  ): Promise<repository.RowOutcome> {
    const object = job.object as ImportObject
    const matchKey = requireMatchKey(object, job.matchKey)
    const mapped = mapRow(line.values, job.columnMap)
    const row: MappedRow = { row: line.number, mapped }

    return dependencies.transaction(async ({ tx, events }) => {
      // Resolved inside the transaction, against the rows this commit has
      // already written. That is what makes a file listing one company twice
      // create it once, and what lets an interrupted commit be re-run.
      const lookups = await buildLookups(tx, workspaceId, object, matchKey, [row])
      const plan = planRow(contextFor(job, lookups), mapped)

      const outcome: repository.RowOutcome = {
        rowNumber: line.number,
        action: plan.action,
        errors: plan.action === 'error' ? plan.errors : [],
        warnings:
          plan.action === 'create' || plan.action === 'update' ? (plan.warnings ?? []) : [],
      }

      if (plan.action !== 'error' && plan.action !== 'skip') {
        const written = await applyWrite(
          {
            tx,
            workspaceId,
            createId: dependencies.createId,
            now: dependencies.now(),
            actor,
            recordActivity: dependencies.recordActivity,
            sourceName: job.fileName ?? 'a CSV import',
          },
          plan,
        )

        if (plan.action === 'create') {
          emitImportedRecordCreated(events, written.objectType, written.recordId)
        } else if (written.changedFields.length > 0) {
          // An update that moved nothing publishes nothing. Re-running the same
          // file must not wake every consumer watching for a change.
          emitImportedRecordUpdated(
            events,
            written.objectType,
            written.recordId,
            written.changedFields,
          )
        }

        // A People affiliation makes a Position, and maybe a Company. Each is its
        // own record with its own module event, whatever the person row did.
        for (const side of written.sideRecords ?? []) {
          if (side.created) {
            emitImportedRecordCreated(events, side.objectType, side.recordId)
          } else if (side.changedFields.length > 0) {
            emitImportedRecordUpdated(events, side.objectType, side.recordId, side.changedFields)
          }
        }
      }

      // In the same transaction as the record it wrote, so the account of the
      // line and the record it made either both land or neither does.
      await repository.recordRowOutcome(
        tx,
        workspaceId,
        job.id,
        line.values,
        outcome,
        dependencies.now(),
      )

      return outcome
    }, { workspaceId, actor: toEventActor(actor) })
  }

  /**
   * Applies every row of a job.
   *
   * One transaction per row rather than one per batch. A batch would be fewer
   * round trips, and a single row hitting a unique constraint would abort the
   * transaction it shares with ninety-nine others, turning one bad row into a
   * hundred. Containment is worth the commits here: this already runs in the
   * background for anything large.
   */
  async function runCommit(
    workspaceId: string,
    actor: Actor,
    jobId: string,
    parsed: ParsedCsv,
  ): Promise<void> {
    const job = await requireJob(workspaceId, jobId)
    const { rows, values } = readFile(job, parsed)
    const counts = { ...EMPTY_COUNTS, total: rows.length }
    const outcomes: repository.RowOutcome[] = []
    let sinceProgress = 0

    for (const row of rows) {
      const line = values.get(row.row)

      if (line === undefined) {
        throw new Error(`unreachable: line ${String(row.row)} is missing from its own parse`)
      }

      // A line that throws is a row error, not the end of the import. The other
      // nine thousand have nothing to do with it.
      const outcome = await commitRow(workspaceId, actor, job, line).catch(
        async (error: unknown): Promise<repository.RowOutcome> => {
          const failure = {
            rowNumber: row.row,
            action: 'error' as const,
            errors: [{ field: '', message: describeThrown(error) }],
            warnings: [],
          }

          // Its own statement: the transaction that would have carried this one
          // is the one that just rolled back.
          await repository.recordRowOutcome(
            dependencies.db,
            workspaceId,
            jobId,
            line.values,
            failure,
            dependencies.now(),
          )

          return failure
        },
      )

      outcomes.push({ ...outcome })
      counts[outcome.action] += 1
      sinceProgress += 1

      if (sinceProgress >= COMMIT_PROGRESS_INTERVAL) {
        sinceProgress = 0
        await repository.updateJob(dependencies.db, workspaceId, jobId, {
          counts,
          updatedAt: dependencies.now(),
        })
      }
    }

    await repository.updateJob(dependencies.db, workspaceId, jobId, {
      status: 'completed',
      counts,
      // Replaced with what actually happened. A dry run's forecast and a
      // commit's outcome can differ, and the job reports the later one.
      ...reportOf(outcomes, rows),
      updatedAt: dependencies.now(),
    })

    await dependencies.transaction(({ events }) => {
      events.emit(
        'imports.job.completed',
        { type: 'import_job', id: jobId },
        { object: job.object },
      )

      return Promise.resolve()
    }, { workspaceId, actor: toEventActor(actor) })
  }

  /**
   * The job body.
   *
   * Everything a caller reads is on the job itself, so this is one row and no
   * query over `import_job_rows`. A job with no pass behind it yet reports empty
   * errors and an empty preview, which is what its columns default to.
   */
  function viewOf(job: ImportJobRecord): ImportJobView {
    return toView(job)
  }

  return {
    async createJob(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const parsed = ((): ReturnType<typeof parseCsv> => {
        try {
          return parseCsv(input.csv)
        } catch (error: unknown) {
          if (error instanceof CsvFormatError) {
            throw AppError.validationFailed(error.message, [
              { field: 'file', message: error.message },
            ])
          }

          throw error
        }
      })()

      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        throw AppError.validationFailed(
          `A file may carry at most ${String(MAX_IMPORT_ROWS)} rows`,
          [{ field: 'file', message: `This one has ${String(parsed.rows.length)}` }],
        )
      }

      const matchKey = requireMatchKey(input.object, input.matchKeyId)
      const columnMap =
        input.columnMap ?? defaultColumnMap(input.source, input.object, parsed.headers)

      requireUsableColumnMap(input.object, matchKey, columnMap, parsed.headers)

      // Consent is a People-only feature. A purpose on any other object is
      // refused up front; mapping the consent columns without one is refused
      // too — the writer would have no purpose to grant against.
      const mapsConsentColumn =
        columnMap.consent_status !== null || columnMap.consent_at !== null
      if (input.consentPurposeId !== null && input.object !== 'people') {
        throw AppError.validationFailed(
          'consent_purpose_id is only accepted on people imports',
          [{ field: 'consent_purpose_id', message: 'People imports only' }],
        )
      }
      if (input.object === 'people' && mapsConsentColumn && input.consentPurposeId === null) {
        throw AppError.validationFailed(
          'Mapping consent_status or consent_at needs a consent_purpose_id on the job',
          [{ field: 'consent_purpose_id', message: 'Required when consent columns are mapped' }],
        )
      }

      const id = dependencies.createId('importJob')
      const now = dependencies.now()

      // One row, and no part of the file in it. A caller correcting a mapping
      // over a ten thousand line file leaves one row per attempt rather than ten
      // thousand rows or ten megabytes.
      const job = await repository.insertJob(dependencies.db, {
        id,
        workspaceId,
        source: input.source,
        object: input.object,
        status: 'pending',
        conflictMode: input.conflictMode,
        onMissingCompany: input.onMissingCompany,
        matchKey: matchKey.id,
        columnMap,
        consentPurposeId: input.consentPurposeId,
        sourceHeaders: parsed.headers,
        counts: { ...EMPTY_COUNTS, total: parsed.rows.length },
        errors: [],
        warnings: [],
        preview: [],
        fileSha256: fileDigest(input.csv),
        fileName: input.fileName,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      })

      if (parsed.rows.length <= SYNC_IMPORT_ROWS) {
        await runDryRun(workspaceId, id, parsed)

        return viewOf(await requireJob(workspaceId, id))
      }

      const validating = await repository.updateJob(dependencies.db, workspaceId, id, {
        status: 'validating',
        updatedAt: dependencies.now(),
      })

      detach(workspaceId, id, () => runDryRun(workspaceId, id, parsed))

      return viewOf(validating ?? job)
    },

    async getJob(actor, id) {
      return viewOf(await requireJob(requireWorkspaceId(actor), id))
    },

    /**
     * Commits a job that a dry run left `ready`, applying the file handed back.
     *
     * Re-committing a `completed` job answers with it and writes nothing, per
     * `import-export.md`, and does not need the file to do so. Anything else is
     * a conflict: a job still validating has no plan to apply, one already
     * committing is being applied by somebody else, and a failed one has nothing
     * to apply.
     */
    async commit(actor, id, csv) {
      const workspaceId = requireWorkspaceId(actor)
      const job = await requireJob(workspaceId, id)

      // Checked before the file, so a caller re-POSTing a finished job gets the
      // documented no-op whether or not they still have it.
      if (job.status === 'completed') {
        return viewOf(job)
      }

      requireForecastFile(job, csv)

      const parsed = parseCsv(csv)

      // Compare-and-set rather than a check followed by a write: two commits
      // arriving together both read `ready`, and only the one whose update
      // matched a row may proceed.
      const claimed = await repository.moveJobStatus(dependencies.db, workspaceId, id, 'ready', {
        status: 'committing',
        updatedAt: dependencies.now(),
      })

      if (claimed === undefined) {
        throw AppError.conflict(`An import job in status "${job.status}" cannot be committed`, [
          { field: 'status', message: 'Only a job a dry run left ready can be committed' },
        ])
      }

      if (claimed.counts.total <= SYNC_IMPORT_ROWS) {
        await runCommit(workspaceId, actor, id, parsed)

        return viewOf(await requireJob(workspaceId, id))
      }

      detach(workspaceId, id, () => runCommit(workspaceId, actor, id, parsed))

      return viewOf(claimed)
    },

    /**
     * Deletes a job and its stored rows.
     *
     * The delete carries the status predicate rather than checking first, so a
     * commit arriving in between claims the job and this finds nothing to
     * remove. Only then is the job read again, to answer with the reason: gone
     * is a `404` and in-flight is a `409`, and one query on the happy path tells
     * neither of those stories wrongly.
     */
    async deleteJob(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const removed = await repository.deleteJob(
        dependencies.db,
        workspaceId,
        id,
        DELETABLE_STATUSES,
      )

      if (removed > 0) {
        return
      }

      const job = await requireJob(workspaceId, id)

      throw AppError.conflict(`An import job in status "${job.status}" cannot be deleted`, [
        {
          field: 'status',
          message: 'Wait for the pass working through it to finish, then delete it',
        },
      ])
    },

    exportCsv(actor, object) {
      return streamExport(dependencies.db, requireWorkspaceId(actor), object)
    },

    templateCsv(object) {
      return csvLine(templateHeadersFor(object))
    },
  }
}
