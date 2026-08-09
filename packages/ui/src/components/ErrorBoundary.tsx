import { Component } from 'react'
import type { ReactNode } from 'react'

interface ErrorBoundaryProps {
  readonly children: ReactNode
}

interface ErrorBoundaryState {
  readonly error: Error | null
}

/**
 * Catches a render-time exception below it and shows a fallback instead of
 * the blank screen React leaves otherwise. `Shell` wraps its routed `Outlet`
 * with this rather than `KelpieApp` wrapping everything, so a page that
 * throws still leaves the nav standing and usable.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return <ErrorFallback error={this.state.error} />
    }

    return this.props.children
  }
}

function ErrorFallback({ error }: { readonly error: Error }): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="text-[15px] font-medium text-ink">Something went wrong.</p>
      <p className="mt-1 text-[13px] text-ink-muted">{error.message}</p>
      <div className="mt-4 flex justify-center gap-4 text-[13px] font-medium">
        <button
          type="button"
          onClick={() => {
            window.location.reload()
          }}
          className="text-accent hover:underline"
        >
          Reload page
        </button>
        {/* A plain anchor rather than `Link`: a full navigation remounts the
            app from scratch, which a client-side route change would not do
            for whatever state made this page throw. */}
        <a href="/dashboard" className="text-accent hover:underline">
          Go to dashboard
        </a>
      </div>
    </div>
  )
}
