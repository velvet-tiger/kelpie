import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { useLogIn } from '../../api/resources/session.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { AuthLayout } from './AuthLayout.tsx'

/**
 * Sign in, against `POST /v1/auth/login`.
 *
 * A placeholder, and deliberately the smallest one that works. The full auth
 * surface from the mockups — signup, password reset, the onboarding wizard, the
 * account security page — is its own feature, and it replaces this. What this
 * buys is a browser that can hold a session, without which no CRM page can be
 * opened at all.
 *
 * There is no signup form yet. Creating the first account is a `POST` to
 * `/v1/auth/signup`; the README gives the command.
 */
/**
 * Only a path within this app. An absolute URL in `?next=` would turn the
 * sign-in form into an open redirect, which is worth guarding even while the
 * only sender is the invitation link.
 */
function safeNext(value: string | null): string {
  return value !== null && value.startsWith('/') && !value.startsWith('//') ? value : '/people'
}

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
    <AuthLayout title="Sign in" description="Placeholder sign-in for the ported CRM pages.">
      <form onSubmit={submit} className="mt-5 space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-ink">Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
            autoComplete="email"
            required
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-ink">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
            autoComplete="current-password"
            required
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        {logIn.error !== null && <ErrorPanel error={logIn.error} />}
        <button
          type="submit"
          disabled={logIn.isPending}
          className="w-full rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {logIn.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthLayout>
  )
}
