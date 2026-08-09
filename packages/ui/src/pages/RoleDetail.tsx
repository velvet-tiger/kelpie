import { IN_PROCESS, ROLE_STATUS_LABELS, ROLE_STATUSES } from '@kelpie/schemas'
import type { Candidate, Note, Role, RoleInput, RoleStatus } from '@kelpie/schemas'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { usePatch } from '../api/resource.ts'
import type { PatchResult } from '../api/resource.ts'
import { useCandidates, useCreateCandidate, useDeleteCandidate } from '../api/resources/candidates.ts'
import { useCreateNote, useDeleteNote, useUpdateNote } from '../api/resources/notes.ts'
import { useCreatePerson, usePeople } from '../api/resources/people.ts'
import { useDeleteRole, useRole, useUpdateRole } from '../api/resources/roles.ts'
import { AgentTasks } from '../components/AgentTasks.tsx'
import { Chip } from '../components/Chip.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import { InlineEdit } from '../components/InlineEdit.tsx'
import { ErrorPanel, LoadingPanel, NotFoundPanel } from '../components/QueryState.tsx'
import { SectionHeader } from '../components/SectionHeader.tsx'
import {
  CandidateReferrerField,
  CandidateStageField,
  CandidateStatusField,
} from './candidateFields.tsx'
import { useCandidateNotes, usePersonNames } from './hiringDirectory.ts'

/**
 * One role, and the people up for it.
 *
 * A role has no tabs. It holds no summary, no plan and no timeline of its own —
 * it is not a record a note or an activity attaches to — so the page is the
 * candidate pipeline and nothing else, exactly as the mockup draws it.
 *
 * Deleting the role takes its candidacies with it. There is nothing to choose in
 * the confirmation, because roadmap decision 2 settles the cascade server-side.
 */

const STATUS_OPTIONS = ROLE_STATUSES.map((status) => ({
  value: status,
  label: ROLE_STATUS_LABELS[status],
}))

export function RoleDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = useRole(id)
  const deleteRole = useDeleteRole()

  if (isNotFound) {
    return <NotFoundPanel label="Role" backTo="/hiring" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading role…" />
  }

  return (
    <div className="animate-fade-in mx-auto max-w-4xl">
      <Link
        to="/hiring"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Hiring
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <RoleHeading role={record} />
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <RoleStatusField role={record} />
          <AgentTasks targetType="role" targetId={record.id} targetLabel={record.title} />
          <DeleteRecord
            recordLabel="Role"
            recordName={record.title}
            isPending={deleteRole.isPending}
            error={deleteRole.error}
            onConfirm={() => {
              deleteRole
                .runAsync(record.id)
                .then(() => navigate('/hiring'))
                .catch(() => undefined)
            }}
          />
        </div>
      </div>

      <RoleCandidates role={record} />
    </div>
  )
}

function useRolePatch(role: Role): PatchResult<RoleInput> {
  return usePatch(useUpdateRole, role)
}

