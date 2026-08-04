import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'

import { useAcceptInvite, useSession } from '../../api/resources/session.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { AuthLayout } from './AuthLayout.tsx'

/**
 * Where an invitation email lands: `/join?token=…`.
 *
 * Accepting needs a signed-in account, because the invitation adds *somebody* to
 * the workspace and the token does not say who. An invitee who is signed out is
 * sent to sign in with the token kept in the URL they come back to.
 *
 * Accepting is not automatic on load. It is a write that changes which workspace
 * the session is in, so it waits for the person to press the button.
 */
export function JoinPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParameters] = useSearchParams()
  const token = searchParameters.get('token') ?? ''
  const { isLoading, isSignedOut, error } = useSession()
  const accept = useAcceptInvite()

  if (token.length === 0) {
    return (
      <AuthLayout title="This link is incomplete" description="It carries no invitation token.">
        <p className="mt-4 text-[13px] text-ink-muted">
          Ask whoever invited you to send it again from the workspace's Team page.
        </p>
      </AuthLayout>
    )
  }

  // The token rides along so signing in comes back here rather than to the CRM.
  const signInHere = `/sign-in?next=${encodeURIComponent(`/join?token=${token}`)}`

  if (isSignedOut) {
    return <Navigate to={signInHere} replace />
  }

  if (error !== null) {
    return (
      <AuthLayout title="Join a workspace">
        <div className="mt-4">
          <ErrorPanel error={error} />
        </div>
      </AuthLayout>
    )
  }

  if (isLoading) {
    return <LoadingPanel />
  }

  return (
    <AuthLayout
      title="Join a workspace"
      description="You have been invited. Accepting adds this account to it."
    >
      <div className="mt-5 space-y-3">
        {accept.error !== null && <ErrorPanel error={accept.error} />}
        <button
          type="button"
          disabled={accept.isPending}
          onClick={() => {
            accept
              .runAsync({ token })
              .then(() => navigate('/people', { replace: true }))
              .catch(() => undefined)
          }}
          className="w-full rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {accept.isPending ? 'Joining…' : 'Accept invitation'}
        </button>
        <p className="text-[11px] text-ink-faint">
          Signed in as the wrong account?{' '}
          <Link to={signInHere} className="text-accent">
            Sign in as somebody else
          </Link>
          .
        </p>
      </div>
    </AuthLayout>
  )
}
