import { MINIMUM_PASSWORD_LENGTH } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import { useSignUp, verifyEmailUrlTemplate } from '../../api/resources/session.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SubmitButton, TextField } from './AuthForm.tsx'
import { AuthLayout } from './AuthLayout.tsx'

/**
 * Creating an account, against `POST /v1/auth/signup`.
 *
 * Signup makes the user and nothing else, per `onboarding.md`, so success
 * lands on the email-verification screen rather than in the app or the first
 * onboarding step: the account cannot create a workspace until it verifies.
 * The response sets the session cookie, which is why that next page can
 * already act as the signed-in account.
 *
 * The mockup collected this into `sessionStorage` and committed the lot at the
 * end of the wizard. Here each step commits as it is finished: a draft account
 * held in the browser is one an interrupted signup loses.
 */
export function SignUpPage(): React.JSX.Element {
  const navigate = useNavigate()
  const signUp = useSignUp()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  function submit(event: FormEvent): void {
    event.preventDefault()

    // Checked here as well as by the service so the rule is stated before a
    // submission rather than as a rejection afterwards.
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setLocalError(`Password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`)

      return
    }

    setLocalError(null)

    signUp
      .runAsync({
        name: name.trim(),
        email: email.trim(),
        password,
        verifyUrlTemplate: verifyEmailUrlTemplate(window.location.origin),
      })
      .then(() => navigate('/verify-email/pending', { replace: true }))
      .catch(() => undefined)
  }

  return (
    <AuthLayout
      title="Create account"
      description="Next you will verify your email, then create a workspace for your company."
      footer={
        <span className="text-ink-muted">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="mt-5 space-y-3">
        <TextField
          label="Your name"
          value={name}
          onChange={setName}
          autoComplete="name"
          required
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={`At least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`}
          required
        />
        {localError !== null && <p className="text-[12px] text-danger">{localError}</p>}
        {signUp.error !== null && <ErrorPanel error={signUp.error} />}
        <SubmitButton label="Continue" pendingLabel="Creating…" isPending={signUp.isPending} />
      </form>
    </AuthLayout>
  )
}
