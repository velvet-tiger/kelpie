import {
  FORM_EMAIL_MAX_RECIPIENTS,
  FORM_EMAIL_PLACEHOLDERS,
  formEmailPlaceholderText,
} from '@kelpie/schemas'
import type { Form, FormEmailKind, FormEmailRecipient, Member } from '@kelpie/schemas'
import { useEffect, useRef, useState } from 'react'

import { useUpdateForm } from '../../api/resources/forms.ts'
import type { FormSettingsInput } from '../../api/resources/forms.ts'
import { useMembers } from '../../api/resources/members.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'

/**
 * The two emails a form sends after a submit: a notification to people the
 * workspace names, and an auto-reply to the submitter.
 *
 * On the Actions tab because an email is something the form does with a
 * submission. Toggles, recipients and the Reply-To commit on change, like
 * every other action; a template commits on blur, so a half-typed placeholder
 * is not sent to the server for checking on every key.
 *
 * The placeholder chips come from `FORM_EMAIL_PLACEHOLDERS`, the same list the
 * server checks templates against, so a chip never inserts a placeholder the
 * server refuses. The auto-reply offers only the ones that carry no visitor
 * text.
 *
 * Its own mutation, so a refusal shows here, beside the controls that caused
 * it, rather than at the top of a long tab.
 */

const inputClass =
  'w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

export interface FormEmailsProps {
  readonly form: Form
}

export function FormEmails({ form }: FormEmailsProps): React.JSX.Element {
  const { members } = useMembers()
  const updateForm = useUpdateForm()
  const onChange = (changes: FormSettingsInput): void => {
    updateForm.run({ id: form.id, changes })
  }
  /** For a template: rejects when refused, so the field keeps what was typed. */
  const commit = async (changes: FormSettingsInput): Promise<void> => {
    await updateForm.runAsync({ id: form.id, changes })
  }
  const hasRecipients = form.notifyRecipients.length > 0

  return (
    <div className="space-y-3">
      {updateForm.error !== null && <ErrorPanel error={updateForm.error} />}

      <div className="space-y-3 rounded-md border border-border p-4">
        <label className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <input
            type="checkbox"
            checked={form.notifyEmail}
            disabled={!hasRecipients && !form.notifyEmail}
            onChange={(event) => onChange({ notifyEmail: event.target.checked })}
          />
          Email my team
        </label>
        <p className="text-[11px] text-ink-faint">
          {hasRecipients || form.notifyEmail
            ? 'Sent after each submit, with a link to the submission. A reply goes to the person who filled in the form.'
            : 'Add a recipient first.'}
        </p>

        <RecipientList
          recipients={form.notifyRecipients}
          members={members}
          onChange={(next) =>
            onChange(
              next.length === 0 && form.notifyEmail
                ? { notifyRecipients: next, notifyEmail: false }
                : { notifyRecipients: next },
            )
          }
        />

        <TemplateInput
          label="Subject"
          kind="notification"
          value={form.notifySubject}
          multiline={false}
          onCommit={(next) => commit({ notifySubject: next })}
        />
        <TemplateInput
          label="Message"
          kind="notification"
          value={form.notifyBody}
          multiline
          onCommit={(next) => commit({ notifyBody: next })}
        />
      </div>

      <div className="space-y-3 rounded-md border border-border p-4">
        <label className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <input
            type="checkbox"
            checked={form.autoReply}
            onChange={(event) => onChange({ autoReply: event.target.checked })}
          />
          Send an auto-reply
        </label>
        <p className="text-[11px] text-ink-faint">
          Sent to the email address the visitor typed. Use it to confirm the request only, not
          for marketing. It cannot include the visitor&apos;s answers: anybody can type any
          address into a public form, so it contains only text you wrote. One auto-reply per
          address per day for each form.
        </p>

        <ReplyToPicker
          value={form.autoReplyReplyTo}
          members={members}
          onChange={(next) => onChange({ autoReplyReplyTo: next })}
        />

        <TemplateInput
          label="Subject"
          kind="auto_reply"
          value={form.autoReplySubject}
          multiline={false}
          onCommit={(next) => commit({ autoReplySubject: next })}
        />
        <TemplateInput
          label="Message"
          kind="auto_reply"
          value={form.autoReplyBody}
          multiline
          onCommit={(next) => commit({ autoReplyBody: next })}
        />
      </div>
    </div>
  )
}