function RoleHeading({ role }: { readonly role: Role }): React.JSX.Element {
  const { patch, error } = useRolePatch(role)

  return (
    <div className="min-w-0 flex-1">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <InlineEdit
        value={role.title}
        onChange={(title) => {
          patch({ title })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled role"
      />
    </div>
  )
}

function RoleStatusField({ role }: { readonly role: Role }): React.JSX.Element {
  const { patch, error } = useRolePatch(role)

  return (
    <div className="flex flex-col items-end gap-1">
      <InlineEdit
        value={role.status}
        onChange={(value) => {
          patch({ status: value as RoleStatus })
        }}
        options={STATUS_OPTIONS}
        display={
          <Chip tone={role.status === 'open' ? 'accent' : 'neutral'}>
            {ROLE_STATUS_LABELS[role.status]}
          </Chip>
        }
        displayClassName="not-italic inline-flex"
        className="!w-auto"
      />
      {error !== null && <ErrorPanel error={error} />}
    </div>
  )
}

/** The role's pipeline: everyone attached to it, whatever state they are in. */
function RoleCandidates({ role }: { readonly role: Role }): React.JSX.Element {
  const candidates = useCandidates({ roleIds: [role.id] })
  const names = usePersonNames()
  const notes = useCandidateNotes(candidates.records.map((candidate) => candidate.id))
  const createCandidate = useCreateCandidate()
  const createPerson = useCreatePerson()

  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const searchable = usePeople({ term: search.trim().length > 0 ? search.trim() : undefined })

  const attached = new Set(candidates.records.map((candidate) => candidate.personId))

  function add(personId: string): void {
    if (attached.has(personId)) {
      return
    }

    createCandidate.run({ roleId: role.id, personId })
    setAdding(false)
    setSearch('')
  }

  /**
   * A name that matched nobody becomes a person and a candidacy in one go, as
   * the mockup's picker does. The `candidate` tag is the mockup's too: someone
   * created from this box is in the workspace because of this role.
   */
  async function addNewPerson(name: string): Promise<void> {
    const person = await createPerson.runAsync({ name, tags: ['candidate'] })

    add(person.id)
  }

  return (
    <section>
      <SectionHeader
        title="Candidates"
        onAdd={() => {
          setAdding((current) => !current)
        }}
        addLabel="Add candidate"
      />

      {adding && (
        <div className="mb-3 flex gap-2">
          <div className="min-w-0 flex-1">
            <EntitySearch
              options={searchable.records
                .filter((person) => !attached.has(person.id))
                .map((person) => ({
                  id: person.id,
                  label: person.name,
                  meta: person.email ?? undefined,
                }))}
              value=""
              onChange={add}
              onQueryChange={setSearch}
              onCreate={(name) => {
                void addNewPerson(name)
              }}
              createLabel={(query) => `Create person “${query}”`}
              placeholder="Search or create a person…"
              emptyMessage="No matches"
              size="md"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setAdding(false)
              setSearch('')
            }}
            className="shrink-0 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}

      {createCandidate.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createCandidate.error} />
        </div>
      )}
      {createPerson.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createPerson.error} />
        </div>
      )}
      {candidates.error !== null && <ErrorPanel error={candidates.error} />}

      {candidates.isLoading ? (
        <LoadingPanel label="Loading candidates…" />
      ) : candidates.records.length === 0 && !adding ? (
        <p className="text-[13px] text-ink-faint">No candidates yet.</p>
      ) : (
        <ul className="overflow-hidden rounded-md border border-border">
          {candidates.records.map((candidate) => (
            <CandidateRow
              key={candidate.id}
              candidate={candidate}
              personName={names.nameFor(candidate.personId)}
              referrerName={
                candidate.referrerPersonId === null
                  ? undefined
                  : names.nameFor(candidate.referrerPersonId)
              }
              note={notes.noteFor(candidate.id)}
              noteResolved={notes.isComplete || notes.noteFor(candidate.id) !== undefined}
            />
          ))}
        </ul>
      )}

      {candidates.hasMore && (
        <button
          type="button"
          onClick={candidates.loadMore}
          disabled={candidates.isLoadingMore}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
        >
          {candidates.isLoadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  )
}

function CandidateRow({
  candidate,
  personName,
  referrerName,
  note,
  noteResolved,
}: {
  readonly candidate: Candidate
  readonly personName: string | undefined
  readonly referrerName: string | undefined
  readonly note: Note | undefined
  readonly noteResolved: boolean
}): React.JSX.Element {
  const removeCandidate = useDeleteCandidate()

  return (
    <li className="border-b border-border px-4 py-3.5 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Link
          to={`/people/${candidate.personId}`}
          className="text-left text-[13px] font-medium text-ink hover:text-accent"
        >
          {personName ?? candidate.personId}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <AgentTasks
            targetType="candidate"
            targetId={candidate.id}
            targetLabel={personName ?? candidate.personId}
            compact
          />
          <CandidateStatusField candidate={candidate} />
          {candidate.status === IN_PROCESS && <CandidateStageField candidate={candidate} />}
          <button
            type="button"
            onClick={() => {
              removeCandidate.run(candidate.id)
            }}
            className="text-[11px] font-medium text-danger hover:underline"
          >
            Remove
          </button>
        </div>
      </div>

      {removeCandidate.error !== null && (
        <div className="mt-2">
          <ErrorPanel error={removeCandidate.error} />
        </div>
      )}

      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="mb-1 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
            Referrer
          </dt>
          <dd>
            <CandidateReferrerField candidate={candidate} referrerName={referrerName} />
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
            Note
          </dt>
          <dd>
            <CandidateNote candidate={candidate} existing={note} resolved={noteResolved} />
          </dd>
        </div>
      </dl>
    </li>
  )
}

/**
 * The candidate's most recent interview note, editable in place.
 *
 * The mockup edits one note here and shows the full panel on the person's Hiring
 * tab, and this reproduces that. The note arrives from the page rather than
 * being fetched here: `?target_id=` names a set, so the whole pipeline's notes
 * come back in one request with the candidates.
 *
 * `resolved` false means the pipeline holds more notes than one page returns and
 * this candidate was not among them, so whether they have one is unknown. It
 * renders as unknown rather than as "Add note…", because offering to write is
 * offering to write over a note nobody looked at.
 */
function CandidateNote({
  candidate,
  existing,
  resolved,
}: {
  readonly candidate: Candidate
  readonly existing: Note | undefined
  readonly resolved: boolean
}): React.JSX.Element {
  const createNote = useCreateNote()
  const updateNote = useUpdateNote()
  const deleteNote = useDeleteNote()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(existing?.body ?? '')

  useEffect(() => {
    if (!editing) {
      setDraft(existing?.body ?? '')
    }
  }, [existing, editing])

  function submit(event: FormEvent): void {
    event.preventDefault()

    const body = draft.trim()

    if (body.length === 0) {
      if (existing !== undefined) {
        deleteNote.run(existing.id)
      }
    } else if (existing === undefined) {
      createNote.run({ targetType: 'candidate', targetId: candidate.id, body })
    } else if (body !== existing.body) {
      updateNote.run({ id: existing.id, changes: { body } })
    }

    setEditing(false)
  }

  if (!resolved) {
    return <p className="text-[12px] text-ink-faint">Not loaded on this page.</p>
  }

  if (editing) {
    return (
      <form onSubmit={submit} className="space-y-2">
        <textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          rows={3}
          autoFocus
          placeholder="Hiring note…"
          className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(existing?.body ?? '')
              setEditing(false)
            }}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-fg hover:bg-accent-hover"
          >
            Save
          </button>
        </div>
      </form>
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        setEditing(true)
      }}
      className={
        existing === undefined
          ? 'text-[12px] text-ink-faint hover:text-accent'
          : 'block w-full text-left text-[12px] leading-relaxed text-ink-muted hover:text-ink'
      }
    >
      {existing?.body ?? 'Add note…'}
    </button>
  )
}
