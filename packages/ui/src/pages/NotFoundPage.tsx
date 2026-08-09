import { Link } from 'react-router'

/**
 * The router's catch-all, for a URL that matches nothing.
 *
 * It sits inside the Shell rather than standing alone: `KelpieApp.tsx` nests
 * this route under `SessionGate`, so a signed-out visitor is already redirected
 * to `/login` before this ever renders, and a signed-in one keeps their nav
 * instead of landing on a bare page with no way back in.
 */
export function NotFoundPage(): React.JSX.Element {
  return (
    <div className="animate-fade-in mx-auto max-w-md py-20 text-center">
      <p className="text-[13px] font-medium text-ink-faint uppercase tracking-wide">404</p>
      <p className="mt-2 text-[15px] font-medium text-ink">This page doesn't exist.</p>
      <p className="mt-1 text-[13px] text-ink-muted">
        The link may be out of date, or the address may be mistyped.
      </p>
      <Link
        to="/dashboard"
        className="mt-4 inline-block text-[13px] font-medium text-accent hover:underline"
      >
        Go to dashboard
      </Link>
    </div>
  )
}
