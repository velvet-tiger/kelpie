import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { useCreateWorkspace } from '../../api/resources/session.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { AuthLayout } from './AuthLayout.tsx'

/**
 * The first workspace for an account that has none.
 *
 * `onboarding.md` separates the account from the workspace: signup creates the
 * user, and the workspace is a later step. Without this step every CRM endpoint
 * answers `403`, so the sign-in gate would lead straight into a wall.
 *
 * The full onboarding wizard — invites, the seeded handbook tour — is part of
 * the auth port, not this one. Creating the workspace server-side already seeds
 * the starter handbook pages and pipeline stages.
 */

/** Same rule the API enforces: lowercase letters, digits, and hyphens. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 63)
}

export function CreateWorkspacePage(): React.JSX.Element {
  const navigate = useNavigate()
  const createWorkspace = useCreateWorkspace()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  function submit(event: FormEvent): void {
    event.preventDefault()

    createWorkspace
      .runAsync({ name: name.trim(), slug: slug.trim(), timezone })
      .then(() => navigate('/people', { replace: true }))
      .catch(() => undefined)
  }

  return (
    <AuthLayout
      title="Create a workspace"
      description="Your account has no workspace yet. Records live in one."
    >
      <form onSubmit={submit} className="mt-5 space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-ink">Name</span>
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value)

              if (!slugEdited) {
                setSlug(slugify(event.target.value))
              }
            }}
            required
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-ink">Slug</span>
          <input
            value={slug}
            onChange={(event) => {
              setSlugEdited(true)
              setSlug(event.target.value)
            }}
            required
            className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <p className="text-[11px] text-ink-faint">Timezone: {timezone}</p>
        {createWorkspace.error !== null && <ErrorPanel error={createWorkspace.error} />}
        <button
          type="submit"
          disabled={createWorkspace.isPending}
          className="w-full rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {createWorkspace.isPending ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
    </AuthLayout>
  )
}
