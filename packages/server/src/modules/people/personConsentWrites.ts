import type { ConsentStatus } from '@kelpie/schemas'
import { and, eq, inArray } from 'drizzle-orm'

import { AppError } from '../../lib/errors.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { consentPurposes } from '../consent-purposes/schema.ts'
import { personConsents } from './schema.ts'

/**
 * Writes to `person_consents`, shared by the manual PATCH override and every
 * capture site (forms, imports). Every write is idempotent — a second
 * grant for the same (person, purpose) with the same source is a no-op.
 *
 * `source` follows the shape in `docs/privacy.md`:
 * `form:<form_id>` | `list:<list_id>` | `import` | `manual`.
 */

export interface ConsentWriteChange {
  readonly purposeSlug: string
  readonly purposeLabel: string
  readonly status: ConsentStatus | null
  readonly previousStatus: ConsentStatus | null
}

export interface ConsentWriteInput {
  readonly purposeSlug: string
  readonly status: ConsentStatus | null
}

interface PurposeRow {
  readonly id: string
  readonly slug: string
  readonly label: string
}

async function resolvePurposesBySlug(
  tx: Transaction,
  workspaceId: string,
  slugs: readonly string[],
): Promise<ReadonlyMap<string, PurposeRow>> {
  if (slugs.length === 0) return new Map()
  const rows = await tx
    .select({
      id: consentPurposes.id,
      slug: consentPurposes.slug,
      label: consentPurposes.label,
    })
    .from(consentPurposes)
    .where(
      and(
        eq(consentPurposes.workspaceId, workspaceId),
        inArray(consentPurposes.slug, [...slugs]),
      ),
    )
  return new Map(rows.map((row) => [row.slug, row]))
}

/**
 * Applies one `PersonConsent` write. `status: null` deletes the row (falls
 * back to the purpose default); any other status upserts it.
 *
 * The key of a row is `(person_id, purpose_id)`, and a Person and a purpose
 * each belong to one workspace. So a row for a pair that the caller read in
 * its own workspace is in that workspace too, and a row that carries another
 * one is damaged data. This function does not read, change or delete such a
 * row: each statement asks for the workspace. To write over it would let a
 * caller that did not check the pair change the consent another workspace
 * holds.
 *
 * @returns The change that landed — with the previous status so a caller can
 *   file a "no change" as a no-op activity.
 * @throws Error when a status is to be set and the row for this pair carries
 *   another workspace.
 */
export async function upsertPersonConsent(
  tx: Transaction,
  workspaceId: string,
  personId: string,
  purposeId: string,
  purposeSlug: string,
  purposeLabel: string,
  status: ConsentStatus | null,
  source: string,
  now: Date,
): Promise<ConsentWriteChange> {
  const ofThisWorkspace = and(
    eq(personConsents.workspaceId, workspaceId),
    eq(personConsents.personId, personId),
    eq(personConsents.purposeId, purposeId),
  )
  const [existing] = await tx
    .select({ status: personConsents.status })
    .from(personConsents)
    .where(ofThisWorkspace)
    .limit(1)

  const previousStatus = (existing?.status ?? null) as ConsentStatus | null

  if (status === null) {
    if (existing !== undefined) {
      await tx.delete(personConsents).where(ofThisWorkspace)
    }
    return { purposeSlug, purposeLabel, status: null, previousStatus }
  }

  const written = await tx
    .insert(personConsents)
    .values({
      workspaceId,
      personId,
      purposeId,
      status,
      notedAt: now,
      source,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [personConsents.personId, personConsents.purposeId],
      set: {
        status,
        notedAt: now,
        source,
        updatedAt: now,
      },
      // The conflict target has no workspace in it, so the update asks for it.
      setWhere: eq(personConsents.workspaceId, workspaceId),
    })
    .returning({ personId: personConsents.personId })

  // No row back means that the conflict was with a row the update refused.
  if (written.length === 0) {
    throw new Error(
      `The consent row of ${personId} for ${purposeId} belongs to another workspace than ${workspaceId}`,
    )
  }

  return { purposeSlug, purposeLabel, status, previousStatus }
}

