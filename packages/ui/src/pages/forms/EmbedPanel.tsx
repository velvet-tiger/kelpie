import type { ConsentPurpose, Form } from '@kelpie/schemas'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'

import { useConsentPurposes } from '../../api/resources/consentPurposes.ts'
import { useFormEmbed } from '../../api/resources/forms.ts'
import { useLists } from '../../api/resources/lists.ts'
import { useWorkspace } from '../../api/resources/workspace.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'
import { buildEmbedPrompts, buildJsonSubmitPrompt } from './embedPrompts.ts'

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
 *
 * Each option also has an AI button that opens, in a modal, a prompt for a
 * coding assistant to put that option on the person's site. The fourth option,
 * Submit as JSON, is for a site that builds its own form and posts to the
 * public submit endpoint; its prompt lists the fields the answers are keyed by.
 */

export interface EmbedPanelProps {
  readonly form: Form
}

type PreviewMode = 'fixed' | 'resize'

interface AiPrompt {
  /** Which embed option the prompt is for: "iframe". */
  readonly label: string
  readonly prompt: string
}

export function EmbedPanel({ form }: EmbedPanelProps): React.JSX.Element {
  const { snippets, isLoading, error } = useFormEmbed(form.id)
  const [preview, setPreview] = useState<PreviewMode | null>(null)
  const [aiPrompt, setAiPrompt] = useState<AiPrompt | null>(null)
  const checkboxText = useCheckboxText()

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || snippets === undefined) {
    return <LoadingPanel label="Loading embed details…" />
  }

  const formName = form.title.trim().length > 0 ? form.title : form.name
  const prompts = buildEmbedPrompts({
    formName,
    url: snippets.url,
    iframeSnippet: snippets.iframeSnippet,
    scriptSnippet: snippets.scriptSnippet,
  })

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
          <AiPromptButton
            label="hosted page"
            onOpen={() => {
              setAiPrompt({ label: 'Hosted page', prompt: prompts.hosted })
            }}
          />
        </div>
      </div>

      <Snippet
        label="iframe"
        hint="One tag, no JavaScript, fixed height."
        value={snippets.iframeSnippet}
        onPreview={() => {
          setPreview('fixed')
        }}
        onAiPrompt={() => {
          setAiPrompt({ label: 'iframe', prompt: prompts.iframe })
        }}
      />
      <Snippet
        label="iframe with auto-resize"
        hint="Adds a listener that follows the page as fields appear and as the thank-you replaces the form."
        value={snippets.scriptSnippet}
        onPreview={() => {
          setPreview('resize')
        }}
        onAiPrompt={() => {
          setAiPrompt({ label: 'iframe with auto-resize', prompt: prompts.script })
        }}
      />

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-ink">Submit as JSON</span>
          <div className="flex items-center gap-2">
            <AiPromptButton
              label="JSON submit"
              onOpen={() => {
                setAiPrompt({
                  label: 'Submit as JSON',
                  prompt: buildJsonSubmitPrompt({
                    formName,
                    submitUrl: snippets.submitUrl,
                    fields: form.fields,
                    thankYouMessage: form.thankYouMessage,
                    ...checkboxText,
                  }),
                })
              }}
            />
            <CopyButton value={snippets.submitUrl} label="Copy the JSON submit endpoint" />
          </div>
        </div>
        <code className="block overflow-x-auto whitespace-nowrap rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-[12px] text-ink">
          POST {snippets.submitUrl}
        </code>
        <p className="mt-1 text-[11px] text-ink-faint">
          For a form you build yourself. Post {'{ "answers": { "<field id>": "…" } }'} with no
          credentials. The URL holds the slug, so it changes when the slug does.
        </p>
      </div>

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

      {aiPrompt !== null && (
        <AiPromptModal
          label={aiPrompt.label}
          prompt={aiPrompt.prompt}
          onClose={() => {
            setAiPrompt(null)
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
  onAiPrompt,
}: {
  readonly label: string
  readonly hint: string
  readonly value: string
  readonly onPreview: () => void
  readonly onAiPrompt: () => void
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
          <AiPromptButton label={label} onOpen={onAiPrompt} />
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
 * What the JSON prompt needs to name each consent and list checkbox the way the
 * embed does: the workspace's purposes, its person and company lists, and its
 * name for the `{{workspace}}` token in a purpose statement.
 */
function useCheckboxText(): {
  readonly consentPurposes: ReadonlyMap<string, ConsentPurpose>
  readonly listNames: ReadonlyMap<string, string>
  readonly workspaceName: string
} {
  const purposes = useConsentPurposes({ sort: 'sort_order', limit: 200 })
  const personLists = useLists({ targetType: 'person' })
  const companyLists = useLists({ targetType: 'company' })
  const { workspace } = useWorkspace()
  const consentPurposes = useMemo(
    () => new Map(purposes.records.map((purpose): [string, ConsentPurpose] => [purpose.id, purpose])),
    [purposes.records],
  )
  const listNames = useMemo(
    () =>
      new Map(
        [...personLists.records, ...companyLists.records].map((list): [string, string] => [list.id, list.name]),
      ),
    [personLists.records, companyLists.records],
  )

  return { consentPurposes, listNames, workspaceName: workspace?.name ?? '' }
}

function AiPromptButton({
  label,
  onOpen,
}: {
  readonly label: string
  readonly onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Show an AI prompt to add the ${label} to your site`}
      className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-ink-muted transition hover:border-border-strong hover:text-ink"
    >
      AI
    </button>
  )
}

/**
 * The prompt for one embed option, read-only, with a Copy button. The person
 * can read what they are about to hand an assistant before they copy it.
 */
function AiPromptModal({
  label,
  prompt,
  onClose,
}: {
  readonly label: string
  readonly prompt: string
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <ModalFrame
      title={`AI prompt · ${label}`}
      description="Paste this into an AI coding assistant to add the form to your site."
      actions={<CopyButton value={prompt} label={`Copy the ${label} AI prompt`} />}
      bodyClassName="p-4"
      onClose={onClose}
    >
      <textarea
        readOnly
        value={prompt}
        rows={prompt.split('\n').length + 1}
        aria-label={`${label} AI prompt`}
        className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] text-ink outline-none"
      />
    </ModalFrame>
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
  const heading = formTitle.trim().length > 0 ? formTitle : formName
  const [height, setHeight] = useState(720)

  useEffect(() => {
    if (mode !== 'resize') {
      return
    }

    // The same check the pasted snippet makes: only the embed page may resize it.
    const embedOrigin = new URL(url, window.location.href).origin

    function onMessage(event: MessageEvent): void {
      const data = event.data as { kelpie?: string; formId?: string; height?: number } | null

      if (
        event.origin !== embedOrigin ||
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
  }, [formId, mode, url])

  return (
    <ModalFrame
      title={`Preview · ${heading}`}
      description={
        mode === 'resize'
          ? 'Bare iframe embed with auto-resize — fields only, height follows the form.'
          : 'Bare iframe embed — fields only, fixed height.'
      }
      bodyClassName="bg-[#f4f4f5] p-4"
      onClose={onClose}
    >
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
    </ModalFrame>
  )
}

/**
 * The dialog shell both modals share: backdrop and Escape close it, a header
 * with a title, a description and optional actions beside Close, and a
 * scrolling body.
 */
function ModalFrame({
  title,
  description,
  actions,
  bodyClassName,
  onClose,
  children,
}: {
  readonly title: string
  readonly description: string
  readonly actions?: ReactNode
  readonly bodyClassName: string
  readonly onClose: () => void
  readonly children: ReactNode
}): React.JSX.Element {
  const titleId = useId()

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
              {title}
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-faint">{description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-[12px] font-medium text-ink-muted transition hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto ${bodyClassName}`}>{children}</div>
      </div>
    </div>
  )
}
