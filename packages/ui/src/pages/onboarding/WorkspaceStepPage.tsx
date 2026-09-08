import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'

import { useCreateWorkspace, useSession } from '../../api/resources/session.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { TextField } from '../auth/AuthForm.tsx'
import { AuthLayout } from '../auth/AuthLayout.tsx'
import { OnboardingNav } from './OnboardingNav.tsx'
import { isOnboardingRerun, ONBOARDING_ORG_PARAM, onboardingPath } from './onboardingRerun.ts'

/**
 * Onboarding step 1: the workspace, against `POST /v1/workspaces`.
 *
 * This is the step the rest of the app waits on. Signup creates an account and
 * no workspace, so until this succeeds every CRM endpoint answers `403`, and
 * `SessionGate` sends anyone in that state here.
 *
 * One request creates the workspace, seeds pipeline stages, and moves this
 * session into it. The starter handbook is seeded on step 4 once the reader
 * picks an organisation type.
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
  const [searchParams] = useSearchParams()
  const rerun = isOnboardingRerun(searchParams)
  const { isSignedOut, session } = useSession()
  const createWorkspace = useCreateWorkspace()
  const hasWorkspace = session?.workspaceId !== null && session?.workspaceId !== undefined
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [timezone] = useState(browserTimezone)

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
      .then(() => {
        navigate('/onboarding/organisation', { replace: true })
      })
      .catch(() => undefined)
  }

  if (isSignedOut) {
    return <Navigate to="/login" replace />
  }

  /**
   * Previous on a later step lands here after the workspace already exists.
   * Showing the create form again would offer a second POST that this account
   * cannot use. Next is the only action that remains. A rerun keeps the flag
   * so organisation does not seed handbook pages and the review step is skipped.
   */
  if (hasWorkspace) {
    return (
      <AuthLayout
        step={1}
        title="Your workspace is ready"
        description="Use Next to choose your organisation type and starter handbook."
        footer={
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in as somebody else
          </Link>
        }
      >
        <div className="mt-5">
          <OnboardingNav
            step={1}
            nextLabel="Next"
            nextType="button"
            onNext={() => {
              navigate(
                onboardingPath('/onboarding/organisation', rerun, searchParams.get(ONBOARDING_ORG_PARAM)),
                { replace: true },
              )
            }}
          />
        </div>
      </AuthLayout>
    )
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
        {createWorkspace.error !== null && <ErrorPanel error={createWorkspace.error} />}
        <OnboardingNav
          step={1}
          nextLabel="Next"
          nextPendingLabel="Creating…"
          isPending={createWorkspace.isPending}
        />
      </form>
    </AuthLayout>
  )
}
