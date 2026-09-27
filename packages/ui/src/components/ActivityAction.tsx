import type { RecordReference } from '@kelpie/schemas'
import { Link } from 'react-router'

import { referenceHref } from '../lib/recordLinks.ts'

/**
 * An activity's action — `added a note`, `linked to company`, `converted to
 * Deal` — linked to the record the row is about, when it has one.
 *
 * The subject is the note that was added, the record linked to, the form
 * something came in through. The server names it with its current name, which
 * the tooltip shows; a subject that is gone arrives as null and the action stays
 * plain text. A Note, Decision or Plan item opens on the record it is on.
 */
export function ActivityAction({
  action,
  subject,
}: {
  readonly action: string
  readonly subject: RecordReference | null
}): React.JSX.Element {
  const href = subject === null ? undefined : referenceHref(subject)

  if (subject === null || href === undefined) {
    return <span className="text-ink-muted">{action}</span>
  }

  return (
    <Link to={href} title={subject.name} className="text-ink-muted hover:text-accent hover:underline">
      {action}
    </Link>
  )
}