/**
 * A grant from somebody who showed no credentials: a public form submit.
 *
 * It writes a row only where the person has none for the purpose. It never
 * changes a row that exists, whatever its status. The person is matched by
 * email address alone, so anybody who knows the address can send the form. A
 * withdrawal that such a request could undo would be worth nothing, and a
 * grant a member recorded would lose its date and its source. A person in the
 * workspace can set the consent by hand.
 *
 * One insert that does nothing on a conflict, so a row that lands between a
 * read and this write is not changed either.
 *
 * @returns `applied: true` when this call wrote the grant. Otherwise the
 *   status of the row that was already there, which stays as it was.
 * @throws Error when no row of this workspace is there after the conflict:
 *   the row carries another workspace, or it is gone again.
 */
export async function grantPersonConsentIfAbsent(
  tx: Transaction,
  workspaceId: string,
  personId: string,
  purposeId: string,
  source: string,
  now: Date,
): Promise<{ readonly applied: boolean; readonly status: ConsentStatus }> {
  const written = await tx
    .insert(personConsents)
    .values({
      workspaceId,
      personId,
      purposeId,
      status: 'granted',
      notedAt: now,
      source,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [personConsents.personId, personConsents.purposeId] })
    .returning({ personId: personConsents.personId })

  if (written.length > 0) {
    return { applied: true, status: 'granted' }
  }

  // The conflict target has no workspace in it, so this read asks for it. A
  // row that carries another workspace is not returned, and its status does
  // not reach the caller.
  const [existing] = await tx
    .select({ status: personConsents.status })
    .from(personConsents)
    .where(
      and(
        eq(personConsents.workspaceId, workspaceId),
        eq(personConsents.personId, personId),
        eq(personConsents.purposeId, purposeId),
      ),
    )
    .limit(1)

  if (existing === undefined) {
    throw new Error(
      `Consent of ${personId} for ${purposeId} was neither granted nor found in workspace ${workspaceId} during a form submit`,
    )
  }

  return { applied: false, status: existing.status as ConsentStatus }
}

/**
 * Reads by slug for a manual PATCH: resolves each named purpose to its id,
 * refuses an unknown slug with a `422`, and applies the writes. Every write
 * ridden through here uses `source: 'manual'`.
 */
export async function applyManualConsentWrites(
  tx: Transaction,
  workspaceId: string,
  personId: string,
  writes: readonly ConsentWriteInput[],
  now: Date,
): Promise<readonly ConsentWriteChange[]> {
  if (writes.length === 0) return []
  const slugs = writes.map((write) => write.purposeSlug)
  const purposesBySlug = await resolvePurposesBySlug(tx, workspaceId, slugs)

  const missing = slugs.filter((slug) => !purposesBySlug.has(slug))
  if (missing.length > 0) {
    throw AppError.validationFailed(
      'One or more consent purposes were not found in this workspace',
      missing.map((slug) => ({
        field: `consents.${slug}`,
        message: `Unknown consent purpose "${slug}"`,
      })),
    )
  }

  const changes: ConsentWriteChange[] = []
  for (const write of writes) {
    const purpose = purposesBySlug.get(write.purposeSlug)
    if (purpose === undefined) continue // impossible after the check above
    const change = await upsertPersonConsent(
      tx,
      workspaceId,
      personId,
      purpose.id,
      purpose.slug,
      purpose.label,
      write.status,
      'manual',
      now,
    )
    changes.push(change)
  }
  return changes
}

/**
 * The `changed` paths a person update event emits for consent writes. Names
 * every purpose that actually moved, shaped as `consents.<slug>`.
 */
export function consentChangedPaths(changes: readonly ConsentWriteChange[]): readonly string[] {
  return changes
    .filter((change) => change.status !== change.previousStatus)
    .map((change) => `consents.${change.purposeSlug}`)
}

