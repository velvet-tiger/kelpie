import type { Form } from '@kelpie/schemas'
import { useEffect, useId, useState } from 'react'

import { useFormEmbed } from '../../api/resources/forms.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'

/**
 * What to paste into a website.
 *
 * The URL and both snippets come from the API rather than being built here. The
 * embed page is served by the service, so its address depends on where the
 * service is reached, which the server knows from the request and the browser
 * only happens to share while the two are same-origin.
 *
 * Each iframe snippet has a Preview that opens the bare embed document in a
 * modal — fields only, the same document the snippet iframes — fixed height for
 * the plain iframe, auto-resize for the script variant.
 */

export interface EmbedPanelProps {
  readonly form: Form
}

type PreviewMode = 'fixed' | 'resize'

export function EmbedPanel({ form }: EmbedPanelProps): React.JSX.Element {
  const { snippets, isLoading, error } = useFormEmbed(form.id)
  const [preview, setPreview] = useState<PreviewMode | null>(null)

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
        description="Hosted page is the standalone URL with Kelpie chrome. The iframe snippets load a bare form — fields only — so they sit inside your own site."
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
        onPreview={() => {
          setPreview('fixed')
        }}
      />
      <Snippet
        label="iframe with auto-resize"
        hint="Adds a listener that follows the page as fields appear and as the thank-you replaces the form."
        value={snippets.scriptSnippet}
        onPreview={() => {
          setPreview('resize')
        }}
      />

      {preview !== null && (
        <EmbedPreviewModal
          formId={form.id}
          formName={form.name}
          formTitle={form.title}
          url={snippets.embedUrl}
          mode={preview}
          onClose={() => {
            setPreview(null)
          }}
        />
      )}
    </div>
  )
}

function Snippet({
  label,
  hint,
  value,
  onPreview,
}: {
  readonly label: string
  readonly hint: string
  readonly value: string
  readonly onPreview: () => void
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-ink">{label}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPreview}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover"
          >
            Preview
          </button>
          <CopyButton value={value} label={`Copy the ${label} snippet`} />
        </div>
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

/**
 * Frames the hosted embed the way each snippet would: fixed 720px for the plain
 * iframe, or listening for the height postMessage when previewing auto-resize.
 */
function EmbedPreviewModal({
  formId,
  formName,
  formTitle,
  url,
  mode,
  onClose,
}: {
  readonly formId: string
  readonly formName: string
  readonly formTitle: string
  readonly url: string
  readonly mode: PreviewMode
  readonly onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const heading = formTitle.trim().length > 0 ? formTitle : formName
  const [height, setHeight] = useState(720)

  useEffect(() => {
    if (mode !== 'resize') {
      return
    }

    function onMessage(event: MessageEvent): void {
      const data = event.data as { kelpie?: string; formId?: string; height?: number } | null

      if (
        data === null ||
        typeof data !== 'object' ||
        data.kelpie !== 'height' ||
        data.formId !== formId ||
        typeof data.height !== 'number' ||
        !Number.isFinite(data.height)
      ) {
        return
      }

      setHeight(Math.max(320, Math.ceil(data.height)))
    }

    window.addEventListener('message', onMessage)

    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [formId, mode])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div
        className="animate-slide-in flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[14px] font-semibold text-ink">
              Preview · {heading}
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              {mode === 'resize'
                ? 'Bare iframe embed with auto-resize — fields only, height follows the form.'
                : 'Bare iframe embed — fields only, fixed height.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-ink-muted transition hover:text-ink"
          >
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#f4f4f5] p-4">
          <div className="overflow-hidden rounded-md border border-[#d4d4d8] bg-white shadow-sm">
            <iframe
              src={url}
              title={`${heading} preview`}
              style={{
                width: '100%',
                border: 0,
                height: mode === 'fixed' ? '720px' : `${String(height)}px`,
                colorScheme: 'normal',
              }}
              className="block bg-transparent"
            />
          </div>
          <p className="mt-2 text-center text-[11px] text-ink-faint">
            Simulated host page — the iframe uses its own neutral styles, not Kelpie&apos;s.
          </p>
        </div>
      </div>
    </div>
  )
}
