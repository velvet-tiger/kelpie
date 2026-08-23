import { z } from 'zod'

import { idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire shapes and shared catalogues for `/v1/import` and `/v1/export`, per
 * `import-export.md`.
 *
 * The column catalogue lives here rather than in the server module because both
 * ends need it: the server validates a row against it, and the browser renders
 * the mapping table from it. The source presets do not, so they stay server-side
 * — a caller sends a `column_map` and never has to know how one was derived.
 */

export const IMPORT_SOURCES = ['custom', 'hubspot', 'salesforce', 'attio'] as const
export const IMPORT_OBJECTS = ['companies', 'people', 'positions', 'deals'] as const
export const IMPORT_CONFLICT_MODES = ['skip', 'update'] as const

/**
 * What a People import does when a row names a company that is not in the
 * workspace yet.
 *
 * `skip` imports the person and leaves the affiliation unlinked, reporting it as
 * a row warning. `create` invents the company from the row's own domain and name
 * so the position can be linked. Only the People import reads this; the other
 * objects fail a missing company outright, per `import-export.md`.
 */
export const ON_MISSING_COMPANY = ['skip', 'create'] as const

/**
 * `pending → validating → ready | failed → committing → completed | failed`.
 *
 * `pending` is the moment between the row insert and the dry run starting. A
 * synchronous job passes through it inside one request and is never observed
 * there; an asynchronous one can be.
 */
export const IMPORT_JOB_STATUSES = [
  'pending',
  'validating',
  'ready',
  'committing',
  'completed',
  'failed',
] as const

/**
 * What a dry run forecasts for a row, and what a commit records against it.
 *
 * `pending` is a row that has been stored but not yet planned, which is what
 * every row of an asynchronous job is until its validation pass reaches it. The
 * counts only ever hold the four settled actions.
 */
export const IMPORT_ROW_ACTIONS = ['pending', 'create', 'update', 'skip', 'error'] as const

export type ImportSource = (typeof IMPORT_SOURCES)[number]
export type ImportObject = (typeof IMPORT_OBJECTS)[number]
export type ImportConflictMode = (typeof IMPORT_CONFLICT_MODES)[number]
export type OnMissingCompany = (typeof ON_MISSING_COMPANY)[number]
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number]
export type ImportRowAction = (typeof IMPORT_ROW_ACTIONS)[number]

/** A row that has been planned. What a dry run and a commit both write back. */
export type SettledRowAction = Exclude<ImportRowAction, 'pending'>

/** Limits from `import-export.md`. Placeholders until billing exists. */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024
export const MAX_IMPORT_ROWS = 10_000

/**
 * Above this many rows a job validates and commits in the background, and the
 * request answers `202` with the job in a transient status. The caller polls
 * `GET /v1/import/jobs/{id}`.
 */
export const SYNC_IMPORT_ROWS = 500

/** Mapped rows returned with a job, so a caller can check the mapping before committing. */
export const IMPORT_PREVIEW_ROWS = 5

/**
 * Row errors carried on the job body. `counts.error` is the true total, so a
 * truncated list is visible rather than mistaken for the whole story.
 */
export const IMPORT_REPORTED_ERRORS = 50

export const OBJECT_LABELS: Readonly<Record<ImportObject, string>> = {
  companies: 'Companies',
  people: 'People',
  positions: 'Positions',
  deals: 'Deals',
}

export const SOURCE_LABELS: Readonly<Record<ImportSource, string>> = {
  custom: 'Custom CSV',
  hubspot: 'HubSpot CSV pack',
  salesforce: 'Salesforce CSV pack',
  attio: 'Attio CSV pack',
}

export const CONFLICT_MODE_LABELS: Readonly<Record<ImportConflictMode, string>> = {
  skip: 'Skip existing',
  update: 'Update existing',
}

export const ON_MISSING_COMPANY_LABELS: Readonly<Record<OnMissingCompany, string>> = {
  skip: 'Skip and report',
  create: 'Create the company',
}

export interface CsvColumn {
  /** The Kelpie CSV header, and the key a `column_map` is keyed by. */
  readonly key: string
  readonly label: string
  readonly required: boolean
  /**
   * A column an import may map but an export never writes.
   *
   * The People affiliation columns are the only ones: a person can hold many
   * positions, so a single company and title on the person row would be lossy on
   * the way out. They map on the way in to drive a Position, and the export and
   * template leave them out. See `headersFor`.
   */
  readonly importOnly?: boolean
}

