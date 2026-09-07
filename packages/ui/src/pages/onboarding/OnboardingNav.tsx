import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'

import type { OnboardingStep } from '../auth/AuthLayout.tsx'

/**
 * The Previous / Next row every onboarding step shares.
 *
 * Forward still commits on the step that owns the form. This only moves
 * between the wizard routes. Step 1 has no previous onboarding page, so
 * Previous stays off there.
 */

const ONBOARDING_PATHS = {
  1: '/onboarding/workspace',
  2: '/onboarding/invites',
  3: '/onboarding/handbook',
} as const

const PRIMARY_CLASS =
  'flex-1 rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50'

const SECONDARY_CLASS =
  'flex-1 rounded-md border border-border bg-surface px-3.5 py-2 text-[12px] font-medium text-ink-muted transition hover:bg-surface-raised disabled:opacity-50'

export interface OnboardingNavProps {
  readonly step: OnboardingStep
  readonly nextLabel: string
  /** Shown while the step's request is in flight. */
  readonly nextPendingLabel?: string
  readonly isPending?: boolean
  /** `submit` inside a form; `button` when the step only navigates. */
  readonly nextType?: 'submit' | 'button'
  readonly onNext?: () => void
  /** A third action under the row, such as Skip on invites. */
  readonly extra?: ReactNode
}

export function previousOnboardingPath(step: OnboardingStep): string | undefined {
  if (step === 1) {
    return undefined
  }

  return ONBOARDING_PATHS[(step - 1) as OnboardingStep]
}

export function OnboardingNav({
  step,
  nextLabel,
  nextPendingLabel,
  isPending = false,
  nextType = 'submit',
  onNext,
  extra,
}: OnboardingNavProps): React.JSX.Element {
  const navigate = useNavigate()
  const previousTo = previousOnboardingPath(step)

  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex gap-2">
        {previousTo !== undefined && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              navigate(previousTo, { replace: true })
            }}
            className={SECONDARY_CLASS}
          >
            Previous
          </button>
        )}
        <button
          type={nextType}
          disabled={isPending}
          onClick={onNext}
          className={PRIMARY_CLASS}
        >
          {isPending && nextPendingLabel !== undefined ? nextPendingLabel : nextLabel}
        </button>
      </div>
      {extra}
    </div>
  )
}
