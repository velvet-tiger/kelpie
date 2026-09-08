import type { Note, RecordTargetType } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { useTimezone } from '../api/resources/account.ts'
import { useMembers } from '../api/resources/members.ts'
import { useCreateNote, useDeleteNote, useNotes, useUpdateNote } from '../api/resources/notes.ts'
import { formatDateTime } from '../lib/dates.ts'
import { Paginator } from './Paginator.tsx'
import { ErrorPanel } from './QueryState.tsx'
import { SectionHeader } from './SectionHeader.tsx'

/**
 * The notes on one record.
 *
 * Notes can be created, edited, and deleted here. There is no pin control: the
 * mockup renders the badge on a note that carries the flag and offers no way to
 * set it. `PATCH /v1/notes/:id` takes `pinned`, so an agent can still pin.
 */

export interface NotesPanelProps {
  readonly targetType: RecordTargetType
  readonly targetId: string
}

export function NotesPanel({ targetType, targetId }: NotesPanelProps): React.JSX.Element {
  const notes = useNotes({ targetType, targetIds: [targetId] })
  const members = useMembers()
  const createNote = useCreateNote()
  const [adding, setAdding] = useState(false)
  const [body, setBody] = useState('')

  // Pinned first, then newest. The list arrives in `-created_at` order and the
  // API has no two-column sort, so this reorders what is on this page. Across
  // page boundaries a pinned note on a later page sorts after unpinned ones on
  // an earlier one; pinned notes are few enough that this is the cheaper wrong
  // than a second request per panel.
  const ordered = [...notes.records].sort((left, right) => Number(right.pinned) - Number(left.pinned))

  function reset(): void {
    setAdding(false)
    setBody('')
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    const text = body.trim()

    if (text.length === 0) {
      return
    }

    createNote.run({ targetType, targetId, body: text })
    reset()
  }

  return (
    <section>
      <SectionHeader
        title="Notes"
        onAdd={() => {
          setAdding((current) => !current)
        }}
        addLabel="Add note"
      />

      {createNote.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createNote.error} />
        </div>
      )}
      {notes.error !== null && <ErrorPanel error={notes.error} />}

      {adding && (
        <form onSubmit={submit} className="mb-3 space-y-2">
          <textarea
            value={body}
            onChange={(event) => {
              setBody(event.target.value)
            }}
            placeholder="Write a note…"
            rows={3}
            autoFocus
            className="w-full resize-y rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover"
            >
              Save note
            </button>
          </div>
        </form>
      )}

      {notes.isLoading && <p className="text-[13px] text-ink-faint">Loading notes…</p>}

      {!notes.isLoading && ordered.length === 0 && !adding ? (
        <p className="text-[13px] text-ink-faint">No notes yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {ordered.map((note) => (
            <NoteItem key={note.id} note={note} authorName={authorNameFor(note, members.nameById)} />
          ))}
        </ul>
      )}

      <Paginator list={notes} />
    </section>
  )
}

/**
 * A null author is a note written by a workspace API key, which belongs to the
 * workspace rather than to a person. An id with no matching member is one whose
 * membership was removed.
 */
function authorNameFor(note: Note, nameById: ReadonlyMap<string, string>): string {
  if (note.authorId === null) {
    return 'API key'
  }

  return nameById.get(note.authorId) ?? 'Unknown'
}

function NoteItem({
  note,
  authorName,
}: {
  readonly note: Note
  readonly authorName: string
}): React.JSX.Element {
  const timezone = useTimezone()
  const updateNote = useUpdateNote()
  const deleteNote = useDeleteNote()
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [draft, setDraft] = useState(note.body)

  function cancelEdit(): void {
    setDraft(note.body)
    setEditing(false)
  }

  function submitEdit(event: FormEvent): void {
    event.preventDefault()

    const text = draft.trim()

    if (text.length === 0) {
      return
    }

    if (text !== note.body) {
      updateNote.run({ id: note.id, changes: { body: text } })
    }

    setEditing(false)
  }

  if (editing) {
    return (
      <li className="rounded-md border border-border bg-surface-raised px-3.5 py-3">
        <form onSubmit={submitEdit} className="space-y-2">
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
            rows={3}
            autoFocus
            className="w-full resize-y rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover"
            >
              Save
            </button>
          </div>
        </form>
        {updateNote.error !== null && (
          <div className="mt-2">
            <ErrorPanel error={updateNote.error} />
          </div>
        )}
      </li>
    )
  }

  return (
    <li className="group rounded-md border border-border bg-surface-raised px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{note.body}</p>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {note.pinned && (
            <span className="text-[10px] font-semibold tracking-wide text-accent uppercase">Pinned</span>
          )}
          {confirmingDelete ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-[11px] text-ink-muted">Delete this note?</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false)
                }}
                className="rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteNote.isPending}
                onClick={() => {
                  deleteNote.run(note.id)
                  setConfirmingDelete(false)
                }}
                className="rounded-md bg-danger px-2 py-0.5 text-[11px] font-semibold text-danger-fg transition hover:opacity-90 disabled:opacity-50"
              >
                {deleteNote.isPending ? 'Deleting…' : 'Delete note'}
              </button>
            </div>
          ) : (
            <span className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                onClick={() => {
                  setDraft(note.body)
                  setEditing(true)
                }}
                className="rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(true)
                }}
                className="rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-danger-soft hover:text-danger"
              >
                Delete
              </button>
            </span>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-faint">
        <span>{authorName}</span>
        <span>·</span>
        <span>{formatDateTime(note.createdAt, timezone)}</span>
      </div>
      {deleteNote.error !== null && (
        <div className="mt-2">
          <ErrorPanel error={deleteNote.error} />
        </div>
      )}
    </li>
  )
}
