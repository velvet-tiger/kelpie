import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'

import { resetUrlTemplate, useRequestPasswordReset } from '../../api/resources/session.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SubmitButton, TextField } from './AuthForm.tsx'
import { AuthLayout } from './AuthLayout.tsx'

/**
 * Asking for a reset link, against `POST /v1/auth/password-reset`.
 *
 * The endpoint answers `202` whether or not the address is registered, and this
 * page has to answer the same way. Saying "no account with that address" would
 * make the form an account-existence oracle, which is the whole reason the
 * service refuses to tell.
 *
 * So the confirmation is conditional: *if* an account exists. It is not a
 * hedge, it is the only thing the browser actually knows.
 */
export function ForgotPasswordPage(): React.JSX.Element {
  const request = useRequestPasswordReset()
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)

  function submit(event: FormEvent): void {
    event.preventDefault()

    const address = email.trim()

    request
      .runAsync({ email: address, resetUrlTemplate: resetUrlTemplate(window.location.origin) })
      .then(() => {
        setSentTo(address)
      })
      .catch(() => undefined)
  }

  const backToSignIn = (
    <Link to="/login" className="font-medium text-accent hover:underline">
      Back to sign in
    </Link>
  )

  if (sentTo !== null) {
    return (
      <AuthLayout title="Check your email" footer={backToSignIn}>
        <p className="mt-4 text-[13px] text-ink-muted">
          If an account exists for <span className="font-medium text-ink">{sentTo}</span>, a reset
          link is on its way. The link expires, so use it soon.
        </p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Reset password"
      description="Enter your email and we will send you a link."
      footer={backToSignIn}
    >
      <form onSubmit={submit} className="mt-5 space-y-3">
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
        />
        {request.error !== null && <ErrorPanel error={request.error} />}
        <SubmitButton
          label="Send reset link"
          pendingLabel="Sending…"
          isPending={request.isPending}
        />
      </form>
    </AuthLayout>
  )
}
