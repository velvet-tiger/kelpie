import { splitRecordLinkTokens } from '@kelpie/schemas'
import type { RecordLinkToken, RecordReference } from '@kelpie/schemas'
import type { Link, Parent, PhrasingContent, Root, Text } from 'mdast'

import { referenceHref } from './recordLinks.ts'

/**
 * Turning the record ids a text cites into something a person can follow.
 *
 * The server already found the ids and named them (`references` on an activity
 * or a note). This side only finds each named id in the text by string match.
 * An id the server did not name stays as it is: it is not a record in this
 * workspace, and a link to it would go nowhere.
 *
 * Text cites a record in two ways, and one pass reads both. A `[[type:id|Label]]`
 * link token is read first, so the id inside it is never matched a second time as
 * a bare id. The text between tokens is then searched for bare ids. A token the
 * server named shows the record's current name; one it did not name shows the
 * token's label as plain text, because the record is gone.
 */

export type TextSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reference'; readonly reference: RecordReference }
  | { readonly kind: 'unresolved'; readonly token: RecordLinkToken }

/** What an unresolved token shows: its label, or its id when it has none. */
export function unresolvedLabel(token: RecordLinkToken): string {
  return token.label ?? token.targetId
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `text` cut into plain runs and cited records, in order.
 *
 * @returns One text segment holding all of `text` when nothing is cited.
 */
export function splitOnReferences(
  text: string,
  references: readonly RecordReference[],
): readonly TextSegment[] {
  const byTokenId = new Map(references.map((reference) => [reference.targetId, reference]))

  return splitRecordLinkTokens(text).flatMap((segment): readonly TextSegment[] => {
    if (segment.kind === 'text') {
      return splitOnBareIds(segment.text, references)
    }

    const reference = byTokenId.get(segment.token.targetId)

    return reference === undefined
      ? [{ kind: 'unresolved', token: segment.token }]
      : [{ kind: 'reference', reference }]
  })
}

/** Bare ids only. Every segment it returns is `text` or `reference`. */
function splitOnBareIds(text: string, references: readonly RecordReference[]): TextSegment[] {
  if (references.length === 0) {
    return text.length === 0 ? [] : [{ kind: 'text', text }]
  }

  const byId = new Map(references.map((reference) => [reference.targetId, reference]))
  // Longest first, so an id can never lose to a shorter one it starts with.
  const ids = [...byId.keys()].sort((left, right) => right.length - left.length)
  const pattern = new RegExp(`(${ids.map(escapeForPattern).join('|')})`)
  const segments: TextSegment[] = []

  // `split` with one capture group puts each match at an odd index.
  text.split(pattern).forEach((part, index) => {
    const reference = index % 2 === 1 ? byId.get(part) : undefined

    if (reference !== undefined) {
      segments.push({ kind: 'reference', reference })
    } else if (part.length > 0) {
      segments.push({ kind: 'text', text: part })
    }
  })

  return segments
}

/** A cited record as a Markdown node: a link to its page, or its name when it has none. */
function referenceNode(reference: RecordReference): Link | Text {
  const href = referenceHref(reference)
  const name: Text = { type: 'text', value: reference.name }

  return href === undefined ? name : { type: 'link', url: href, title: null, children: [name] }
}

/** Node types whose text must stay as written: a link cannot hold a link, and code is literal. */
const LEAVE_ALONE = new Set(['link', 'linkReference', 'code', 'inlineCode'])

function isParent(node: { readonly type: string }): node is Parent {
  return 'children' in node && Array.isArray(node.children)
}

function rewriteChildren(parent: Parent, references: readonly RecordReference[]): void {
  const rewritten: Parent['children'] = []

  for (const child of parent.children) {
    if (child.type === 'text') {
      for (const segment of splitOnReferences(child.value, references)) {
        rewritten.push(
          segment.kind === 'text'
            ? ({ type: 'text', value: segment.text } satisfies PhrasingContent)
            : segment.kind === 'reference'
              ? referenceNode(segment.reference)
              : ({ type: 'text', value: unresolvedLabel(segment.token) } satisfies PhrasingContent),
        )
      }
    } else {
      if (isParent(child) && !LEAVE_ALONE.has(child.type)) {
        rewriteChildren(child, references)
      }

      rewritten.push(child)
    }
  }

  parent.children = rewritten
}

/**
 * A remark plugin: every cited record in the Markdown's text, bare id or link
 * token, becomes a link to the record, labelled with its name. The source string
 * is not touched, so what the author wrote is still what is stored and edited.
 */
export function remarkRecordReferences(
  references: readonly RecordReference[],
): () => (tree: Root) => void {
  // Runs even with no references: a token must still lose its brackets.
  return () => (tree) => {
    rewriteChildren(tree, references)
  }
}
