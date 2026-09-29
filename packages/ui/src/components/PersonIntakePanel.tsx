import { PERSON_INTAKE_MAX_TEXT } from '@kelpie/schemas'
import { useState } from 'react'
import type { ReactNode } from 'react'

import { useResolveAgentTask } from '../api/resources/agentTasks.ts'
import { useWorkspace } from '../api/resources/workspace.ts'
import type { AgentRunnerAvailability, PersonIntakeProvider } from '../registry/contributions.ts'
import { usePersonIntakeProvider } from '../registry/context.ts'
import { ErrorPanel, LoadingPanel } from './QueryState.tsx'

/**
 * People's **Add from notes**: a second way to add a person, from what the
 * user already knows.
 *
 * Core owns the button and this panel, which runs in the AI drawer so the page
 * stays usable while the model works. When a module provides a wizard and it
 * is ready (Kelpie AI enabled, with a key), the panel renders it. Without one,
 * the panel still works: it builds the `workspace.add_person` prompt
 * with the user's notes appended, for the user to paste into their own agent.
 * That is the same pattern as the Log transcript task.
 */

const ADD_PERSON_TASK = 'workspace.add_person'

export function AddFromNotesButton({ onClick }: { readonly onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Add a person from notes"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken"
    >
      <span aria-hidden="true" className="text-accent">
        ✦
      </span>
      Add from notes
    </button>
  )
}

export interface PersonIntakePanelProps {
  /** Ends the intake. */
  readonly onClose: () => void
  readonly onPendingChange: (pending: boolean) => void
}

export function PersonIntakePanel({ onClose, onPendingChange }: PersonIntakePanelProps): React.JSX.Element {
  const provider = usePersonIntakeProvider()

  return provider === undefined ? (
    <CopyPromptIntake reason="The AI module is not part of this install." />
  ) : (
    <ProvidedIntake provider={provider} onClose={onClose} onPendingChange={onPendingChange} />
  )
}

/** Split out so `useAvailability` is only called when a provider exists. */
function ProvidedIntake({
  provider,
  onClose,
  onPendingChange,
}: {
  readonly provider: PersonIntakeProvider
  readonly onClose: () => void
  readonly onPendingChange: (pending: boolean) => void
}): React.JSX.Element {
  const availability: AgentRunnerAvailability = provider.useAvailability({ enabled: true })

  if (availability.status === 'loading') {
    return <LoadingPanel label="Checking AI…" />
  }

  if (availability.status === 'unavailable') {
    return <CopyPromptIntake reason={availability.reason} />
  }

  const Wizard = provider.Wizard

  return <Wizard onClose={onClose} onPendingChange={onPendingChange} />
}

/** The panel body and footer, the same frame the wizard's steps use. */
export function IntakeFrame({
  children,
  footer,
}: {
  readonly children: ReactNode
  readonly footer: ReactNode
}): React.JSX.Element {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>
    </>
  )
}

export function NotesField({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="block text-[12px] font-medium text-ink-muted">
      What do you know about this person?
      <textarea
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        disabled={disabled}
        rows={9}
        maxLength={PERSON_INTAKE_MAX_TEXT}
        autoFocus
        placeholder={'Names, emails, a LinkedIn URL, an email signature, meeting notes…\n\nDana Reyes, dana@brightline.health. Met at HLTH; asked about a pilot.'}
        className="mt-1 block w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] font-normal text-ink outline-none placeholder:text-ink-faint focus:border-accent disabled:opacity-60"
      />
      <span className="mt-1 block font-normal text-ink-faint">
        LinkedIn pages cannot be read without signing in. For the full profile, open it in your own browser, select
        all, copy, and paste it here.
      </span>
    </label>
  )
}

/** The fallback: the add-person agent task's prompt with the notes appended. */
function CopyPromptIntake({ reason }: { readonly reason: string }): React.JSX.Element {
  const { workspace } = useWorkspace()
  const resolve = useResolveAgentTask()
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)
  const [clipboardFailed, setClipboardFailed] = useState(false)

  async function copy(): Promise<void> {
    if (workspace === undefined) return

    setClipboardFailed(false)
    const resolved = await resolve.runAsync({ taskId: ADD_PERSON_TASK, targetType: 'workspace', targetId: workspace.id })
    const prompt = `${resolved.prompt}\n\n## Notes about the person\n\n${text.trim()}\n`

    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
    } catch {
      setClipboardFailed(true)
    }
  }

  return (
    <IntakeFrame
      footer={
        <button
          type="button"
          disabled={text.trim().length === 0 || resolve.isPending || workspace === undefined}
          onClick={() => {
            void copy().catch(() => undefined)
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          {resolve.isPending ? 'Preparing…' : copied ? 'Copied' : 'Copy prompt for your agent'}
        </button>
      }
    >
      <div className="mb-3 rounded-md border border-border bg-surface-sunken px-3 py-2 text-[12px] text-ink-muted">
        <p className="font-medium text-ink">AI cannot run this for you now.</p>
        <p className="mt-0.5">{reason}</p>
        <p className="mt-1">
          You can still copy a prompt with your notes in it. Paste it into an agent connected to Kelpie over MCP
          (Claude, Cursor, …), and the agent creates the records.
        </p>
      </div>
      <NotesField
        value={text}
        onChange={(value) => {
          setText(value)
          setCopied(false)
        }}
      />
      {resolve.error !== null && (
        <div className="mt-3">
          <ErrorPanel error={resolve.error} />
        </div>
      )}
      {clipboardFailed && (
        <p className="mt-2 text-[12px] text-danger">The browser did not allow Kelpie to copy to the clipboard.</p>
      )}
    </IntakeFrame>
  )
}