/**
 * The canonical Kelpie CSV columns per object (`import-export.md`).
 *
 * Order is the header order of an export and of a template, so a file Kelpie
 * wrote maps onto itself by exact header match with no preset involved.
 *
 * Job title is never stored on Person: it lives on Position. A People import may
 * still carry `company_domain`, `company_name` and `title`, which drive a
 * Position for the person rather than a field on them. Those three are
 * `importOnly`, so an export and a template leave them out.
 */
export const OBJECT_COLUMNS: Readonly<Record<ImportObject, readonly CsvColumn[]>> = {
  companies: [
    { key: 'name', label: 'Name', required: true },
    { key: 'domain', label: 'Domain', required: true },
    { key: 'industry', label: 'Industry', required: false },
    { key: 'stage', label: 'Stage', required: false },
    { key: 'size_band', label: 'Size band', required: false },
    { key: 'account_type', label: 'Account type', required: false },
    { key: 'icp_fit', label: 'ICP fit', required: false },
    { key: 'description', label: 'Description', required: false },
    { key: 'summary', label: 'Summary', required: false },
    { key: 'tags', label: 'Tags', required: false },
    { key: 'website', label: 'Website', required: false },
    { key: 'hq', label: 'HQ', required: false },
  ],
  people: [
    { key: 'name', label: 'Name', required: true },
    { key: 'email', label: 'Email', required: true },
    { key: 'timezone', label: 'Timezone', required: false },
    { key: 'location', label: 'Location', required: false },
    { key: 'preferred_channel', label: 'Preferred channel', required: false },
    { key: 'influence', label: 'Influence', required: false },
    { key: 'relationship', label: 'Relationship', required: false },
    { key: 'summary', label: 'Summary', required: false },
    { key: 'tags', label: 'Tags', required: false },
    { key: 'phones', label: 'Phones', required: false },
    { key: 'company_domain', label: 'Company domain', required: false, importOnly: true },
    { key: 'company_name', label: 'Company name', required: false, importOnly: true },
    { key: 'title', label: 'Title', required: false, importOnly: true },
  ],
  positions: [
    { key: 'person_email', label: 'Person email', required: true },
    { key: 'company_domain', label: 'Company domain', required: true },
    { key: 'title', label: 'Title', required: true },
  ],
  deals: [
    { key: 'name', label: 'Name', required: true },
    { key: 'company_domain', label: 'Company domain', required: true },
    { key: 'stage', label: 'Stage', required: true },
    { key: 'value', label: 'Value', required: true },
    { key: 'owner_email', label: 'Owner email', required: false },
    { key: 'expected_close', label: 'Expected close', required: false },
    { key: 'person_emails', label: 'Person emails', required: false },
    { key: 'competitors', label: 'Competitors', required: false },
    { key: 'risks', label: 'Risks', required: false },
    { key: 'why_win', label: 'Why we win', required: false },
    { key: 'summary', label: 'Summary', required: false },
    { key: 'tags', label: 'Tags', required: false },
    { key: 'external_id', label: 'External id', required: false },
  ],
}

/** Columns whose value is a pipe-separated list (`a|b|c`), per `import-export.md`. */
export const LIST_COLUMNS: ReadonlySet<string> = new Set([
  'tags',
  'phones',
  'competitors',
  'person_emails',
  'tech_stack',
])

export interface MatchKeyOption {
  /** The `match_key` a request sends. Composite keys join their columns with `|`. */
  readonly id: string
  readonly label: string
  /** Kelpie columns the key is built from. Every one must be mapped and non-empty. */
  readonly columns: readonly string[]
}

/** Selectable match keys per object. The first of each list is the default. */
export const MATCH_KEYS: Readonly<Record<ImportObject, readonly MatchKeyOption[]>> = {
  companies: [
    { id: 'domain', label: 'domain', columns: ['domain'] },
    { id: 'name', label: 'name', columns: ['name'] },
  ],
  people: [{ id: 'email', label: 'email', columns: ['email'] }],
  positions: [
    {
      id: 'person_email|company_domain|title',
      label: 'person_email + company_domain + title',
      columns: ['person_email', 'company_domain', 'title'],
    },
    {
      id: 'person_email|company_domain',
      label: 'person_email + company_domain',
      columns: ['person_email', 'company_domain'],
    },
  ],
  deals: [
    { id: 'external_id', label: 'external_id', columns: ['external_id'] },
    {
      id: 'name|company_domain',
      label: 'name + company_domain',
      columns: ['name', 'company_domain'],
    },
  ],
}

export function defaultMatchKeyId(object: ImportObject): string {
  const [first] = MATCH_KEYS[object]

  if (first === undefined) {
    throw new Error(`No match keys declared for ${object}`)
  }

  return first.id
}

