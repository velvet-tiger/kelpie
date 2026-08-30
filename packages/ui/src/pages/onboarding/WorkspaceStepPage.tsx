import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'

import { useInstallSampleData } from '../../api/resources/sampleData.ts'
import { useCreateWorkspace, useSession } from '../../api/resources/session.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SubmitButton, TextField } from '../auth/AuthForm.tsx'
import { AuthLayout } from '../auth/AuthLayout.tsx'

/**
 * Onboarding step 1: the workspace, against `POST /v1/workspaces`.
 *
 * This is the step the rest of the app waits on. Signup creates an account and
 * no workspace, so until this succeeds every CRM endpoint answers `403`, and
 * `SessionGate` sends anyone in that state here.
 *
 * One request does the whole thing: the service seeds the starter handbook and
 * the pipeline stages in the same transaction and moves this session into the
 * new workspace. There is nothing to re-login for and nothing to create next.
 *
 * It sits outside `SessionGate`, because being sent here *is* what the gate does
 * with an account that has no workspace, so gating it would loop. That leaves
 * the signed-out case to the page: without this check, somebody arriving here
 * signed out fills in a form whose only possible answer is `401`.
 */

/** The rule the API enforces: lowercase letters, digits, and hyphens. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 63)
}

/**
 * The zone the browser is in.
 *
 * The mockup offered a list of five. A guess from the platform is right more
 * often than a five-item list is, and Admin → Workspace is where it gets
 * changed. The value is shown rather than hidden so a wrong guess is visible.
 */
function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function WorkspaceStepPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { isSignedOut } = useSession()
  const createWorkspace = useCreateWorkspace()
  const installSampleData = useInstallSampleData()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [timezone] = useState(browserTimezone)
  const [seedSample, setSeedSample] = useState(false)

  function changeName(value: string): void {
    setName(value)

    if (!slugEdited) {
      setSlug(slugify(value))
    }
  }

  function changeSlug(value: string): void {
    setSlugEdited(true)
    setSlug(slugify(value))
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    createWorkspace
      .runAsync({ name: name.trim(), slug: slug.trim(), timezone })
      .then(async (workspace) => {
        if (seedSample) {
          // A refusal here does not block the wizard: the workspace itself is
          // already created, and the invites step is what comes next either
          // way. The error stays on screen so the reader sees what failed.
          await installSampleData
            .runAsync({ workspaceId: workspace.id })
            .catch(() => undefined)
        }

        navigate('/onboarding/invites', { replace: true })
      })
      .catch(() => undefined)
  }

  if (isSignedOut) {
    return <Navigate to="/login" replace />
  }

  return (
    <AuthLayout
      step={1}
      title="Create your workspace"
      description="A workspace is your company brain — CRM records, handbook, and team."
      footer={
        <Link to="/login" className="font-medium text-accent hover:underline">
          Sign in as somebody else
        </Link>
      }
    >
      <form onSubmit={submit} className="mt-5 space-y-3">
        <TextField
          label="Workspace name"
          value={name}
          onChange={changeName}
          placeholder="Acme Labs"
          autoComplete="organization"
          required
        />
        <TextField
          label="Slug"
          value={slug}
          onChange={changeSlug}
          hint="Lowercase letters, digits, and hyphens. It appears in URLs."
          mono
          required
        />
        <p className="text-[11px] text-ink-faint">
          Timezone: {timezone}. Change it later in Admin → Workspace.
        </p>
        <label className="flex items-start gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={seedSample}
            onChange={(event) => setSeedSample(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border text-accent focus:ring-accent"
          />
          <span>
            Install sample data — a small set of companies, people, deals, enquiries, opportunities,
            fundraising, partnerships, and hiring so the workspace has something to look at.
            You can delete it later.
          </span>
        </label>
        {createWorkspace.error !== null && <ErrorPanel error={createWorkspace.error} />}
        {installSampleData.error !== null && <ErrorPanel error={installSampleData.error} />}
        <SubmitButton
          label="Continue"
          pendingLabel={installSampleData.isPending ? 'Installing sample data…' : 'Creating…'}
          isPending={createWorkspace.isPending || installSampleData.isPending}
        />
      </form>
    </AuthLayout>
  )
}
