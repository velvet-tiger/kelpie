import { INVITABLE_ROLES } from '@kelpie/schemas'
import type { InvitableRole, Invite, Member, MemberRole } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { useMembers, useRemoveMember, useSetMemberRole } from '../../api/resources/members.ts'
import {
  useInvites,
  useResendInvite,
  useRevokeInvite,
  useSendInvite,
} from '../../api/resources/invites.ts'
import { useSession } from '../../api/resources/session.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'

/**
 * The workspace's people: who is in it, and who has been asked.
 *
 * The mockup's version was local state, so its rules were suggestions. Every one
 * of them is now the API's: an admin invites, changes roles, and removes; the
 * owner cannot be demoted or removed; ownership moves by being given away; and a
 * member who still owns records cannot be removed until they are reassigned.
 *
 * This page hides the controls a member cannot use, which is a courtesy rather
 * than the enforcement. The endpoints answer `403` either way.
 */

function formatDate(value: Date): string {
  return value.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

export function TeamPage(): React.JSX.Element {
  const { session } = useSession()
  const isAdmin = session?.role === 'owner' || session?.role === 'admin'
  const { members, isLoading, error } = useMembers()

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-8">
      <PageHeader title="Team" description="Who is in this workspace, and what they can do." />

      {isAdmin && <InviteForm />}
      {isAdmin && <PendingInvites />}

      <section>
        <h2 className="mb-3 text-[14px] font-semibold text-ink">Active members</h2>
        {error !== null && <ErrorPanel error={error} />}
        {isLoading ? (
          <LoadingPanel label="Loading the team…" />
        ) : (
          <MemberTable members={members} isAdmin={isAdmin} currentUserId={session?.userId} />
        )}
      </section>
    </div>
  )
}

function InviteForm(): React.JSX.Element {
  const sendInvite = useSendInvite()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InvitableRole>('member')

  function submit(event: FormEvent): void {
    event.preventDefault()

    sendInvite
      .runAsync({ email: email.trim(), role })
      .then(() => {
        setEmail('')
      })
      .catch(() => undefined)
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[220px] flex-1">
          <span className="mb-1.5 block text-[12px] font-medium text-ink">Invite by email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
            required
            placeholder="colleague@startup.com"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <label>
          <span className="mb-1.5 block text-[12px] font-medium text-ink">Role</span>
          <select
            value={role}
            onChange={(event) => {
              setRole(event.target.value as InvitableRole)
            }}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] capitalize outline-none focus:border-accent"
          >
            {INVITABLE_ROLES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={sendInvite.isPending}
          className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {sendInvite.isPending ? 'Sending…' : 'Send invite'}
        </button>
      </div>
      {sendInvite.error !== null && <ErrorPanel error={sendInvite.error} />}
      <p className="text-[11px] text-ink-faint">
        The invitation is emailed and lasts seven days. Ownership is not invited; it is given to a
        member who has already joined.
      </p>
    </form>
  )
}

