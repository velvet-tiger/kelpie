import type { PipelineKind } from '@kelpie/schemas'
import { PIPELINE_KINDS } from '@kelpie/schemas'

import { referenceViolationTable } from '../lib/database.ts'
import { AppError } from '../lib/errors.ts'

/**
 * Roadmap decision 2: a delete blocked by an independent reference is a 409 that
 * names what is still pointing at the record, so the caller knows what to detach.
 *
 * The database refuses first. This turns its refusal into the wire shape rather
 * than trying to predict it: a pre-flight count would still race a concurrent
 * insert, and would need updating every time a table gains a foreign key.
 */

/**
 * Referencing tables, as the domain names a user of the API would recognise.
 *
 * `person_links` is deliberately absent: its `target_type` is one of four
 * pipeline kinds and the row itself names which, so a caller reads
 * `referencedByPipelineRecords` for that path instead of losing detail to a
 * generic "person link" label.
 */
const REFERENCING_TYPE_BY_TABLE: Readonly<Record<string, string>> = {
  candidates: 'candidate',
  deals: 'deal',
  enquiries: 'enquiry',
  form_submissions: 'form submission',
  forms: 'form',
  opportunities: 'opportunity',
  partnerships: 'partnership',
  raises: 'raise',
  workspace_members: 'team member',
}

const PIPELINE_KIND_ORDER: ReadonlyMap<PipelineKind, number> = new Map(
  PIPELINE_KINDS.map((kind, index) => [kind, index] as const),
)

/**
 * @param subject The record being deleted, e.g. `person`. Appears in the message.
 * @returns A 409. The referencing type is omitted when the driver did not report
 *   a table, which is a worse message but still the right status.
 */
export function referencedElsewhere(error: unknown, subject: string): AppError {
  const table = referenceViolationTable(error)
  const type = table === undefined ? undefined : (REFERENCING_TYPE_BY_TABLE[table] ?? table)

  if (type === undefined) {
    return AppError.conflict(`This ${subject} is still referenced by another record`)
  }

  return AppError.conflict(`This ${subject} is still referenced by a ${type}`, [
    { field: 'id', message: `Referenced by ${type}` },
  ])
}

/**
 * The 409 for a person delete that `person_links` refused. The service queries
 * the distinct target types still pointing at the person and passes them here,
 * so the reply names one detail per pipeline the person is on (in
 * `PIPELINE_KINDS` order, matching how the pipelines appear across the UI).
 * Falls back to the generic wording only when the query came back empty, which
 * is the delete-races-another-delete race — still a 409, just less specific.
 */
export function referencedByPipelineRecords(
  subject: string,
  types: readonly PipelineKind[],
): AppError {
  if (types.length === 0) {
    return AppError.conflict(`This ${subject} is still referenced by another record`)
  }

  const ordered = [...types].sort(
    (left, right) => (PIPELINE_KIND_ORDER.get(left) ?? 0) - (PIPELINE_KIND_ORDER.get(right) ?? 0),
  )
  const [first] = ordered

  return AppError.conflict(
    `This ${subject} is still referenced by a ${first}`,
    ordered.map((type) => ({ field: 'id', message: `Referenced by ${type}` })),
  )
}
