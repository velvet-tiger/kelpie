import type { Note, RecordTargetType } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { useTimezone } from '../api/resources/account.ts'
import { useMembers } from '../api/resources/members.ts'
import { useCreateNote, useNotes } from '../api/resources/notes.ts'
import { formatDateTime } from '../lib/dates.ts'
import { ErrorPanel } from './QueryState.tsx'
import { SectionHeader } from './SectionHeader.tsx'

/**
 * The notes on one record.
 *
 * Ports the mockup's panel. There is no pin control: the mockup renders the
 * badge on a note that carries the flag and offers no way to set it, and the
 * mockup decides what a page shows. `PATCH /v1/notes/:id` takes `pinned`, so an
 * agent can still pin.
 *
 * No edit or delete either, for the same reason, though the API has both.
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
  // API has no two-column sort, so this reorders what is loaded. Across a
  // "Load more" boundary a pinned note on a later page sorts after unpinned
  // ones already shown; pinned notes are few enough that this is the cheaper
  // wrong than a second request per panel.
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

      {notes.hasMore && (
        <button
          type="button"
          onClick={notes.loadMore}
          disabled={notes.isLoadingMore}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink-muted transition hover:border-border-strong hover:text-ink"
        >
          {notes.isLoadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
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

  return (
    <li className="rounded-md border border-border bg-surface-raised px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{note.body}</p>
        {note.pinned && (
          <span className="shrink-0 text-[10px] font-semibold tracking-wide text-accent uppercase">
            Pinned
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-faint">
        <span>{authorName}</span>
        <span>·</span>
        <span>{formatDateTime(note.createdAt, timezone)}</span>
      </div>
    </li>
  )
}
