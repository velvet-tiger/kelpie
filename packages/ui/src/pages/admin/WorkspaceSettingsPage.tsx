import type { Workspace } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router'

import { useSession } from '../../api/resources/session.ts'
import {
  useDeleteWorkspace,
  useUpdateWorkspace,
  useWorkspace,
} from '../../api/resources/workspace.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'

/**
 * Workspace settings, and the one screen that can end a workspace.
 *
 * Ported from the mockup's Workspace page. Two differences, both because there
 * is an API behind it now: the slug is editable and can collide, and the danger
 * zone deletes for real, so it asks the reader to type the slug rather than
 * clicking one button.
 *
 * The form saves explicitly instead of per keystroke. Every field here is
 * workspace-wide, and the slug appears in URLs, so committing on each character
 * would be a stream of half-typed addresses.
 */

/**
 * The timezones the mockup offered, plus whatever this workspace already holds.
 *
 * A full IANA list belongs in a combo box, which is its own piece of work. An
 * unlisted value must still survive a save, so it joins the list rather than
 * being silently rewritten to the first option.
 */
const COMMON_TIMEZONES = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'UTC',
] as const

export function WorkspaceSettingsPage(): React.JSX.Element {
  const { workspace, isLoading, error } = useWorkspace()

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || workspace === undefined) {
    return <LoadingPanel />
  }

  // Keyed on the id so the form state is rebuilt if the session moves to another
  // workspace while this page is mounted.
  return <WorkspaceSettingsForm key={workspace.id} workspace={workspace} />
}

function WorkspaceSettingsForm({
  workspace,
}: {
  readonly workspace: Workspace
}): React.JSX.Element {
  const { session } = useSession()
  const update = useUpdateWorkspace()
  const [name, setName] = useState(workspace.name)
  const [slug, setSlug] = useState(workspace.slug)
  const [timezone, setTimezone] = useState(workspace.timezone)
  const [tagline, setTagline] = useState(workspace.tagline ?? '')
  const [oneLiner, setOneLiner] = useState(workspace.oneLiner ?? '')
  const [saved, setSaved] = useState(false)

  const canEdit = session?.role === 'owner' || session?.role === 'admin'
  const timezones = COMMON_TIMEZONES.includes(timezone as (typeof COMMON_TIMEZONES)[number])
    ? [...COMMON_TIMEZONES]
    : [timezone, ...COMMON_TIMEZONES]

  function save(event: FormEvent): void {
    event.preventDefault()
    setSaved(false)

    update
      .runAsync({
        name: name.trim(),
        slug: slug.trim(),
        timezone,
        // Empty is not blank text, it is no tagline. `null` clears the column;
        // an empty string would store one and hand agents an empty identity.
        tagline: tagline.trim().length === 0 ? null : tagline.trim(),
        oneLiner: oneLiner.trim().length === 0 ? null : oneLiner.trim(),
      })
      .then(() => {
        setSaved(true)
      })
      .catch(() => undefined)
  }

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-8">
      <PageHeader
        title="Workspace"
        description="Name, address, timezone, and how the company introduces itself to an agent."
      />

      <form onSubmit={save} className="space-y-4">
        <Field label="Workspace name">
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
            required
            disabled={!canEdit}
            className="w-full max-w-md rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
          />
        </Field>

        <Field label="Slug" hint="Lowercase letters, digits, and hyphens. It appears in URLs.">
          <input
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value)
            }}
            required
            disabled={!canEdit}
            className="w-full max-w-md rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
          />
        </Field>

        <Field label="Tagline" hint="The short identity an agent loads first.">
          <input
            value={tagline}
            onChange={(event) => {
              setTagline(event.target.value)
            }}
            placeholder="CRM and company brain for agent-native startups"
            disabled={!canEdit}
            className="w-full max-w-xl rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
          />
        </Field>

        <Field label="One-liner" hint="What the company does, in a sentence.">
          <textarea
            value={oneLiner}
            onChange={(event) => {
              setOneLiner(event.target.value)
            }}
            rows={2}
            disabled={!canEdit}
            className="w-full max-w-xl rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
          />
        </Field>

        <Field label="Timezone">
          <select
            value={timezone}
            onChange={(event) => {
              setTimezone(event.target.value)
            }}
            disabled={!canEdit}
            className="w-full max-w-md rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent disabled:opacity-60"
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>

        {update.error !== null && (
          <div className="max-w-xl">
            <ErrorPanel error={update.error} />
          </div>
        )}

        {canEdit ? (
          <button
            type="submit"
            disabled={update.isPending}
            className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
          >
            {update.isPending ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
          </button>
        ) : (
          <p className="text-[12px] text-ink-muted">
            Workspace settings are changed by an admin or the owner.
          </p>
        )}
      </form>

      {session?.role === 'owner' && <DangerZone slug={workspace.slug} />}
    </div>
  )
}

/**
 * Deleting the workspace, behind the workspace's own name.
 *
 * Owner only, both here and in the API. The typed slug is what the request
 * carries, so this is the same guard on both sides rather than a browser-side
 * flourish over an endpoint that would have deleted anyway.
 */
function DangerZone({ slug }: { readonly slug: string }): React.JSX.Element {
  const navigate = useNavigate()
  const remove = useDeleteWorkspace()
  const [confirmation, setConfirmation] = useState('')

  function submit(event: FormEvent): void {
    event.preventDefault()

    remove
      .runAsync({ slug: confirmation.trim() })
      // Nothing left to render here: the workspace this page describes is gone,
      // and the account is back to having none.
      .then(() => navigate('/create-workspace', { replace: true }))
      .catch(() => undefined)
  }

  return (
    <section className="rounded-lg border border-danger/30 bg-danger-soft p-4">
      <h2 className="text-[13px] font-semibold text-danger">Danger zone</h2>
      <p className="mt-1 max-w-xl text-[12px] text-ink-muted">
        Deleting this workspace removes every CRM record, the handbook, forms, invitations, and API
        keys it owns. Everyone loses access. This cannot be undone.
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-ink">
            Type <span className="font-mono">{slug}</span> to confirm
          </span>
          <input
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value)
            }}
            className="w-56 rounded-md border border-border bg-surface-raised px-3 py-1.5 font-mono text-[12px] outline-none focus:border-danger"
          />
        </label>
        <button
          type="submit"
          disabled={confirmation.trim() !== slug || remove.isPending}
          className="rounded-md border border-danger bg-surface-raised px-3 py-1.5 text-[12px] font-medium text-danger transition hover:bg-danger hover:text-danger-fg disabled:opacity-40 disabled:hover:bg-surface-raised disabled:hover:text-danger"
        >
          {remove.isPending ? 'Deleting…' : 'Delete workspace'}
        </button>
      </form>
      {remove.error !== null && (
        <div className="mt-3 max-w-xl">
          <ErrorPanel error={remove.error} />
        </div>
      )}
    </section>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  )
}
