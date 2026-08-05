import { Navigate, Outlet } from 'react-router'

import { useSession } from '../api/resources/session.ts'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'

/**
 * What stands between a URL and a page that needs a workspace.
 *
 * Three answers, and they are not the same thing:
 *
 * - `401` means sign in. That is a redirect.
 * - Signed in with no workspace means create one. Also a redirect, to a
 *   different place, because sending someone to a sign-in form they have
 *   already passed is a loop.
 * - Anything else is the service being unreachable or broken, and redirecting
 *   on that would hide it behind a sign-in form that will also fail.
 */
export function SessionGate(): React.JSX.Element {
  const { isLoading, isSignedOut, needsWorkspace, error } = useSession()

  if (isSignedOut) {
    return <Navigate to="/login" replace />
  }

  if (error !== null) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16">
        <ErrorPanel error={error} />
      </div>
    )
  }

  if (isLoading) {
    return <LoadingPanel />
  }

  if (needsWorkspace) {
    return <Navigate to="/onboarding/workspace" replace />
  }

  return <Outlet />
}
