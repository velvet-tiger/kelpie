import { useState } from 'react'
import { Navigate } from 'react-router'

import {
  useLogOut,
  useRequestEmailVerification,
  useSession,
  verifyEmailUrlTemplate,
} from '../../api/resources/session.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { AuthLayout } from './AuthLayout.tsx'

/**
 * Where `SessionGate` sends a signed-in account with no workspace and an
 * unverified email, and where `SignUpPage` navigates straight after signup.
 *
 * There is nothing to submit here: the account already exists, and the first
 * verification link already went out with `POST /v1/auth/signup`. The only
 * actions from this screen are asking for a fresh link and signing out.
 */
export function VerifyEmailPendingPage(): React.JSX.Element {
  const { isSignedOut } = useSession()
  const requestVerification = useRequestEmailVerification()
  const logOut = useLogOut()
  const [resent, setResent] = useState(false)

  if (isSignedOut) {
    return <Navigate to="/login" replace />
  }

  function resend(): void {
    requestVerification
      .runAsync({ verifyUrlTemplate: verifyEmailUrlTemplate(window.location.origin) })
      .then(() => {
        setResent(true)
      })
      .catch(() => undefined)
  }

  return (
    <AuthLayout
      title="Check your email"
      description="Click the link we sent to finish setting up your account."
      footer={
        <button
          type="button"
          onClick={() => {
            logOut.runAsync().catch(() => undefined)
          }}
          className="font-medium text-accent hover:underline"
        >
          Sign out
        </button>
      }
    >
      <div className="mt-5 space-y-3">
        {resent && <p className="text-[12px] text-ink-muted">A new link is on its way.</p>}
        {requestVerification.error !== null && <ErrorPanel error={requestVerification.error} />}
        <button
          type="button"
          disabled={requestVerification.isPending}
          onClick={resend}
          className="w-full rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {requestVerification.isPending ? 'Sending…' : 'Resend link'}
        </button>
      </div>
    </AuthLayout>
  )
}
