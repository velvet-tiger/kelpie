import { Navigate, useNavigate, useSearchParams } from 'react-router'

import { useHandbookPages } from '../../api/resources/handbookPages.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { AuthLayout } from '../auth/AuthLayout.tsx'
import { OnboardingNav } from './OnboardingNav.tsx'
import { isOnboardingRerun } from './onboardingRerun.ts'

/**
 * Onboarding step 5: review the starter handbook.
 *
 * Pages were seeded on step 2 when the reader picked an organisation type.
 * This step reads them back and shows what agents will learn from.
 *
 * A rerun skips this step: the pages are already in place.
 */
export function HandbookStepPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { records: pages, isLoading, error } = useHandbookPages()

  if (isOnboardingRerun(searchParams)) {
    return <Navigate to="/dashboard" replace />
  }

  function finish(): void {
    navigate('/dashboard', { replace: true })
  }

  const sortedPages = [...pages].sort((left, right) => left.sortOrder - right.sortOrder)

  return (
    <AuthLayout
      step={5}
      title="Your starter handbook"
      description="These markdown pages were chosen for your organisation type. Agents read them to learn what your company is."
    >
      <div className="mt-5 space-y-4">
        {error !== null && <ErrorPanel error={error} />}
        {error === null && isLoading && <LoadingPanel label="Loading your handbook…" />}

        {error === null && !isLoading && sortedPages.length > 0 && (
          <ul className="max-h-56 overflow-y-auto rounded-md border border-border bg-surface">
            {sortedPages.map((page) => (
              <li
                key={page.id}
                className="border-b border-border px-3 py-2 text-[13px] text-ink last:border-0"
              >
                {page.title}
              </li>
            ))}
          </ul>
        )}

        {error === null && !isLoading && sortedPages.length === 0 && (
          <p className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink-muted">
            This workspace has no handbook pages. That is not what a new workspace should look
            like — the Handbook tab is where to add them.
          </p>
        )}

        {sortedPages.length > 0 && (
          <p className="text-[12px] text-ink-muted">
            Every page starts as a stub. Write them from the Handbook tab whenever you are ready.
          </p>
        )}

        <OnboardingNav step={5} nextLabel="Go to Kelpie" nextType="button" onNext={finish} />
      </div>
    </AuthLayout>
  )
}
