import type { Form } from '@kelpie/schemas'
import { useState } from 'react'

import { useFormEmbed } from '../../api/resources/forms.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'

/**
 * What to paste into a website.
 *
 * The URL and both snippets come from the API rather than being built here. The
 * embed page is served by the service, so its address depends on where the
 * service is reached, which the server knows from the request and the browser
 * only happens to share while the two are same-origin.
 */

export interface EmbedPanelProps {
  readonly form: Form
}

export function EmbedPanel({ form }: EmbedPanelProps): React.JSX.Element {
  const { snippets, isLoading, error } = useFormEmbed(form.id)

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || snippets === undefined) {
    return <LoadingPanel label="Loading embed details…" />
  }

  return (
    <div className="max-w-2xl space-y-5">
      <SectionHeader
        title="Embed"
        description="The page below is served by Kelpie, so a site embedding it loads nothing else."
      />

      <div>
        <span className="mb-1.5 block text-[12px] font-medium text-ink">Hosted page</span>
        <div className="flex flex-wrap items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-[12px] text-ink">
            {snippets.url}
          </code>
          <a
            href={snippets.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover"
          >
            Open
          </a>
        </div>
      </div>

      <Snippet
        label="iframe"
        hint="One tag, no JavaScript, fixed height."
        value={snippets.iframeSnippet}
      />
      <Snippet
        label="iframe with auto-resize"
        hint="Adds a listener that follows the page as fields appear and as the thank-you replaces the form."
        value={snippets.scriptSnippet}
      />
    </div>
  )
}

function Snippet({
  label,
  hint,
  value,
}: {
  readonly label: string
  readonly hint: string
  readonly value: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-ink">{label}</span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard
              .writeText(value)
              .then(() => {
                setCopied(true)
                setTimeout(() => {
                  setCopied(false)
                }, 1500)
              })
              .catch(() => undefined)
          }}
          className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-ink-muted transition hover:border-border-strong hover:text-ink"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <textarea
        readOnly
        value={value}
        rows={value.split('\n').length + 1}
        aria-label={`${label} snippet`}
        className="w-full resize-y rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-[11px] text-ink outline-none"
      />
      <p className="mt-1 text-[11px] text-ink-faint">{hint}</p>
    </div>
  )
}
