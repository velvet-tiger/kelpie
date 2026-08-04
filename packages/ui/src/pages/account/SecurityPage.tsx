import { MINIMUM_PASSWORD_LENGTH } from '@kelpie/schemas'
import type { AccountSession } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import {
  useAccountSessions,
  useChangePassword,
  useRevokeAccountSession,
} from '../../api/resources/account.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { formatDateTime } from '../../lib/dates.ts'

/**
 * Password and signed-in devices.
 *
 * Ported from the mockup's Security page against the endpoints that already
 * existed. Two things the mockup could not show: changing the password really
 * does end every other session, so the list below refetches, and the caller's
 * own row cannot be revoked because signing yourself out from here is what the
 * account menu is for.
 */

export function SecurityPage(): React.JSX.Element {
  return (
    <div className="animate-slide-in space-y-8">
      <PageHeader title="Security" description="Your password and where you are signed in." />
      <ChangePasswordForm />
      <SessionList />
    </div>
  )
}

const inputClass =
  'w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

function ChangePasswordForm(): React.JSX.Element {
  const change = useChangePassword()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)

  /**
   * The two rules the browser can decide on its own. Length is checked here as
   * well as by the service so the reader learns it before submitting; the
   * confirmation never reaches the API, which has nothing to compare it to.
   */
  function localProblem(): string | null {
    if (currentPassword.length === 0 || newPassword.length === 0) {
      return 'Enter your current and new password.'
    }

    if (newPassword.length < MINIMUM_PASSWORD_LENGTH) {
      return `New password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`
    }

    return newPassword === confirmation ? null : 'New password and confirmation do not match.'
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    setChanged(false)

    const problem = localProblem()

    setLocalError(problem)

    if (problem !== null) {
      return
    }

    change
      .runAsync({ currentPassword, newPassword })
      .then(() => {
        setCurrentPassword('')
        setNewPassword('')
        setConfirmation('')
        setChanged(true)
      })
      .catch(() => undefined)
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <h2 className="text-[14px] font-semibold text-ink">Change password</h2>
      <p className="max-w-md text-[12px] text-ink-muted">
        Changing your password signs you out everywhere except this browser.
      </p>

      <label className="block max-w-md">
        <span className="mb-1.5 block text-[12px] font-medium text-ink">Current password</span>
        <input
          type="password"
          value={currentPassword}
          onChange={(event) => {
            setCurrentPassword(event.target.value)
          }}
          autoComplete="current-password"
          className={inputClass}
        />
      </label>

      <label className="block max-w-md">
        <span className="mb-1.5 block text-[12px] font-medium text-ink">New password</span>
        <input
          type="password"
          value={newPassword}
          onChange={(event) => {
            setNewPassword(event.target.value)
          }}
          autoComplete="new-password"
          className={inputClass}
        />
        <span className="mt-1 block text-[11px] text-ink-faint">
          At least {MINIMUM_PASSWORD_LENGTH} characters.
        </span>
      </label>

      <label className="block max-w-md">
        <span className="mb-1.5 block text-[12px] font-medium text-ink">Confirm new password</span>
        <input
          type="password"
          value={confirmation}
          onChange={(event) => {
            setConfirmation(event.target.value)
          }}
          autoComplete="new-password"
          className={inputClass}
        />
      </label>

      {localError !== null && <p className="text-[12px] text-danger">{localError}</p>}
      {change.error !== null && (
        <div className="max-w-md">
          <ErrorPanel error={change.error} />
        </div>
      )}

      <button
        type="submit"
        disabled={change.isPending}
        className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
      >
        {change.isPending ? 'Updating…' : changed ? 'Password updated' : 'Update password'}
      </button>
    </form>
  )
}

function SessionList(): React.JSX.Element {
  const { sessions, isLoading, error } = useAccountSessions()
  const revoke = useRevokeAccountSession()

  return (
    <section>
      <h2 className="mb-3 text-[14px] font-semibold text-ink">Sessions</h2>

      {error !== null && <ErrorPanel error={error} />}
      {error === null && isLoading && <LoadingPanel label="Loading sessions…" />}

      {/* The wrapper scrolls rather than clips, like the team tables: a narrow
          window must not hide the column with the Revoke button in it. */}
      {error === null && !isLoading && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                <th className="px-4 py-2.5">Device</th>
                <th className="px-4 py-2.5">Location</th>
                <th className="px-4 py-2.5">Last active</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  onRevoke={() => {
                    revoke.run(session.id)
                  }}
                  isRevoking={revoke.isPending}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revoke.error !== null && (
        <div className="mt-3 max-w-xl">
          <ErrorPanel error={revoke.error} />
        </div>
      )}
    </section>
  )
}

function SessionRow({
  session,
  onRevoke,
  isRevoking,
}: {
  readonly session: AccountSession
  readonly onRevoke: () => void
  readonly isRevoking: boolean
}): React.JSX.Element {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium break-all text-ink">{session.device ?? 'Unknown device'}</div>
        {session.current && <span className="text-[11px] font-medium text-success">This device</span>}
      </td>
      {/* Always unknown today: the service records the User-Agent and nothing
          derives a location from the request. The column stays because the field
          is on the wire and a session says where it is from once something can
          tell. */}
      <td className="px-4 py-3 text-ink-muted">{session.location ?? 'Unknown'}</td>
      <td className="px-4 py-3 text-ink-muted">{formatDateTime(session.lastActiveAt)}</td>
      <td className="px-4 py-3 text-right">
        {!session.current && (
          <button
            type="button"
            onClick={onRevoke}
            disabled={isRevoking}
            className="text-[12px] font-medium text-danger hover:underline disabled:opacity-50"
          >
            Revoke
          </button>
        )}
      </td>
    </tr>
  )
}