function PendingInvites(): React.JSX.Element {
  const { invites, isLoading, error } = useInvites()
  const resend = useResendInvite()
  const revoke = useRevokeInvite()
  const failure = resend.error ?? revoke.error ?? error

  return (
    <section>
      <h2 className="mb-3 text-[14px] font-semibold text-ink">Invitations</h2>
      {failure !== null && <ErrorPanel error={failure} />}
      {isLoading ? (
        <LoadingPanel label="Loading invitations…" />
      ) : invites.length === 0 ? (
        <p className="text-[13px] text-ink-muted">No outstanding invitations.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                <th className="px-4 py-2.5">Email</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Invited</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <InviteRow
                  key={invite.id}
                  invite={invite}
                  isPending={resend.isPending || revoke.isPending}
                  onResend={() => {
                    resend.run(invite.id)
                  }}
                  onRevoke={() => {
                    revoke.run(invite.id)
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function InviteRow({
  invite,
  isPending,
  onResend,
  onRevoke,
}: {
  readonly invite: Invite
  readonly isPending: boolean
  readonly onResend: () => void
  readonly onRevoke: () => void
}): React.JSX.Element {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3 font-mono text-[12px] text-ink">{invite.email}</td>
      <td className="px-4 py-3 text-ink-muted capitalize">{invite.role}</td>
      <td className="px-4 py-3 text-ink-muted">{formatDate(invite.createdAt)}</td>
      <td className="px-4 py-3">
        <span
          className={
            invite.status === 'pending'
              ? 'text-[12px] font-medium text-warning'
              : 'text-[12px] font-medium text-ink-faint'
          }
        >
          {invite.status === 'pending' ? `Pending until ${formatDate(invite.expiresAt)}` : 'Expired'}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            disabled={isPending}
            onClick={onResend}
            title="Sends a new link and retires the old one"
            className="text-[12px] font-medium text-accent hover:underline disabled:opacity-50"
          >
            Resend
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={onRevoke}
            className="text-[12px] font-medium text-danger hover:underline disabled:opacity-50"
          >
            Revoke
          </button>
        </div>
      </td>
    </tr>
  )
}

function MemberTable({
  members,
  isAdmin,
  currentUserId,
}: {
  readonly members: readonly Member[]
  readonly isAdmin: boolean
  readonly currentUserId: string | undefined
}): React.JSX.Element {
  const { session } = useSession()
  const setRole = useSetMemberRole()
  const removeMember = useRemoveMember()
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null)
  // A refused removal is only worth showing while its row is still asking. A
  // successful removal clears the row, and so does Cancel; either way the reason
  // the last one failed is no longer about anything on screen.
  const failure = setRole.error ?? (pendingRemovalId === null ? null : removeMember.error)

  const isOwner = session?.role === 'owner'

  function remove(memberId: string): void {
    removeMember
      .runAsync(memberId)
      .then(() => {
        setPendingRemovalId(null)
      })
      .catch(() => undefined)
  }

  return (
    <div className="space-y-3">
      {failure !== null && <ErrorPanel error={failure} />}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-border bg-surface text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
              <th className="px-4 py-2.5">Member</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Joined</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[11px] font-medium text-ink">
                      {initialsOf(member.name)}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">
                        {member.name}
                        {member.userId === currentUserId && (
                          <span className="ml-1.5 text-[11px] text-ink-faint">you</span>
                        )}
                      </div>
                      <div className="truncate font-mono text-[11px] text-ink-faint">
                        {member.email}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {member.role === 'owner' || !isAdmin ? (
                    <span className="text-ink-muted capitalize">{member.role}</span>
                  ) : (
                    <select
                      value={member.role}
                      disabled={setRole.isPending}
                      onChange={(event) => {
                        setRole.run({ memberId: member.id, role: event.target.value as MemberRole })
                      }}
                      className="rounded border border-border bg-surface px-2 py-1 text-[12px] capitalize outline-none disabled:opacity-50"
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      {/* Only the owner may offer this, and the API agrees. */}
                      {isOwner && <option value="owner">Owner (transfer)</option>}
                    </select>
                  )}
                </td>
                <td className="px-4 py-3 text-ink-muted">{formatDate(member.joinedAt)}</td>
                <td className="px-4 py-3 text-right">
                  {isAdmin && member.role !== 'owner' && (
                    <RemoveMemberCell
                      name={member.name}
                      isConfirming={pendingRemovalId === member.id}
                      isPending={removeMember.isPending}
                      onAsk={() => {
                        setPendingRemovalId(member.id)
                      }}
                      onCancel={() => {
                        setPendingRemovalId(null)
                      }}
                      onConfirm={() => {
                        remove(member.id)
                      }}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isOwner && (
        <p className="text-[11px] text-ink-faint">
          Giving somebody ownership makes you an admin. A workspace has exactly one owner.
        </p>
      )}
    </div>
  )
}

function RemoveMemberCell({
  name,
  isConfirming,
  isPending,
  onAsk,
  onCancel,
  onConfirm,
}: {
  readonly name: string
  readonly isConfirming: boolean
  readonly isPending: boolean
  readonly onAsk: () => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.JSX.Element {
  if (!isConfirming) {
    return (
      <button
        type="button"
        onClick={onAsk}
        className="text-[12px] font-medium text-danger hover:underline"
      >
        Remove
      </button>
    )
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-[12px] text-ink-muted">Remove {name}?</span>
      <button
        type="button"
        onClick={onCancel}
        className="text-[12px] font-medium text-ink-muted hover:text-ink"
      >
        Cancel
      </button>
      <button
        type="button"
        disabled={isPending}
        onClick={onConfirm}
        className="rounded-md bg-danger px-2.5 py-1 text-[12px] font-semibold text-danger-fg transition hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? 'Removing…' : 'Remove'}
      </button>
    </div>
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/u).slice(0, 2)
  const letters = parts.map((part) => part.slice(0, 1)).join('')

  return letters.length > 0 ? letters.toUpperCase() : '?'
}
