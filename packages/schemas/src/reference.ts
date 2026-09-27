import { z } from 'zod'

import { RECORD_TARGET_TYPES } from './values.ts'
import type { RecordTargetType } from './values.ts'
import { idSchema } from './wire.ts'

/**
 * Records that a row's free text cites.
 *
 * Text cites a record in one of two ways, and both are read the same way:
 *
 * - **A plain id.** An agent writing a note cites the records it read:
 *   `Partnership prt_01M1…`.
 * - **A link token.** `[[company:com_01M1…|Acme]]`, which is what the note
 *   editor's `[[` picker inserts. `company` names the type, `com_01M1…` the
 *   record, and `Acme` is the label the writer saw. `|Acme` may be left off.
 *
 * The server finds every id in the text, keeps the ones that exist in the
 * workspace, and names each one, so a reader can follow the citation without a
 * request per id. The name is the record's current name, not the token's label:
 * the label is only what to show when the record no longer resolves. The stored
 * text is never changed.
 */

/**
 * What a citation may point at: every record target, plus Roles, handbook pages,
 * Lists and Forms, which have pages of their own, and Notes, Decisions and Plan
 * items, which do not. A citation of one of those last three carries the record
 * it is on as its `parent`, and a reader opens that record's page.
 */
export const RECORD_REFERENCE_TYPES = [
  ...RECORD_TARGET_TYPES,
  'role',
  'handbook_page',
  'list',
  'form',
  'note',
  'decision',
  'plan_item',
] as const

export type RecordReferenceType = (typeof RECORD_REFERENCE_TYPES)[number]

const REFERENCE_TYPES = new Set<string>(RECORD_REFERENCE_TYPES)

export function isRecordReferenceType(value: string): value is RecordReferenceType {
  return REFERENCE_TYPES.has(value)
}

/**
 * A cited record, named.
 *
 * `targetId` is the exact string that appears in the text. A client finds it
 * there by string match; it does not need to know the id format.
 */
export interface RecordReference {
  readonly targetType: RecordReferenceType
  readonly targetId: string
  readonly name: string
  /** The record a Note, Decision or Plan item is on. Null for every other type. */
  readonly parent: { readonly type: RecordTargetType; readonly id: string } | null
}

export const recordReferenceSchema: z.ZodType<RecordReference, unknown> = z
  .object({
    target_type: z.enum(RECORD_REFERENCE_TYPES),
    target_id: idSchema,
    name: z.string(),
    parent_type: z.enum(RECORD_TARGET_TYPES).nullish(),
    parent_id: idSchema.nullish(),
  })
  .transform(
    (wire): RecordReference => ({
      targetType: wire.target_type,
      targetId: wire.target_id,
      name: wire.name,
      parent:
        wire.parent_type === null ||
        wire.parent_type === undefined ||
        wire.parent_id === null ||
        wire.parent_id === undefined
          ? null
          : { type: wire.parent_type, id: wire.parent_id },
    }),
  )

/** A `[[type:id|Label]]` token as written. Nothing here says the record exists. */
export interface RecordLinkToken {
  readonly targetType: RecordReferenceType
  readonly targetId: string
  /** What the writer saw. Null when the token carried none. */
  readonly label: string | null
}

/**
 * One token. The type is matched loosely and checked afterwards, so a token with
 * an unknown type stays plain text rather than being half-matched. A label cannot
 * hold `]`, `|` or a line break; `formatRecordLinkToken` strips them.
 */
const TOKEN = /\[\[([a-z_]+):([A-Za-z0-9_-]+)(?:\|([^\]|\n]*))?\]\]/gu

/** Text split around its link tokens. */
export type RecordLinkTokenSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'token'; readonly token: RecordLinkToken }

/** Splits text into plain runs and tokens, in order. */
export function splitRecordLinkTokens(text: string): readonly RecordLinkTokenSegment[] {
  const segments: RecordLinkTokenSegment[] = []
  let cursor = 0

  for (const match of text.matchAll(TOKEN)) {
    const [whole, targetType, targetId, rawLabel] = match

    if (targetType === undefined || targetId === undefined || !isRecordReferenceType(targetType)) {
      continue
    }

    if (match.index > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, match.index) })
    }

    const label = rawLabel?.trim() ?? ''

    segments.push({
      kind: 'token',
      token: { targetType, targetId, label: label.length === 0 ? null : label },
    })
    cursor = match.index + whole.length
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }

  return segments
}

/** The token for one record. A label is cleaned so it cannot end the token early. */
export function formatRecordLinkToken(token: {
  readonly targetType: RecordReferenceType
  readonly targetId: string
  readonly label?: string | null | undefined
}): string {
  const label = (token.label ?? '').replace(/[\]|\n\r]/gu, ' ').replace(/\s+/gu, ' ').trim()
  const head = `[[${token.targetType}:${token.targetId}`

  return label.length === 0 ? `${head}]]` : `${head}|${label}]]`
}
