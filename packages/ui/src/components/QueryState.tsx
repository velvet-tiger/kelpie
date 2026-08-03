import { Link } from 'react-router'

import { ApiError } from '../api/client.ts'

/**
 * The three states a mockup never had to show, because seed data is always
 * present, always correct, and never 403s.
 */

export function LoadingPanel({ label = 'Loading…' }: { readonly label?: string }): React.JSX.Element {
  return (
    <div className="animate-fade-in px-6 py-12 text-center text-[13px] text-ink-muted">{label}</div>
  )
}

export function NotFoundPanel({
  label,
  backTo,
}: {
  readonly label: string
  readonly backTo: string
}): React.JSX.Element {
  return (
    <div className="py-20 text-center">
      <p className="text-[15px] font-medium text-ink">{label} not found</p>
      <Link to={backTo} className="mt-2 inline-block text-[13px] text-accent">
        Go back
      </Link>
    </div>
  )
}

export interface ErrorPanelProps {
  readonly error: Error
  readonly onRetry?: () => void
}

/**
 * A failed request, said plainly.
 *
 * An `ApiError` carries field-level `details` for a `422`, and those are the
 * only part of a validation failure a person can act on, so they are listed
 * rather than collapsed into the summary message.
 */
export function ErrorPanel({ error, onRetry }: ErrorPanelProps): React.JSX.Element {
  const details = error instanceof ApiError ? error.details : []

  return (
    <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3">
      <p className="text-[13px] font-medium text-danger">{describe(error)}</p>
      {details.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {details.map((detail) => (
            <li key={`${detail.field}-${detail.message}`} className="text-[12px] text-danger">
              <span className="font-mono">{detail.field}</span>: {detail.message}
            </li>
          ))}
        </ul>
      )}
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md border border-danger/40 px-2.5 py-1 text-[12px] font-medium text-danger transition hover:bg-danger/10"
        >
          Try again
        </button>
      )}
    </div>
  )
}

function describe(error: Error): string {
  if (!(error instanceof ApiError)) {
    return `Could not reach the service. ${error.message}`
  }

  if (error.status === 403) {
    return 'This workspace is not available to your account.'
  }

  return error.message
}
