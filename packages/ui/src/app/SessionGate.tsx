import { Navigate, Outlet } from 'react-router'

import { useSession } from '../api/resources/session.ts'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'

/**
 * What stands between a URL and a page that needs a workspace.
 *
 * Four answers, and they are not the same thing:
 *
 * - `401` means sign in. That is a redirect.
 * - Signed in, no workspace, email unverified means go verify it: creating a
 *   workspace answers `403` until then. Checked before `needsWorkspace`,
 *   since both are true at once for a fresh direct signup and this is the one
 *   that has to happen first.
 * - Signed in, no workspace, verified means create one. Also a redirect, to a
 *   different place, because sending someone to a sign-in form they have
 *   already passed is a loop.
 * - Anything else is the service being unreachable or broken, and redirecting
 *   on that would hide it behind a sign-in form that will also fail.
 */
export function SessionGate(): React.JSX.Element {
  const { isLoading, isSignedOut, needsWorkspace, needsEmailVerification, error } = useSession()

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

  if (needsEmailVerification) {
    return <Navigate to="/verify-email/pending" replace />
  }

  if (needsWorkspace) {
    return <Navigate to="/onboarding/workspace" replace />
  }

  return <Outlet />
}
