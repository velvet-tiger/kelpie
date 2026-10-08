import type { WriteOrigin } from '@kelpie/schemas'

import { Chip } from './Chip.tsx'

/**
 * Says when a Note or a Decision was not written by a member.
 *
 * A member's row shows nothing: that is the ordinary case, and a label on
 * every row would hide the ones that matter. A row from before origin was
 * recorded (`unknown`) shows nothing either: there is nothing true to say
 * about it. The server sets `origin` from the caller, so the label does not
 * depend on what the text says about itself.
 */

const ORIGIN_LABELS: Readonly<Record<WriteOrigin, string | null>> = {
  member: null,
  unknown: null,
  agent: 'Written by an agent',
  ai: 'Written by AI',
}

export function OriginLabel({ origin }: { readonly origin: WriteOrigin }): React.JSX.Element | null {
  const label = ORIGIN_LABELS[origin]

  return label === null ? null : <Chip>{label}</Chip>
}
