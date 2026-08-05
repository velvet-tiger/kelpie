import { MINIMUM_PASSWORD_LENGTH } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'

import { useConfirmPasswordReset } from '../../api/resources/session.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SubmitButton, TextField } from './AuthForm.tsx'
import { AuthLayout } from './AuthLayout.tsx'

/**
 * Where a reset email lands: `/reset-password?token=…`.
 *
 * The mockup has no page for this, because a mockup never sent the email. The
 * token is in the URL rather than typed, so the form asks for the new password
 * and nothing else.
 *
 * Success does not sign anyone in. The service ends every session the account
 * had, which is the point of a reset when the account was stolen, so the only
 * honest next step is the sign-in form.
 */
export function ResetPasswordPage(): React.JSX.Element {
  const [searchParameters] = useSearchParams()
  const token = searchParameters.get('token') ?? ''
  const confirm = useConfirmPasswordReset()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const backToSignIn = (
    <Link to="/login" className="font-medium text-accent hover:underline">
      Back to sign in
    </Link>
  )

  if (token.length === 0) {
    return (
      <AuthLayout title="This link is incomplete" footer={backToSignIn}>
        <p className="mt-4 text-[13px] text-ink-muted">
          It carries no reset token. Ask for a new link from{' '}
          <Link to="/forgot-password" className="font-medium text-accent hover:underline">
            Forgot password
          </Link>
          .
        </p>
      </AuthLayout>
    )
  }

  if (done) {
    return (
      <AuthLayout title="Password changed" footer={backToSignIn}>
        <p className="mt-4 text-[13px] text-ink-muted">
          Every device that was signed in to this account has been signed out. Sign in again with
          the new password.
        </p>
      </AuthLayout>
    )
  }

  /** The two rules the browser can decide on its own, before spending the token. */
  function localProblem(): string | null {
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      return `Password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`
    }

    return password === confirmation ? null : 'Password and confirmation do not match.'
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    const problem = localProblem()

    setLocalError(problem)

    if (problem !== null) {
      return
    }

    confirm
      .runAsync({ token, password })
      .then(() => {
        setDone(true)
      })
      .catch(() => undefined)
  }

  return (
    <AuthLayout
      title="Choose a new password"
      description="This link works once."
      footer={backToSignIn}
    >
      <form onSubmit={submit} className="mt-5 space-y-3">
        <TextField
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={`At least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`}
          required
        />
        <TextField
          label="Confirm new password"
          type="password"
          value={confirmation}
          onChange={setConfirmation}
          autoComplete="new-password"
          required
        />
        {localError !== null && <p className="text-[12px] text-danger">{localError}</p>}
        {confirm.error !== null && <ErrorPanel error={confirm.error} />}
        <SubmitButton
          label="Set new password"
          pendingLabel="Saving…"
          isPending={confirm.isPending}
        />
      </form>
    </AuthLayout>
  )
}
