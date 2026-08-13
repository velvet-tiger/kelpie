import { useEffect, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router'

import { useConfirmEmailVerification, useSession } from '../../api/resources/session.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { AuthLayout } from './AuthLayout.tsx'

/**
 * Where a verification email lands: `/verify-email?token=…`.
 *
 * Spent automatically on load, unlike accepting an invitation: confirming
 * only flips whether the account is verified. There is no workspace
 * membership or other side effect a confirmation button would be guarding.
 */
export function VerifyEmailConfirmPage(): React.JSX.Element {
  const [searchParameters] = useSearchParams()
  const token = searchParameters.get('token') ?? ''
  const confirm = useConfirmEmailVerification()
  // `confirm` is a fresh object every render, so the effect below reads it
  // through a ref rather than depending on it: depending on it would spend
  // the token again on every render instead of once per token.
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm
  const { isLoading, isSignedOut, needsWorkspace } = useSession()
  const [succeeded, setSucceeded] = useState(false)

  useEffect(() => {
    if (token.length === 0) {
      return
    }

    // Guards a state update after the token was already spent by an earlier
    // mount of this effect, not a retry: the request itself only ever fires
    // once per token, since `token` is the only dependency.
    let active = true

    confirmRef.current
      .runAsync({ token })
      .then(() => {
        if (active) {
          setSucceeded(true)
        }
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [token])

  if (token.length === 0) {
    return (
      <AuthLayout title="This link is incomplete">
        <p className="mt-4 text-[13px] text-ink-muted">It carries no verification token.</p>
      </AuthLayout>
    )
  }

  if (confirm.error !== null) {
    return (
      <AuthLayout title="This link is invalid or has expired">
        <div className="mt-4">
          <ErrorPanel error={confirm.error} />
        </div>
      </AuthLayout>
    )
  }

  if (!succeeded || isLoading) {
    return <LoadingPanel />
  }

  // Confirmed. A signed-in caller moves on; `SessionGate` and the onboarding
  // routes take it from there. A signed-out one goes to sign in.
  return (
    <Navigate
      to={isSignedOut ? '/login' : needsWorkspace ? '/onboarding/workspace' : '/dashboard'}
      replace
    />
  )
}
