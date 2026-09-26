/**
 * A finished workspace can walk the wizard again from the account menu.
 *
 * `?rerun=1` marks that path. Organisation still runs so the reader can pick
 * a type, but handbook pages are not seeded or replaced. The handbook review
 * step is skipped: workspace → organisation → modules → invites → dashboard.
 */

export const ONBOARDING_RERUN_PARAM = 'rerun'
export const ONBOARDING_RERUN_VALUE = '1'

/** Organisation type chosen on step 2 — drives module defaults on step 3. */
export const ONBOARDING_ORG_PARAM = 'org'

/** Entry URL the account menu opens for a rerun. */
export const ONBOARDING_RERUN_ENTRY = `/onboarding/workspace?${ONBOARDING_RERUN_PARAM}=${ONBOARDING_RERUN_VALUE}`

export function isOnboardingRerun(searchParams: URLSearchParams): boolean {
  return searchParams.get(ONBOARDING_RERUN_PARAM) === ONBOARDING_RERUN_VALUE
}

/**
 * An account that already has a workspace can add another from the workspace
 * menu. `?new=1` shows the create form on step 1 instead of "ready". The new
 * workspace then walks the whole wizard, handbook seeding included.
 */
export const ONBOARDING_NEW_PARAM = 'new'

/** Entry URL the workspace menu opens to add a workspace. */
export const ONBOARDING_NEW_WORKSPACE_ENTRY = `/onboarding/workspace?${ONBOARDING_NEW_PARAM}=1`

export function isNewWorkspace(searchParams: URLSearchParams): boolean {
  return searchParams.get(ONBOARDING_NEW_PARAM) === '1'
}

/**
 * Keep the rerun flag and the organisation type when moving between onboarding
 * routes. `org` is how the modules step knows which defaults to offer; nothing
 * else is held in the browser.
 */
export function onboardingPath(path: string, rerun: boolean, org?: string | null): string {
  const params = new URLSearchParams()

  if (rerun) {
    params.set(ONBOARDING_RERUN_PARAM, ONBOARDING_RERUN_VALUE)
  }

  if (org !== undefined && org !== null && org !== '') {
    params.set(ONBOARDING_ORG_PARAM, org)
  }

  const query = params.toString()

  return query === '' ? path : `${path}?${query}`
}
