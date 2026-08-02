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

/** Referencing tables, as the domain names a user of the API would recognise. */
const REFERENCING_TYPE_BY_TABLE: Readonly<Record<string, string>> = {
  candidates: 'candidate',
  deal_people: 'deal',
  deals: 'deal',
  form_submissions: 'form submission',
  forms: 'form',
  opportunities: 'opportunity',
  partnership_people: 'partnership',
  partnerships: 'partnership',
  raise_people: 'raise',
  raises: 'raise',
  workspace_members: 'team member',
}

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
