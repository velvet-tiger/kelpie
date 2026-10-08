import type { WriteOrigin } from '@kelpie/schemas'

import { Chip } from './Chip.tsx'
import { OriginLabel } from './OriginLabel.tsx'

/**
 * What a reader must know before trusting a Decision: whether a member has
 * confirmed it, and what wrote it.
 *
 * A Decision with no `confirmedAt` is a proposal. A hosted AI run wrote it with
 * no person approving the write, so it is shown as not confirmed until a member
 * confirms it. A confirmed one shows only its origin, and nothing at all when a
 * member wrote it.
 */

const NAME_EXCERPT_LENGTH = 60

function excerpt(body: string): string {
  const line = body.replace(/\s+/gu, ' ').trim()

  return line.length <= NAME_EXCERPT_LENGTH ? line : `${line.slice(0, NAME_EXCERPT_LENGTH)}…`
}

export interface DecisionProvenanceProps {
  readonly origin: WriteOrigin
  readonly confirmedAt: Date | null
}

export function DecisionProvenance({ origin, confirmedAt }: DecisionProvenanceProps): React.JSX.Element | null {
  if (confirmedAt !== null) {
    return <OriginLabel origin={origin} />
  }

  return <Chip tone="warning">{origin === 'ai' ? 'Proposed by AI — not confirmed' : 'Not confirmed'}</Chip>
}

/**
 * Confirms a proposal. Shown only on a Decision that is not confirmed.
 *
 * The API refuses every caller but a signed-in member, so this button is the
 * one place a proposal becomes a commitment.
 */
export function ConfirmDecisionButton({
  body,
  onConfirm,
  isPending,
}: {
  /** The Decision's text. Its start goes into the button's name. */
  readonly body: string
  readonly onConfirm: () => void
  readonly isPending: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onConfirm}
      disabled={isPending}
      // A page can hold several of these. A screen reader lists buttons by
      // name, and "Confirm" five times does not say what each one confirms.
      aria-label={`Confirm decision: ${excerpt(body)}`}
      className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
    >
      {isPending ? 'Confirming…' : 'Confirm'}
    </button>
  )
}
