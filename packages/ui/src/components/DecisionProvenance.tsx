import type { WriteOrigin } from '@kelpie/schemas'

import { Chip } from './Chip.tsx'
import { OriginLabel } from './OriginLabel.tsx'

/**
 * What a reader must know before trusting a Decision: whether a member has
 * confirmed it, and what wrote it.
 *
 * A Decision with no `confirmedAt` is a proposal. A hosted AI run writes one,
 * and so does an agent whose connection cannot commit Decisions. It is shown as
 * not confirmed until a member confirms it. A confirmed one shows only its
 * origin, and nothing at all when a member wrote it.
 */

const NAME_EXCERPT_LENGTH = 60

function excerpt(body: string): string {
  const line = body.replace(/\s+/gu, ' ').trim()

  return line.length <= NAME_EXCERPT_LENGTH ? line : `${line.slice(0, NAME_EXCERPT_LENGTH)}…`
}

/**
 * Says that a confirm succeeded, for a screen reader. A sighted reader sees the
 * row lose its "not confirmed" label; nothing else would tell a reader who
 * cannot. Always in the page, so that the change of its text is announced.
 */
export function ConfirmedAnnouncement({ count }: { readonly count: number }): React.JSX.Element {
  return (
    <p role="status" className="sr-only">
      {count === 0 ? '' : count === 1 ? 'Decision confirmed.' : `${String(count)} decisions confirmed.`}
    </p>
  )
}

/**
 * What a proposal says about itself. The server writes no proposal with
 * `member` or `unknown` today: a member's own Decision is confirmed as it is
 * written, and an agent's rewrite changes the origin to `agent`. The label
 * for those two claims nothing about who proposed it.
 */
const PROPOSAL_LABELS: Readonly<Record<WriteOrigin, string>> = {
  ai: 'Proposed by AI — not confirmed',
  agent: 'Proposed by an agent — not confirmed',
  member: 'Not confirmed',
  unknown: 'Not confirmed',
}

export interface DecisionProvenanceProps {
  readonly origin: WriteOrigin
  readonly confirmedAt: Date | null
}

export function DecisionProvenance({ origin, confirmedAt }: DecisionProvenanceProps): React.JSX.Element | null {
  if (confirmedAt !== null) {
    return <OriginLabel origin={origin} />
  }

  return <Chip tone="warning">{PROPOSAL_LABELS[origin]}</Chip>
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
      // The name replaces the visible text for a screen reader, so it has to
      // change with it while the confirm is in flight.
      aria-label={`${isPending ? 'Confirming' : 'Confirm'} decision: ${excerpt(body)}`}
      aria-busy={isPending}
      className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
    >
      {isPending ? 'Confirming…' : 'Confirm'}
    </button>
  )
}