// -------- Recipients --------

function recipientKey(recipient: FormEmailRecipient): string {
  return recipient.kind === 'member' ? `member:${recipient.memberId}` : `address:${recipient.address}`
}

function recipientText(recipient: FormEmailRecipient, members: readonly Member[]): string {
  if (recipient.kind === 'address') {
    return recipient.address
  }

  const member = members.find((candidate) => candidate.id === recipient.memberId)

  return member === undefined ? 'A former member' : `${member.name} (${member.email})`
}

/** Loose on purpose: the server has the real check, and says why it refuses. */
function looksLikeAddress(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)
}

function RecipientList({
  recipients,
  members,
  onChange,
}: {
  readonly recipients: readonly FormEmailRecipient[]
  readonly members: readonly Member[]
  readonly onChange: (next: readonly FormEmailRecipient[]) => void
}): React.JSX.Element {
  const [memberPick, setMemberPick] = useState('')
  const [address, setAddress] = useState('')
  const chosen = new Set(recipients.map(recipientKey))
  const remainingMembers = members.filter((member) => !chosen.has(`member:${member.id}`))
  const full = recipients.length >= FORM_EMAIL_MAX_RECIPIENTS
  const typed = address.trim().toLowerCase()
  const canAddAddress = !full && looksLikeAddress(typed) && !chosen.has(`address:${typed}`)

  function add(recipient: FormEmailRecipient): void {
    if (!full && !chosen.has(recipientKey(recipient))) {
      onChange([...recipients, recipient])
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-[12px] font-medium text-ink">Recipients</div>
      <ul className="divide-y divide-border">
        {recipients.length === 0 && <li className="py-2 text-[12px] text-ink-faint">No recipients yet.</li>}
        {recipients.map((recipient) => (
          <li key={recipientKey(recipient)} className="flex items-center justify-between gap-2 py-2">
            <span className="min-w-0 break-words text-[13px] text-ink">{recipientText(recipient, members)}</span>
            <button
              type="button"
              onClick={() => onChange(recipients.filter((entry) => recipientKey(entry) !== recipientKey(recipient)))}
              className="shrink-0 text-[11px] font-medium text-danger hover:underline"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Add a member"
          className={`${inputClass} min-w-[12rem] flex-1`}
          value={memberPick}
          disabled={full}
          onChange={(event) => setMemberPick(event.target.value)}
        >
          <option value="">Pick a member…</option>
          {remainingMembers.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} ({member.email})
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={memberPick.length === 0 || full}
          onClick={() => {
            add({ kind: 'member', memberId: memberPick })
            setMemberPick('')
          }}
          className="shrink-0 rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          Add
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          aria-label="Add an email address"
          placeholder="sales@yourcompany.com"
          className={`${inputClass} min-w-[12rem] flex-1`}
          value={address}
          disabled={full}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canAddAddress) {
              event.preventDefault()
              add({ kind: 'address', address: typed })
              setAddress('')
            }
          }}
        />
        <button
          type="button"
          disabled={!canAddAddress}
          onClick={() => {
            add({ kind: 'address', address: typed })
            setAddress('')
          }}
          className="shrink-0 rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <p className="text-[11px] text-ink-faint">
        Up to {FORM_EMAIL_MAX_RECIPIENTS}. A member gets it at their current account email.
      </p>
    </div>
  )
}

// -------- Reply-To --------

const NO_REPLY_TO = ''
const ADDRESS_REPLY_TO = '__address__'

function ReplyToPicker({
  value,
  members,
  onChange,
}: {
  readonly value: FormEmailRecipient | null
  readonly members: readonly Member[]
  readonly onChange: (next: FormEmailRecipient | null) => void
}): React.JSX.Element {
  const [choosingAddress, setChoosingAddress] = useState(value?.kind === 'address')
  const selected =
    value?.kind === 'member' ? value.memberId : choosingAddress || value?.kind === 'address' ? ADDRESS_REPLY_TO : NO_REPLY_TO

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink">Replies go to</span>
        <select
          className={inputClass}
          value={selected}
          onChange={(event) => {
            const next = event.target.value

            if (next === ADDRESS_REPLY_TO) {
              setChoosingAddress(true)
              return
            }

            setChoosingAddress(false)
            onChange(next === NO_REPLY_TO ? null : { kind: 'member', memberId: next })
          }}
        >
          <option value={NO_REPLY_TO}>The sending address (no Reply-To)</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} ({member.email})
            </option>
          ))}
          <option value={ADDRESS_REPLY_TO}>Another address…</option>
        </select>
      </label>

      {selected === ADDRESS_REPLY_TO && (
        <input
          key={value?.kind === 'address' ? value.address : 'new'}
          type="email"
          aria-label="Reply-To address"
          placeholder="hello@yourcompany.com"
          className={inputClass}
          defaultValue={value?.kind === 'address' ? value.address : ''}
          onBlur={(event) => {
            const next = event.target.value.trim().toLowerCase()
            const current = value?.kind === 'address' ? value.address : ''

            if (next !== current && looksLikeAddress(next)) {
              onChange({ kind: 'address', address: next })
            }
          }}
        />
      )}
    </div>
  )
}

