import type { Account } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { useAccount, useUpdateAccount } from '../../api/resources/account.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { initialsOf } from '../../lib/names.ts'
import { Field } from './Field.tsx'

/**
 * The account's name and address.
 *
 * Ported from the mockup's Profile page. One difference now that there is an
 * API behind it: the address is unique across Kelpie, so a save can be refused,
 * and changing it changes what this person signs in with.
 *
 * The form saves explicitly rather than per keystroke, like workspace settings:
 * a half-typed address is a different account, and committing one on every
 * character would be a stream of them.
 */

export function ProfilePage(): React.JSX.Element {
  const { account, isLoading, error } = useAccount()

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || account === undefined) {
    return <LoadingPanel />
  }

  return <ProfileForm key={account.id} account={account} />
}

function ProfileForm({ account }: { readonly account: Account }): React.JSX.Element {
  const update = useUpdateAccount()
  const [name, setName] = useState(account.name)
  const [email, setEmail] = useState(account.email)
  const [saved, setSaved] = useState(false)

  function save(event: FormEvent): void {
    event.preventDefault()
    setSaved(false)

    update
      .runAsync({ name: name.trim(), email: email.trim() })
      .then((updated) => {
        // The service lowercases the address it stored. Showing what was typed
        // instead would leave the field disagreeing with the account.
        setEmail(updated.email)
        setName(updated.name)
        setSaved(true)
      })
      .catch(() => undefined)
  }

  return (
    <div className="animate-slide-in space-y-6">
      <PageHeader title="Profile" description="Your name and email across every workspace." />

      <form onSubmit={save} className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-[13px] font-medium text-accent-fg">
            {initialsOf(name)}
          </div>
          <p className="text-[12px] text-ink-muted">Initials are derived from your name.</p>
        </div>

        <Field label="Name">
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
            required
            className="w-full max-w-md rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </Field>

        <Field label="Email" hint="This is the address you sign in with.">
          <input
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
            required
            autoComplete="email"
            className="w-full max-w-md rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </Field>

        {update.error !== null && (
          <div className="max-w-xl">
            <ErrorPanel error={update.error} />
          </div>
        )}

        <button
          type="submit"
          disabled={update.isPending}
          className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {update.isPending ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
        </button>
      </form>
    </div>
  )
}
