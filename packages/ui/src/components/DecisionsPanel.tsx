import type { Decision, RecordTargetType } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'

import { useTimezone } from '../api/resources/account.ts'
import { useCreateDecision, useDecisions, useDeleteDecision } from '../api/resources/decisions.ts'
import { useMembers } from '../api/resources/members.ts'
import { formatDate } from '../lib/dates.ts'
import { ErrorPanel } from './QueryState.tsx'
import { SectionHeader } from './SectionHeader.tsx'

/**
 * The decisions on one record.
 *
 * Ports the mockup's panel: add, remove, and the workspace-list link. The
 * decision's owner defaults server-side to whoever records it, which is what
 * the mockup's `members[0]` stood in for, so the form does not send one.
 */

export interface DecisionsPanelProps {
  readonly targetType: RecordTargetType
  readonly targetId: string
}

export function DecisionsPanel({ targetType, targetId }: DecisionsPanelProps): React.JSX.Element {
  const decisions = useDecisions({ targetType, targetId })
  const members = useMembers()
  const createDecision = useCreateDecision()
  const deleteDecision = useDeleteDecision()
  const [adding, setAdding] = useState(false)
  const [body, setBody] = useState('')
  const [rationale, setRationale] = useState('')
  const [dueAt, setDueAt] = useState('')

  // Due date first, decided date otherwise, newest down — the mockup's order.
  // The list arrives in `-decided_at` order and the API cannot sort on the
  // nullable `due_at`, so this reorders what is loaded; across a "Load more"
  // boundary the interleave can be wrong, which is the cheaper wrong than a
  // second request per panel.
  const ordered = [...decisions.records].sort(
    (left, right) =>
      (right.dueAt ?? right.decidedAt).getTime() - (left.dueAt ?? left.decidedAt).getTime(),
  )

  function reset(): void {
    setAdding(false)
    setBody('')
    setRationale('')
    setDueAt('')
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    const text = body.trim()

    if (text.length === 0) {
      return
    }

    const reasoning = rationale.trim()

    createDecision.run({
      targetType,
      targetId,
      body: text,
      ...(reasoning.length === 0 ? {} : { rationale: reasoning }),
      // Local midday, so no timezone west or east of UTC shifts the chosen day.
      ...(dueAt === '' ? {} : { dueAt: new Date(`${dueAt}T12:00:00`) }),
    })
    reset()
  }

  return (
    <section>
      <SectionHeader
        title="Decisions"
        onAdd={() => {
          setAdding((current) => !current)
        }}
        addLabel="Add decision"
      />

      {createDecision.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createDecision.error} />
        </div>
      )}
      {deleteDecision.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={deleteDecision.error} />
        </div>
      )}
      {decisions.error !== null && <ErrorPanel error={decisions.error} />}

      {adding && (
        <form onSubmit={submit} className="mb-3 space-y-2">
          <textarea
            value={body}
            onChange={(event) => {
              setBody(event.target.value)
            }}
            placeholder="We decided / promised…"
            rows={2}
            autoFocus
            required
            className="w-full resize-y rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          <input
            value={rationale}
            onChange={(event) => {
              setRationale(event.target.value)
            }}
            placeholder="Rationale (optional)"
            className="w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 text-[13px] outline-none focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[12px] text-ink-muted">
              By
              <input
                type="date"
                value={dueAt}
                onChange={(event) => {
                  setDueAt(event.target.value)
                }}
                className="rounded-md border border-border bg-surface-raised px-2 py-1 text-[12px] outline-none focus:border-accent"
              />
            </label>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover"
              >
                Add
              </button>
            </div>
          </div>
        </form>
      )}

      {decisions.isLoading && <p className="text-[13px] text-ink-faint">Loading decisions…</p>}

      {!decisions.isLoading && ordered.length === 0 && !adding ? (
        <p className="text-[13px] text-ink-faint">No decisions yet.</p>
      ) : (
        ordered.length > 0 && (
          <ul className="overflow-hidden rounded-md border border-border">
            {ordered.map((decision) => (
              <DecisionItem
                key={decision.id}
                decision={decision}
                ownerName={ownerNameFor(decision, members.nameById)}
                onRemove={() => {
                  deleteDecision.run(decision.id)
                }}
              />
            ))}
          </ul>
        )
      )}

      {decisions.hasMore && (
        <button
          type="button"
          onClick={decisions.loadMore}
          disabled={decisions.isLoadingMore}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink-muted transition hover:border-border-strong hover:text-ink"
        >
          {decisions.isLoadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}

      <p className="mt-2 text-[11px] text-ink-faint">
        <Link to="/decisions" className="text-accent hover:underline">
          View all decisions
        </Link>
      </p>
    </section>
  )
}

/**
 * The mockup shows an owner only when it can name one, so a null owner and a
 * member whose membership was removed both render nothing rather than a word
 * like "Unknown" beside a commitment.
 */
function ownerNameFor(decision: Decision, nameById: ReadonlyMap<string, string>): string | undefined {
  if (decision.ownerId === null) {
    return undefined
  }

  return nameById.get(decision.ownerId)
}

function DecisionItem({
  decision,
  ownerName,
  onRemove,
}: {
  readonly decision: Decision
  readonly ownerName: string | undefined
  readonly onRemove: () => void
}): React.JSX.Element {
  const timezone = useTimezone()

  return (
    <li className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] font-medium text-ink">{decision.body}</p>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-[11px] font-medium text-ink-faint hover:text-danger"
        >
          Remove
        </button>
      </div>
      {decision.rationale !== null && (
        <p className="mt-1 text-[12px] text-ink-muted">{decision.rationale}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint">
        <span>Decided {formatDate(decision.decidedAt, timezone)}</span>
        {decision.dueAt !== null && <span>By {formatDate(decision.dueAt, timezone)}</span>}
        {ownerName !== undefined && <span>{ownerName}</span>}
      </div>
    </li>
  )
}
