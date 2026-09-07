import type { EventAssociationTargetType } from '@kelpie/schemas'
import { Link } from 'react-router'

import { useEventAssociationsFor } from '../api/resources/eventAssociations.ts'
import { ErrorPanel } from './QueryState.tsx'
import { SectionHeader } from './SectionHeader.tsx'

/**
 * Events associated with another record (a Deal, Company, Role, …).
 *
 * Registrants are Attendances on the Person, not this list.
 */

export function LinkedEventsPanel({
  targetType,
  targetId,
}: {
  readonly targetType: EventAssociationTargetType
  readonly targetId: string
}): React.JSX.Element {
  const { associations, isLoading, error } = useEventAssociationsFor(targetType, targetId)

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  return (
    <div>
      <SectionHeader title="Events" />
      {isLoading && <p className="text-[13px] text-ink-faint">Loading events…</p>}
      {!isLoading && associations.length === 0 && (
        <p className="text-[13px] text-ink-faint">No events linked yet.</p>
      )}
      {associations.length > 0 && (
        <ul className="divide-y divide-border">
          {associations.map((row) => (
            <li key={row.eventId} className="py-2">
              <Link
                to={`/events/${row.eventId}`}
                className="text-[13px] font-medium text-accent hover:underline"
              >
                {row.eventName}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
