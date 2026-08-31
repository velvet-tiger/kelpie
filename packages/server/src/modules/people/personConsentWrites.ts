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
 * @returns The change that landed — with the previous status so a caller can
 *   file a "no change" as a no-op activity.
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
  const [existing] = await tx
    .select({ status: personConsents.status })
    .from(personConsents)
    .where(
      and(eq(personConsents.personId, personId), eq(personConsents.purposeId, purposeId)),
    )
    .limit(1)

  const previousStatus = (existing?.status ?? null) as ConsentStatus | null

  if (status === null) {
    if (existing !== undefined) {
      await tx
        .delete(personConsents)
        .where(
          and(eq(personConsents.personId, personId), eq(personConsents.purposeId, purposeId)),
        )
    }
    return { purposeSlug, purposeLabel, status: null, previousStatus }
  }

  await tx
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
    })

  return { purposeSlug, purposeLabel, status, previousStatus }
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

