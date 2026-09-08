/**
 * A finished workspace can walk the wizard again from the account menu.
 *
 * `?rerun=1` marks that path. Organisation still runs so the reader can pick
 * a type, but handbook pages are not seeded or replaced. The handbook review
 * step is skipped: workspace → organisation → modules → invites → dashboard.
 */

export const ONBOARDING_RERUN_PARAM = 'rerun'
export const ONBOARDING_RERUN_VALUE = '1'

/** Entry URL the account menu opens for a rerun. */
export const ONBOARDING_RERUN_ENTRY = `/onboarding/workspace?${ONBOARDING_RERUN_PARAM}=${ONBOARDING_RERUN_VALUE}`

export function isOnboardingRerun(searchParams: URLSearchParams): boolean {
  return searchParams.get(ONBOARDING_RERUN_PARAM) === ONBOARDING_RERUN_VALUE
}

/** Keep or drop the rerun flag when moving between onboarding routes. */
export function onboardingPath(path: string, rerun: boolean): string {
  if (!rerun) {
    return path
  }

  return `${path}?${ONBOARDING_RERUN_PARAM}=${ONBOARDING_RERUN_VALUE}`
}
