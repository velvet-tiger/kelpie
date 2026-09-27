import { isRecordReferenceType, splitRecordLinkTokens } from '@kelpie/schemas'
import type { RecordReference, RecordReferenceType } from '@kelpie/schemas'
import { and, eq, inArray } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import { idPrefixes } from '../lib/ids.ts'
import type { ObjectKind } from '../lib/ids.ts'
import type { Queryable } from '../runtime/transaction.ts'
import { decisions } from './decisions/schema.ts'
import { forms } from './forms/schema.ts'
import { handbookPages } from './handbook/schema.ts'
import { roles } from './hiring/schema.ts'
import { lists } from './lists/schema.ts'
import { notes } from './notes/schema.ts'
import { planItems } from './plans/schema.ts'
import { isRecordTargetType, resolveTargetNames, targetKey } from './recordTargets.ts'
import type { RecordTarget, RecordTargetType } from './recordTargets.ts'

/**
 * Finding the records a piece of free text names by id.
 *
 * An agent that writes a note cites what it read: "Partnership prt_01M1…". The
 * id is precise for the agent and opaque for a person. This reads the ids out of
 * the text so a response can carry each one's name, and a client can turn the
 * id into a link.
 *
 * The text is not changed. The id stays in the stored body, because that is
 * what the author wrote and what an agent reading the note back needs.
 *
 * A `[[type:id|Label]]` link token, which the note editor's picker inserts, needs
 * nothing of its own here: the id inside it is found like any other, and its
 * `type` and label are the client's business. See `RecordReference`.
 */

/** A cited record: any `RecordReferenceType`. */
export interface ReferenceTarget {
  readonly targetType: RecordReferenceType
  readonly targetId: string
}

/**
 * The id-factory kind behind each target type. A new target type fails the
 * build here until it says which prefix its ids carry.
 */
const TARGET_KINDS: Readonly<Record<RecordReferenceType, ObjectKind>> = {
  person: 'person',
  company: 'company',
  deal: 'deal',
  opportunity: 'opportunity',
  partnership: 'partnership',
  raise: 'raise',
  enquiry: 'enquiry',
  candidate: 'candidate',
  event: 'crmEvent',
  attendance: 'attendance',
  role: 'role',
  handbook_page: 'handbookPage',
  list: 'list',
  form: 'form',
  note: 'note',
  decision: 'decision',
  plan_item: 'planItem',
}

const TYPE_BY_PREFIX: ReadonlyMap<string, RecordReferenceType> = new Map(
  (Object.entries(TARGET_KINDS) as [RecordReferenceType, ObjectKind][]).map(
    ([targetType, kind]): [string, RecordReferenceType] => [idPrefixes[kind], targetType],
  ),
)

/**
 * `<prefix>_<ulid>` for every record prefix. A ULID is 26 characters of
 * Crockford base32, which leaves out I, L, O and U. The lookarounds stop a match
 * inside a longer word, so `super_…` never reads as a Person id, and a ULID cut
 * short by an excerpt's truncation does not match at all.
 */