// -------- Templates --------

/**
 * A subject or message template with placeholder chips.
 *
 * The draft follows the stored template only when it moves to a value this
 * field has not seen. A commit moves the stored value twice on a refusal: the
 * optimistic update to the draft, then the rollback to the old text, and
 * React may render either after the PATCH has settled. So the check is on
 * values, not on timing: the text being saved and the last text known to be
 * stored are both ignored. A refused draft stays in the field, marked
 * unsaved, so it can be corrected rather than typed again.
 *
 * A chip keeps the field's focus (`onMouseDown` prevents the blur) and inserts
 * at the cursor; the template commits on blur like the other text settings.
 */
function TemplateInput({
  label,
  kind,
  value,
  multiline,
  onCommit,
}: {
  readonly label: string
  readonly kind: FormEmailKind
  readonly value: string
  readonly multiline: boolean
  readonly onCommit: (next: string) => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [refused, setRefused] = useState(false)
  /** The last text known to be stored. */
  const stored = useRef(value)
  /** The text the latest commit sent. */
  const sent = useRef<string | null>(null)
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)

  useEffect(() => {
    if (value === stored.current || value === sent.current) {
      return
    }

    stored.current = value
    setDraft(value)
    setRefused(false)
  }, [value])
  const placeholders = FORM_EMAIL_PLACEHOLDERS.filter(
    (placeholder) => placeholder.scope === 'both' || kind === 'notification',
  )

  function insert(text: string): void {
    const element = ref.current
    const start = element?.selectionStart ?? draft.length
    const end = element?.selectionEnd ?? draft.length
    const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`

    setDraft(next)
    requestAnimationFrame(() => {
      element?.setSelectionRange(start + text.length, start + text.length)
    })
  }

  const shared = {
    ref,
    className: multiline ? `${inputClass} min-h-[96px] font-mono text-[12px]` : inputClass,
    value: draft,
    'aria-invalid': refused,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
    onBlur: () => {
      if (draft === value) {
        return
      }

      const text = draft

      sent.current = text
      onCommit(text)
        .then(() => {
          stored.current = text
          setRefused(false)
        })
        .catch(() => {
          // The section's error panel says why.
          setRefused(true)
        })
    },
  }

  return (
    <div>
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink">{label}</span>
        {multiline ? <textarea {...shared} /> : <input {...shared} />}
      </label>
      {refused && (
        <p className="mt-1 text-[11px] text-danger">Not saved. Correct it and leave the field to save again.</p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {placeholders.map((placeholder) => (
          <button
            key={placeholder.name}
            type="button"
            title={`Insert ${formEmailPlaceholderText(placeholder.name)}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insert(formEmailPlaceholderText(placeholder.name))}
            className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[10px] font-medium leading-none text-ink-muted hover:bg-surface"
          >
            {placeholder.label}
          </button>
        ))}
      </div>
    </div>
  )
}
