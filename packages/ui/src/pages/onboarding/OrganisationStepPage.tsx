import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { useHandbookPages } from '../../api/resources/handbookPages.ts'
import { useSeedHandbookForWorkspace } from '../../api/resources/handbookSeed.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { AuthLayout } from '../auth/AuthLayout.tsx'
import {
  handbookTemplateForChoice,
  ORGANISATION_CHOICES,
  organisationChoiceFromParam,
} from './handbookTemplates.ts'
import type { OrganisationChoiceId } from './handbookTemplates.ts'
import { OnboardingNav } from './OnboardingNav.tsx'
import { isOnboardingRerun, ONBOARDING_ORG_PARAM, onboardingPath } from './onboardingRerun.ts'

/**
 * Onboarding step 2: organisation type, then seed the starter handbook.
 *
 * The workspace already exists. This step writes pages through
 * `POST /v1/workspaces/:id/handbook/seed`. "Choose later" seeds the original
 * startup handbook. Changing the choice (via Previous) replaces pages only
 * while they are still unedited starter stubs.
 *
 * A rerun still shows the choices, but does not seed or replace handbook
 * pages. Next moves on to modules with those pages left alone.
 */
export function OrganisationStepPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const rerun = isOnboardingRerun(searchParams)
  const seedHandbook = useSeedHandbookForWorkspace()
  const { records: pages, isLoading } = useHandbookPages()
  const [choice, setChoice] = useState<OrganisationChoiceId>(() =>
    organisationChoiceFromParam(searchParams.get(ONBOARDING_ORG_PARAM)),
  )

  function goToModules(): void {
    navigate(onboardingPath('/onboarding/modules', rerun, choice), { replace: true })
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    if (rerun) {
      goToModules()
      return
    }

    seedHandbook
      .runAsync({
        handbookTemplate: handbookTemplateForChoice(choice),
        replace: pages.length > 0,
      })
      .then(() => {
        goToModules()
      })
      .catch(() => undefined)
  }

  if (!rerun && isLoading) {
    return (
      <AuthLayout
        step={2}
        title="What kind of organisation is this?"
        description="This picks the starter handbook pages agents read to learn what your company is."
      >
        <div className="mt-5">
          <LoadingPanel label="Loading…" />
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      step={2}
      title="What kind of organisation is this?"
      description={
        rerun
          ? 'Pick a type to continue.'
          : 'This picks the starter handbook pages agents read to learn what your company is.'
      }
    >
      <form onSubmit={submit} className="mt-5 space-y-3">
        <ul className="grid gap-2 sm:grid-cols-2">
          {ORGANISATION_CHOICES.map((option) => (
            <li
              key={option.id}
              className={option.id === 'later' ? 'h-full sm:col-span-2' : 'h-full'}
            >
              <label
                className={`flex h-full cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${
                  choice === option.id
                    ? 'border-accent bg-accent/5 text-ink'
                    : 'border-border bg-surface text-ink'
                }`}
              >
                <input
                  type="radio"
                  name="organisation-type"
                  value={option.id}
                  checked={choice === option.id}
                  disabled={seedHandbook.isPending}
                  onChange={() => {
                    setChoice(option.id)
                  }}
                  className="mt-0.5 h-4 w-4 border-border text-accent focus:ring-accent disabled:opacity-50"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="mt-0.5 block text-[11px] text-ink-muted">{option.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>

        {seedHandbook.error !== null && <ErrorPanel error={seedHandbook.error} />}
        <OnboardingNav
          step={2}
          nextLabel="Next"
          nextPendingLabel="Preparing handbook…"
          isPending={seedHandbook.isPending}
        />
      </form>
    </AuthLayout>
  )
}
