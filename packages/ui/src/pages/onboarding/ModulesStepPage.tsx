import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { useSetModuleEnabled } from '../../api/resources/moduleSettings.ts'
import { useInstallSampleData } from '../../api/resources/sampleData.ts'
import { useSession } from '../../api/resources/session.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { AuthLayout } from '../auth/AuthLayout.tsx'
import { OnboardingNav } from './OnboardingNav.tsx'
import { defaultOnboardingModuleState, ONBOARDING_MODULES } from './onboardingModules.ts'
import { isOnboardingRerun, onboardingPath } from './onboardingRerun.ts'

/**
 * Onboarding step 3: which optional modules this workspace runs.
 *
 * The workspace already exists. This step writes each of the six choices
 * through `PATCH /v1/workspaces/:id/modules/:moduleId`, then optionally
 * installs sample data, then moves on to invites. Other toggleable modules
 * stay on; Admin → Modules is where they change later.
 */

export function ModulesStepPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const rerun = isOnboardingRerun(searchParams)
  const { session, isLoading } = useSession()
  const setEnabled = useSetModuleEnabled()
  const installSampleData = useInstallSampleData()
  const [enabled, setEnabledState] = useState(defaultOnboardingModuleState)
  const [seedSample, setSeedSample] = useState(false)
  const [saving, setSaving] = useState(false)

  function toggle(moduleId: string, next: boolean): void {
    setEnabledState((previous) => ({ ...previous, [moduleId]: next }))
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    const workspaceId = session?.workspaceId

    if (workspaceId === null || workspaceId === undefined) {
      return
    }

    setSaving(true)

    persistChoices()
      .then(async () => {
        if (seedSample) {
          await installSampleData.runAsync({ workspaceId })
        }

        navigate(onboardingPath('/onboarding/invites', rerun), { replace: true })
      })
      .catch(() => undefined)
      .finally(() => {
        setSaving(false)
      })
  }

  async function persistChoices(): Promise<void> {
    for (const choice of ONBOARDING_MODULES) {
      await setEnabled.runAsync({
        moduleId: choice.id,
        enabled: enabled[choice.id] === true,
      })
    }
  }

  const isPending = saving || setEnabled.isPending || installSampleData.isPending
  const workspaceId = session?.workspaceId

  if (isLoading || workspaceId === null || workspaceId === undefined) {
    return (
      <AuthLayout
        step={3}
        title="What do you want to use?"
        description="Pick the parts of Kelpie your team needs today. Turn the rest on whenever you like — nothing here is permanent."
      >
        <div className="mt-5">
          <LoadingPanel label="Loading…" />
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      step={3}
      title="What do you want to use?"
      description="Pick the parts of Kelpie your team needs today. Turn the rest on whenever you like — nothing here is permanent."
    >
      <form onSubmit={submit} className="mt-5 space-y-3">
        <ul className="space-y-3">
          {ONBOARDING_MODULES.map((choice) => (
            <li key={choice.id}>
              <label className="flex items-start gap-2 text-[12px] text-ink">
                <input
                  type="checkbox"
                  checked={enabled[choice.id] === true}
                  onChange={(event) => {
                    toggle(choice.id, event.target.checked)
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-border text-accent focus:ring-accent"
                />
                <span>
                  <span className="font-medium">{choice.label}</span>
                  <span className="mt-0.5 block text-[11px] text-ink-muted">{choice.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={seedSample}
            onChange={(event) => setSeedSample(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border text-accent focus:ring-accent"
          />
          <span>
            Fill it with sample data — a few companies, people, and records for the parts you
            turned on, so you are not staring at an empty screen. Clear it out any time.
          </span>
        </label>
        {setEnabled.error !== null && <ErrorPanel error={setEnabled.error} />}
        {installSampleData.error !== null && <ErrorPanel error={installSampleData.error} />}
        <OnboardingNav
          step={3}
          nextLabel="Next"
          nextPendingLabel={installSampleData.isPending ? 'Installing sample data…' : 'Saving…'}
          isPending={isPending}
        />
      </form>
    </AuthLayout>
  )
}
