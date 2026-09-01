import type { Company, Workspace } from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router'

import {
  useCompanies,
  useCreateCompany,
  useUpdateCompany,
} from '../../api/resources/companies.ts'
import { useSession } from '../../api/resources/session.ts'
import {
  useDeleteWorkspace,
  useUpdateWorkspace,
  useWorkspace,
} from '../../api/resources/workspace.ts'
import { EntitySearch } from '../../components/EntitySearch.tsx'
import type { SearchOption } from '../../components/EntitySearch.tsx'
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
        description="Name, address, and timezone."
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

      <OwnCompanySection canEdit={canEdit} />

      {session?.role === 'owner' && <DangerZone slug={workspace.slug} />}
    </div>
  )
}

/**
 * Mark one or more Companies as "us" — the workspace's own organisation.
 *
 * Backed by `companies.is_own`. Zero or many rows may carry it (a parent and a
 * subsidiary is the intended case), so the surface is a list plus an add
 * picker rather than a single-select. Picking a name that does not exist
 * creates the Company with `is_own: true` in one call.
 */
function OwnCompanySection({ canEdit }: { readonly canEdit: boolean }): React.JSX.Element {
  const own = useCompanies({ isOwn: true })
  const [search, setSearch] = useState('')
  // The picker's options: workspace companies that are NOT already marked.
  // Server-side search on the term the user types.
  const searchable = useCompanies({
    isOwn: false,
    term: search.trim().length > 0 ? search.trim() : undefined,
  })
  const update = useUpdateCompany()
  const create = useCreateCompany()

  const options: SearchOption[] = useMemo(
    () =>
      searchable.records.map((company) => ({
        id: company.id,
        label: company.name,
        meta: company.domain ?? undefined,
      })),
    [searchable.records],
  )

  function mark(companyId: string): void {
    update.run({ id: companyId, changes: { isOwn: true } })
  }

  function unmark(companyId: string): void {
    update.run({ id: companyId, changes: { isOwn: false } })
  }

  function createAndMark(name: string): void {
    // The API defaults every other field; `is_own: true` lands the row in the
    // list this section shows and nowhere else.
    create.run({ name, isOwn: true })
    setSearch('')
  }

  const busy = update.isPending || create.isPending

  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div>
        <h2 className="text-[13px] font-semibold text-ink">This company</h2>
        <p className="mt-1 max-w-xl text-[12px] text-ink-muted">
          Mark the company (or companies) in the CRM that represent this workspace itself. Used
          later to separate own records from prospects.
        </p>
      </div>

      {own.isLoading ? (
        <p className="text-[12px] text-ink-faint">Loading…</p>
      ) : own.records.length === 0 ? (
        <p className="text-[12px] text-ink-faint">Nothing marked yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {own.records.map((company: Company) => (
            <li
              key={company.id}
              className="flex items-center justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-ink">{company.name}</div>
                {company.domain !== null && company.domain.length > 0 && (
                  <div className="truncate text-[11px] text-ink-faint">{company.domain}</div>
                )}
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    unmark(company.id)
                  }}
                  disabled={busy}
                  className="shrink-0 rounded-md border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-medium text-ink hover:border-danger hover:text-danger disabled:opacity-50"
                >
                  Unmark
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="max-w-md">
          <label className="mb-1.5 block text-[12px] font-medium text-ink">
            {own.records.length === 0 ? 'Pick or create' : 'Add another'}
          </label>
          <EntitySearch
            options={options}
            value=""
            onChange={mark}
            onQueryChange={setSearch}
            onCreate={createAndMark}
            createLabel={(query) => `Create “${query}” and mark it`}
            placeholder="Search companies…"
            emptyMessage="No matches — type a new name to create one"
          />
        </div>
      )}

      {update.error !== null && (
        <div className="max-w-xl">
          <ErrorPanel error={update.error} />
        </div>
      )}
      {create.error !== null && (
        <div className="max-w-xl">
          <ErrorPanel error={create.error} />
        </div>
      )}
    </section>
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
      .then(() => navigate('/onboarding/workspace', { replace: true }))
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
