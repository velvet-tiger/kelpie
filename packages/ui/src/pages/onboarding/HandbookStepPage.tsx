import { useNavigate } from 'react-router'

import { useHandbookPages } from '../../api/resources/handbookPages.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { PrimaryButton } from '../auth/AuthForm.tsx'
import { AuthLayout } from '../auth/AuthLayout.tsx'

/**
 * Onboarding step 3: the starter handbook.
 *
 * The mockup's button created these pages. Against the real API they already
 * exist: `POST /v1/workspaces` seeded them in the same transaction that created
 * the workspace, two steps ago. So this reads them back and shows what is there.
 *
 * That is the deviation, and it is the honest one. A button labelled "create"
 * that creates nothing teaches a reader something false about the product, and
 * the alternative — deleting the step — would drop the one screen that tells a
 * new workspace its handbook is what agents read.
 */
export function HandbookStepPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { records: pages, isLoading, error } = useHandbookPages()

  function finish(): void {
    navigate('/people', { replace: true })
  }

  return (
    <AuthLayout
      step={3}
      title="Your starter handbook"
      description="These markdown pages are ready. Agents read them to learn what your company is."
    >
      <div className="mt-5 space-y-4">
        {error !== null && <ErrorPanel error={error} />}
        {error === null && isLoading && <LoadingPanel label="Loading your handbook…" />}

        {error === null && !isLoading && pages.length > 0 && (
          <ul className="max-h-56 overflow-y-auto rounded-md border border-border bg-surface">
            {pages.map((page) => (
              <li
                key={page.id}
                className="border-b border-border px-3 py-2 text-[13px] text-ink last:border-0"
              >
                {page.title}
              </li>
            ))}
          </ul>
        )}

        {/* An empty box under a heading that says the pages are ready would
            assert one thing and show another. The handbook is seeded with the
            workspace, so nothing here is the seeding having not happened. */}
        {error === null && !isLoading && pages.length === 0 && (
          <p className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink-muted">
            This workspace has no handbook pages. That is not what a new workspace should look
            like — the Handbook tab is where to add them.
          </p>
        )}

        {pages.length > 0 && (
          <p className="text-[12px] text-ink-muted">
            Every page starts as a stub. Write them from the Handbook tab whenever you are ready.
          </p>
        )}

        {/* Not a submit: the work behind this step already happened, so the
            button only moves the reader on. */}
        <PrimaryButton label="Go to Kelpie" onClick={finish} />
      </div>
    </AuthLayout>
  )
}
