import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'

import { useLogIn } from '../../api/resources/session.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SubmitButton, TextField } from './AuthForm.tsx'
import { AuthLayout } from './AuthLayout.tsx'
import { AuthMethods } from './AuthMethods.tsx'
import { safeNext } from './nextPath.ts'

/**
 * Sign in, against `POST /v1/auth/login`.
 *
 * Where the browser goes afterwards is not always the app. An invitation link
 * sends its token through `?next=`, and dropping it would land the invitee on
 * People with the invitation still unaccepted.
 */

export function SignInPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParameters] = useSearchParams()
  const logIn = useLogIn()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const next = safeNext(searchParameters.get('next'))

  function submit(event: FormEvent): void {
    event.preventDefault()

    logIn
      .runAsync({ email: email.trim(), password })
      .then(() => navigate(next, { replace: true }))
      .catch(() => undefined)
  }

  return (
    <AuthLayout
      title="Sign in"
      footer={
        <div className="flex flex-col gap-1.5">
          <Link to="/forgot-password" className="font-medium text-accent hover:underline">
            Forgot password?
          </Link>
          <span className="text-ink-muted">
            No account?{' '}
            <Link to="/signup" className="font-medium text-accent hover:underline">
              Sign up
            </Link>
          </span>
        </div>
      }
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
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
        />
        {logIn.error !== null && <ErrorPanel error={logIn.error} />}
        <SubmitButton label="Sign in" pendingLabel="Signing in…" isPending={logIn.isPending} />
      </form>
      <AuthMethods intent="login" next={next} />
    </AuthLayout>
  )
}