/** @returns The named key, or undefined when no such key exists for this object. */
export function findMatchKey(object: ImportObject, matchKeyId: string): MatchKeyOption | undefined {
  return MATCH_KEYS[object].find((key) => key.id === matchKeyId)
}

/**
 * Kelpie columns a job must have mapped: the object's required ones plus every
 * column the chosen match key is built from.
 */
export function requiredColumns(object: ImportObject, matchKey: MatchKeyOption): readonly string[] {
  const required = OBJECT_COLUMNS[object].filter((column) => column.required).map((c) => c.key)

  return [...new Set([...required, ...matchKey.columns])]
}

export interface ImportRowError {
  /** The line in the file, counting the header as line 1. */
  readonly row: number
  readonly field: string
  readonly message: string
}

export interface ImportCounts {
  readonly total: number
  readonly create: number
  readonly update: number
  readonly skip: number
  readonly error: number
}

/** A mapped row as Kelpie read it, for checking a column map before committing. */
export interface ImportPreviewRow {
  readonly row: number
  readonly action: ImportRowAction
  /** Kelpie column → value, for the mapped columns only. */
  readonly values: Readonly<Record<string, string>>
}

/**
 * A `column_map`: Kelpie column → source header, or null to ignore the column.
 *
 * A key absent from the map means the same as null. Both are the ordinary way to
 * say a file has no such column.
 */
export type ImportColumnMap = Readonly<Record<string, string | null>>

export interface ImportJob extends RecordTimestamps {
  readonly id: string
  readonly source: ImportSource
  readonly object: ImportObject
  readonly status: ImportJobStatus
  readonly conflictMode: ImportConflictMode
  /** What a People import does with a row naming an absent company. `skip` for every other object. */
  readonly onMissingCompany: OnMissingCompany
  readonly matchKey: string
  readonly columnMap: ImportColumnMap
  /** The headers as they appeared in the uploaded file, in file order. */
  readonly sourceHeaders: readonly string[]
  readonly fileName: string | null
  readonly counts: ImportCounts
  /** At most `IMPORT_REPORTED_ERRORS`. `counts.error` is the true number of failing rows. */
  readonly errors: readonly ImportRowError[]
  /**
   * Non-fatal notes about rows that were imported. A People row whose company is
   * absent under `on_missing_company: skip` lands here: the person imported, the
   * position did not. At most `IMPORT_REPORTED_ERRORS`.
   */
  readonly warnings: readonly ImportRowError[]
  readonly preview: readonly ImportPreviewRow[]
}

const countsSchema = z.object({
  total: z.number().int(),
  create: z.number().int(),
  update: z.number().int(),
  skip: z.number().int(),
  error: z.number().int(),
})

const rowErrorSchema = z.object({
  row: z.number().int(),
  field: z.string(),
  message: z.string(),
})

const previewRowSchema = z.object({
  row: z.number().int(),
  action: z.enum(IMPORT_ROW_ACTIONS),
  values: z.record(z.string(), z.string()),
})

/**
 * `workspace_id` is not on this body, unlike the sample in `import-export.md`.
 * `api.md` makes the workspace implicit on every endpoint and no other resource
 * returns it; one that did would be the odd one out for no gain.
 */
export const importJobSchema: z.ZodType<ImportJob, unknown> = z
  .object({
    id: idSchema,
    source: z.enum(IMPORT_SOURCES),
    object: z.enum(IMPORT_OBJECTS),
    status: z.enum(IMPORT_JOB_STATUSES),
    conflict_mode: z.enum(IMPORT_CONFLICT_MODES),
    on_missing_company: z.enum(ON_MISSING_COMPANY),
    match_key: z.string(),
    column_map: z.record(z.string(), z.string().nullable()),
    source_headers: z.array(z.string()),
    file_name: z.string().nullable(),
    counts: countsSchema,
    errors: z.array(rowErrorSchema),
    warnings: z.array(rowErrorSchema),
    preview: z.array(previewRowSchema),
    ...recordTimestamps,
  })
  .transform(
    (wire): ImportJob => ({
      id: wire.id,
      source: wire.source,
      object: wire.object,
      status: wire.status,
      conflictMode: wire.conflict_mode,
      onMissingCompany: wire.on_missing_company,
      matchKey: wire.match_key,
      columnMap: wire.column_map,
      sourceHeaders: wire.source_headers,
      fileName: wire.file_name,
      counts: wire.counts,
      errors: wire.errors,
      warnings: wire.warnings,
      preview: wire.preview,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

/** Statuses a job will not move on from without another request. */
export function isImportJobSettled(status: ImportJobStatus): boolean {
  return status === 'ready' || status === 'completed' || status === 'failed'
}
