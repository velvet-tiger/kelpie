import { INVITABLE_ROLES } from '@kelpie/schemas'
import type { InvitableRole } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { useSendInvite } from '../../api/resources/invites.ts'
import { AUTH_INPUT_CLASS, SecondaryButton, SubmitButton } from '../auth/AuthForm.tsx'
import { AuthLayout } from '../auth/AuthLayout.tsx'

/**
 * Onboarding step 2: invitations, against `POST /v1/workspaces/:id/invites`.
 *
 * One request per address, and they can fail one at a time — an address already
 * invited answers `409` while its neighbours succeed. The mockup could ignore
 * this because it sent nothing. Here a row carries its own outcome, a sent one
 * is never sent twice, and the step only advances once nothing is outstanding.
 *
 * Skippable, per `onboarding.md`. Admin → Team does the same job later.
 */

interface InviteRow {
  readonly email: string
  readonly role: InvitableRole
  /** Accepted by the service. A retry of the other rows must not send it again. */
  readonly sent: boolean
  readonly failure: string | null
}

function emptyRow(): InviteRow {
  return { email: '', role: 'member', sent: false, failure: null }
}

/** A row worth sending: it has an address and has not already been accepted. */
function isOutstanding(row: InviteRow): boolean {
  return row.email.trim().length > 0 && !row.sent
}

export function InvitesStepPage(): React.JSX.Element {
  const navigate = useNavigate()
  const sendInvite = useSendInvite()
  const [rows, setRows] = useState<readonly InviteRow[]>([emptyRow()])

  function changeRow(index: number, changes: Partial<InviteRow>): void {
    setRows((previous) =>
      previous.map((row, at) => (at === index ? { ...row, ...changes } : row)),
    )
  }

  /**
   * Sends every outstanding row, one at a time, and reports each result on its
   * own row. Sequential rather than concurrent: a person reading a list of
   * failures wants them in the order they typed the addresses.
   */
  async function sendOutstanding(): Promise<boolean> {
    let allSent = true

    for (const [index, row] of rows.entries()) {
      if (!isOutstanding(row)) {
        continue
      }

      try {
        await sendInvite.runAsync({ email: row.email.trim(), role: row.role })
        changeRow(index, { sent: true, failure: null })
      } catch (error: unknown) {
        allSent = false
        changeRow(index, {
          failure: error instanceof Error ? error.message : 'Could not send this invitation.',
        })
      }
    }

    return allSent
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    sendOutstanding()
      .then((allSent) => {
        if (allSent) {
          navigate('/onboarding/handbook', { replace: true })
        }
      })
      .catch(() => undefined)
  }

  const outstanding = rows.filter(isOutstanding).length

  return (
    <AuthLayout
      step={2}
      title="Invite teammates"
      description="Optional. You can always invite people later from Admin → Team."
    >
      <form onSubmit={submit} className="mt-5 space-y-3">
        {rows.map((row, index) => (
          <InviteRowFields
            // Rows are only appended, so the position is stable for the life of
            // the page and identifies the row a result belongs to.
            key={index}
            row={row}
            onChange={(changes) => {
              changeRow(index, changes)
            }}
          />
        ))}

        <button
          type="button"
          onClick={() => {
            setRows((previous) => [...previous, emptyRow()])
          }}
          className="text-[12px] font-medium text-accent hover:underline"
        >
          Add another
        </button>

        <div className="flex flex-col gap-2 pt-1">
          <SubmitButton
            label={outstanding === 0 ? 'Continue' : 'Send invitations'}
            pendingLabel="Sending…"
            isPending={sendInvite.isPending}
          />
          <SecondaryButton
            label="Skip for now"
            disabled={sendInvite.isPending}
            onClick={() => {
              navigate('/onboarding/handbook', { replace: true })
            }}
          />
        </div>
      </form>
    </AuthLayout>
  )
}

function InviteRowFields({
  row,
  onChange,
}: {
  readonly row: InviteRow
  readonly onChange: (changes: Partial<InviteRow>) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="flex gap-2">
        <input
          type="email"
          value={row.email}
          onChange={(event) => {
            // Editing an address makes it a different invitation, so a failure
            // recorded against the old one no longer applies.
            onChange({ email: event.target.value, failure: null })
          }}
          disabled={row.sent}
          placeholder="colleague@company.com"
          className={`min-w-0 flex-1 ${AUTH_INPUT_CLASS} disabled:opacity-60`}
        />
        <select
          value={row.role}
          onChange={(event) => {
            onChange({ role: event.target.value as InvitableRole })
          }}
          disabled={row.sent}
          className="rounded-md border border-border bg-surface px-2 py-2 text-[12px] outline-none focus:border-accent disabled:opacity-60"
        >
          {INVITABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {role === 'admin' ? 'Admin' : 'Member'}
            </option>
          ))}
        </select>
      </div>
      {row.sent && <p className="mt-1 text-[11px] font-medium text-success">Invitation sent</p>}
      {row.failure !== null && <p className="mt-1 text-[11px] text-danger">{row.failure}</p>}
    </div>
  )
}
