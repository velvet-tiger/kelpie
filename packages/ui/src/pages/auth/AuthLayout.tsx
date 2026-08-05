import type { ReactNode } from 'react'
import { Link } from 'react-router'

/**
 * The centred card every signed-out page sits in: sign in, signup, the two
 * password-reset pages, and the three onboarding steps.
 *
 * `step` is what makes it an onboarding page. Onboarding is a sequence somebody
 * is part-way through, and a card that does not say where they are in it turns
 * three screens into three unrelated forms.
 */

/** Onboarding, per `onboarding.md`: workspace, invites, handbook. */
const ONBOARDING_STEPS = [1, 2, 3] as const

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export interface AuthLayoutProps {
  readonly title: string
  readonly description?: string
  /** Which onboarding step this is. Draws the progress bar and widens the card. */
  readonly step?: OnboardingStep
  readonly children: ReactNode
  /** Links below the form: the way back, or the other way in. */
  readonly footer?: ReactNode
}

export function AuthLayout({
  title,
  description,
  step,
  children,
  footer,
}: AuthLayoutProps): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-12">
      <Link to="/login" className="mb-8 text-[20px] font-semibold tracking-tight text-ink">
        Kelpie
      </Link>
      <div
        className={`w-full animate-fade-in rounded-md border border-border p-6 ${
          step === undefined ? 'max-w-sm' : 'max-w-md'
        }`}
      >
        {step !== undefined && <StepProgress step={step} />}
        <h1 className="text-[18px] font-semibold tracking-tight text-ink">{title}</h1>
        {description !== undefined && (
          <p className="mt-1 text-[13px] text-ink-muted">{description}</p>
        )}
        {children}
        {footer !== undefined && <div className="mt-4 text-center text-[12px]">{footer}</div>}
      </div>
    </div>
  )
}

function StepProgress({ step }: { readonly step: OnboardingStep }): React.JSX.Element {
  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        {ONBOARDING_STEPS.map((each) => (
          <div
            key={each}
            aria-hidden
            className={`h-1.5 flex-1 rounded-full ${each <= step ? 'bg-accent' : 'bg-border'}`}
          />
        ))}
      </div>
      <p className="mb-1 text-[11px] font-medium tracking-wide text-ink-faint uppercase">
        Step {step} of {ONBOARDING_STEPS.length}
      </p>
    </>
  )
}