const RECORD_ID_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_])(${[...TYPE_BY_PREFIX.keys()].join('|')})_[0-9A-HJKMNP-TV-Z]{26}(?![A-Za-z0-9_])`,
  'g',
)

/**
 * The record ids in `text`, in the order they first appear, each once.
 *
 * Only the shape is checked. Whether the record exists, and in which workspace,
 * is `resolveReferences`' question.
 */
export function recordIdsIn(text: string | null): readonly ReferenceTarget[] {
  if (text === null) {
    return []
  }

  const seen = new Set<string>()
  const found: ReferenceTarget[] = []

  for (const match of text.matchAll(RECORD_ID_PATTERN)) {
    const [targetId, prefix] = match
    const targetType = prefix === undefined ? undefined : TYPE_BY_PREFIX.get(prefix)

    if (targetType !== undefined && !seen.has(targetId)) {
      seen.add(targetId)
      found.push({ targetType, targetId })
    }
  }

  return found
}

/** The record a Note, Decision or Plan item is on. */
export interface ReferenceParent {
  readonly type: RecordTargetType
  readonly id: string
}

/** Every cited record's name, and the parent of each that has one, keyed by `targetKey`. */
export interface ResolvedReferences {
  readonly names: ReadonlyMap<string, string>
  readonly parents: ReadonlyMap<string, ReferenceParent>
}

/** One reference on the wire. Shared by every response that carries `references`. */
export function referenceResponse(reference: RecordReference): Record<string, unknown> {
  return {
    target_type: reference.targetType,
    target_id: reference.targetId,
    name: reference.name,
    parent_type: reference.parent?.type ?? null,
    parent_id: reference.parent?.id ?? null,
  }
}

/** Builds each row's references from one name lookup over the whole page. */
export type ReferenceReader = (text: string | null) => readonly RecordReference[]

/**
 * The references a row's text makes, from names already resolved.
 *
 * An id with no name is left out: the record does not exist, or it is in
 * another workspace, and either way the reader learns nothing about it.
 */
export function referenceReader(resolved: ResolvedReferences): ReferenceReader {
  return (text) =>
    recordIdsIn(text).flatMap((target) => {
      const key = targetKey(target)
      const name = resolved.names.get(key)

      return name === undefined ? [] : [{ ...target, name, parent: resolved.parents.get(key) ?? null }]
    })
}

/**
 * One record, named, when it resolves: an activity's subject, for example.
 *
 * @returns Null for no target, an unknown type, or a record that is gone.
 */
export function referenceTo(
  resolved: ResolvedReferences,
  targetType: string | null,
  targetId: string | null,
): RecordReference | null {
  if (targetType === null || targetId === null || !isRecordReferenceType(targetType)) {
    return null
  }

  const key = targetKey({ targetType, targetId })
  const name = resolved.names.get(key)

  return name === undefined
    ? null
    : { targetType, targetId, name, parent: resolved.parents.get(key) ?? null }
}

/** How long a name made from prose may be before it is cut. */
const EXCERPT_LENGTH = 80

/**
 * A Note or Decision has no name, so it is called by its first line of text:
 * link tokens read as their labels, leading Markdown marks dropped, and cut at
 * `EXCERPT_LENGTH`.
 */
export function excerptName(body: string): string {
  const plain = splitRecordLinkTokens(body)
    .map((segment) =>
      segment.kind === 'text' ? segment.text : (segment.token.label ?? segment.token.targetId),
    )
    .join('')
  const line =
    plain
      .split('\n')
      .map((candidate) => candidate.replace(/^[\s#>*+-]+/u, '').trim())
      .find((candidate) => candidate.length > 0) ?? ''

  return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : line
}

interface NamedRow {
  readonly id: string
  readonly name: string
  readonly parent?: ReferenceParent
}

/** A table whose name is one column, read for a set of ids in one workspace. */
async function namesFrom(
  db: Queryable,
  workspaceId: string,
  table: { readonly id: PgColumn; readonly workspaceId: PgColumn } & PgTable,
  name: PgColumn,
  ids: readonly string[],
): Promise<readonly NamedRow[]> {
  if (ids.length === 0) {
    return []
  }

  const rows = await db
    .select({ id: table.id, name })
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), inArray(table.id, [...ids])))

  return rows.map((row) => ({ id: String(row.id), name: String(row.name) }))
}

/** A Note, Decision or Plan item, named and placed on the record it belongs to. */
async function attachedFrom(
  db: Queryable,
  workspaceId: string,
  table: typeof notes | typeof decisions | typeof planItems,
  text: PgColumn,
  ids: readonly string[],
  toName: (text: string) => string,
): Promise<readonly NamedRow[]> {
  if (ids.length === 0) {
    return []
  }

  const rows = await db
    .select({ id: table.id, text, targetType: table.targetType, targetId: table.targetId })
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), inArray(table.id, [...ids])))

  return rows.flatMap((row) =>
    isRecordTargetType(row.targetType)
      ? [
          {
            id: row.id,
            name: toName(String(row.text)),
            parent: { type: row.targetType, id: row.targetId },
          },
        ]
      : [],
  )
}

/**
 * What to call each of a mixed set of cited records, and where each attached
 * one lives. `resolveTargetNames` for record targets, plus one query for each
 * other type that is cited at all.
 */
export async function resolveReferenceNames(
  db: Queryable,
  workspaceId: string,
  targets: readonly ReferenceTarget[],
): Promise<ResolvedReferences> {
  const recordTargets: RecordTarget[] = []
  const idsOf = new Map<RecordReferenceType, Set<string>>()

  for (const target of targets) {
    if (isRecordTargetType(target.targetType)) {
      recordTargets.push({ targetType: target.targetType, targetId: target.targetId })
    } else {
      const ids = idsOf.get(target.targetType) ?? new Set<string>()

      ids.add(target.targetId)
      idsOf.set(target.targetType, ids)
    }
  }

  const ids = (type: RecordReferenceType): readonly string[] => [...(idsOf.get(type) ?? [])]

  const [targetNames, ...others] = await Promise.all([
    recordTargets.length === 0
      ? new Map<string, string>()
      : resolveTargetNames(db, workspaceId, recordTargets),
    namesFrom(db, workspaceId, roles, roles.title, ids('role')).then((rows) => ['role', rows] as const),
    namesFrom(db, workspaceId, handbookPages, handbookPages.title, ids('handbook_page')).then(
      (rows) => ['handbook_page', rows] as const,
    ),
    namesFrom(db, workspaceId, lists, lists.name, ids('list')).then((rows) => ['list', rows] as const),
    namesFrom(db, workspaceId, forms, forms.name, ids('form')).then((rows) => ['form', rows] as const),
    attachedFrom(db, workspaceId, notes, notes.body, ids('note'), excerptName).then(
      (rows) => ['note', rows] as const,
    ),
    attachedFrom(db, workspaceId, decisions, decisions.body, ids('decision'), excerptName).then(
      (rows) => ['decision', rows] as const,
    ),
    attachedFrom(db, workspaceId, planItems, planItems.title, ids('plan_item'), (title) => title).then(
      (rows) => ['plan_item', rows] as const,
    ),
  ])

  const names = new Map(targetNames)
  const parents = new Map<string, ReferenceParent>()

  for (const [targetType, rows] of others) {
    for (const row of rows) {
      const key = targetKey({ targetType, targetId: row.id })

      names.set(key, row.name)

      if (row.parent !== undefined) {
        parents.set(key, row.parent)
      }
    }
  }

  return { names, parents }
}

/**
 * One name lookup for the ids in every text of a page, plus any `extra`
 * targets the caller also needs named (a row's own target, for example).
 *
 * @returns The resolved names keyed by `targetKey`, for the caller's own use,
 *   and a reader that turns one row's text into its references.
 */
export async function resolveReferences(
  db: Queryable,
  workspaceId: string,
  texts: readonly (string | null)[],
  extra: readonly ReferenceTarget[] = [],
): Promise<{
  readonly names: ReadonlyMap<string, string>
  readonly resolved: ResolvedReferences
  readonly referencesIn: ReferenceReader
}> {
  const targets = [...extra, ...texts.flatMap((text) => recordIdsIn(text))]
  const resolved: ResolvedReferences =
    targets.length === 0
      ? { names: new Map(), parents: new Map() }
      : await resolveReferenceNames(db, workspaceId, targets)

  return { names: resolved.names, resolved, referencesIn: referenceReader(resolved) }
}
