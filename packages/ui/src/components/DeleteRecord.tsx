import { useState } from 'react'

import { ErrorPanel } from './QueryState.tsx'

export interface DeleteRecordProps {
  readonly recordLabel: string
  readonly recordName: string
  readonly isPending: boolean
  readonly error: Error | null
  readonly onConfirm: () => void
}

/**
 * Delete, behind one confirmation.
 *
 * The mockup asked which related records to take along, because seed data had no
 * referential rules. The API has them: roadmap decision 2 makes a delete cascade
 * to dependents and answers `409` when an independent record still points at
 * this one, listing the types in `details`. So there is nothing to choose, and
 * the interesting case is the refusal, which is why the error sits here rather
 * than somewhere the button is not.
 */
export function DeleteRecord({
  recordLabel,
  recordName,
  isPending,
  error,
  onConfirm,
}: DeleteRecordProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="flex flex-col items-end gap-2">
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-ink-muted">Delete {recordName}?</span>
          <button
            type="button"
            onClick={() => {
              setConfirming(false)
            }}
            className="rounded-md px-2 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={onConfirm}
            className="rounded-md bg-danger px-2.5 py-1 text-[12px] font-semibold text-danger-fg transition hover:opacity-90 disabled:opacity-50"
          >
            {isPending ? 'Deleting…' : `Delete ${recordLabel.toLowerCase()}`}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setConfirming(true)
          }}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-ink-muted transition hover:border-danger hover:text-danger"
        >
          Delete
        </button>
      )}
      {error !== null && (
        <div className="w-full max-w-sm">
          <ErrorPanel error={error} />
        </div>
      )}
    </div>
  )
}
