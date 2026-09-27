import type { RecordReference } from '@kelpie/schemas'
import { Link } from 'react-router'

import { referenceHref } from '../lib/recordLinks.ts'
import { splitOnReferences, unresolvedLabel } from '../lib/recordReferences.ts'

/**
 * Plain text with each cited record id shown as the record's name, linked to
 * its page. A record with no page of its own shows its name without a link.
 * The id stays in the tooltip, so nothing the author wrote is lost. A
 * `[[type:id|Label]]` token for a record that is gone shows its label.
 */
export function LinkedText({
  text,
  references,
}: {
  readonly text: string
  readonly references: readonly RecordReference[]
}): React.JSX.Element {
  return (
    <>
      {splitOnReferences(text, references).map((segment, index) => {
        if (segment.kind === 'text') {
          return segment.text
        }

        if (segment.kind === 'unresolved') {
          return (
            <span key={`${String(index)}-${segment.token.targetId}`} title={segment.token.targetId}>
              {unresolvedLabel(segment.token)}
            </span>
          )
        }

        const { reference } = segment
        const href = referenceHref(reference)
        const key = `${String(index)}-${reference.targetId}`

        return href === undefined ? (
          <span key={key} title={reference.targetId} className="text-ink-muted">
            {reference.name}
          </span>
        ) : (
          <Link key={key} to={href} title={reference.targetId} className="text-accent hover:underline">
            {reference.name}
          </Link>
        )
      })}
    </>
  )
}
