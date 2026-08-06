import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import { describeNote } from '../activities/wording.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import type { Actor } from '../auth/actor.ts'
import { actorMemberId, requireWorkspaceId } from '../auth/actor.ts'
import { missingTargets } from '../recordTargets.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import * as repository from './repository.ts'
import { DEFAULT_NOTE_SORT, NOTE_SORTS } from './repository.ts'
import type { NoteFilters, NoteRecord } from './repository.ts'

/**
 * Notes: what a person wrote down about a record.
 *
 * The target is polymorphic and has no foreign key, so this service is what
 * refuses a note attached to an id that does not exist or belongs to another
 * workspace. Nothing in the database would.
 *
 * Writing a note is history: it records a `note_added` activity in the same
 * transaction, so a note that commits always has the timeline entry announcing
 * it. Editing one does not. A note's body changing is not an event anyone needs
 * on a timeline, and a row per typo fix would bury the entries that matter.
 */

export interface NotesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
}

/** A note as the API returns one: the stored row minus the tenancy column. */
export type NoteView = Omit<NoteRecord, 'workspaceId'>

export interface CreateNoteInput {
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly body: string
  readonly pinned: boolean
}

/** PATCH semantics: an absent field is left alone. The target never moves. */
export interface UpdateNoteInput {
  readonly body?: string | undefined
  readonly pinned?: boolean | undefined
}

export interface NotesService {
  list(actor: Actor, filters: NoteFilters, query: ListQueryParameters): Promise<Page<NoteView>>
  get(actor: Actor, id: string): Promise<NoteView>
  create(actor: Actor, input: CreateNoteInput): Promise<NoteView>
  update(actor: Actor, id: string, changes: UpdateNoteInput): Promise<NoteView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: NoteRecord): NoteView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

export function createNotesService(dependencies: NotesDependencies): NotesService {
  async function require(workspaceId: string, id: string): Promise<NoteRecord> {
    const note = await repository.findNote(dependencies.db, workspaceId, id)

    // A note in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (note === undefined) {
      throw AppError.notFound('Note not found')
    }

    return note
  }

  /**
   * Every id has to resolve. One that does not fails the whole list rather than
   * being dropped from the set: a caller asking about five records and getting
   * four records' notes back has no way to tell which of the five it asked about
   * was the empty one.
   */
  async function requireTargets(
    workspaceId: string,
    targetType: RecordTargetType,
    targetIds: readonly string[],
  ): Promise<void> {
    const missing = await missingTargets(dependencies.db, workspaceId, targetType, targetIds)

    if (missing.length > 0) {
      throw AppError.notFound('Record not found')
    }
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)

      await requireTargets(workspaceId, filters.targetType, filters.targetIds)

      const window = readListWindow(query, NOTE_SORTS, DEFAULT_NOTE_SORT)
      const rows = await repository.listNotes(dependencies.db, workspaceId, filters, window)

      return mapPage(
        toPage(rows, window, (note) => note.id),
        toView,
      )
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      await requireTargets(workspaceId, input.targetType, [input.targetId])

      const id = dependencies.createId('note')

      return dependencies.transaction(async ({ tx, events }) => {
        const created = await repository.insertNote(tx, {
          id,
          workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
          body: input.body,
          authorId: actorMemberId(actor),
          pinned: input.pinned,
        })

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: input.targetType,
          targetId: input.targetId,
          kind: 'note_added',
          ...describeNote(input.body),
        })

        // `note.added` rather than `record.created`: the catalog gives notes
        // their own event, carrying the target, because a consumer watching a
        // record wants the note without a second lookup to find out what it is
        // attached to.
        events.emit('note.added', {
          workspaceId,
          noteId: created.id,
          targetType: created.targetType,
          targetId: created.targetId,
        })

        return toView(created)
      })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const columns: Partial<repository.NoteColumns> = {
        ...(changes.body === undefined ? {} : { body: changes.body }),
        ...(changes.pinned === undefined ? {} : { pinned: changes.pinned }),
      }
      const changed = changedKeys(existing, columns)

      // A PATCH that changes nothing is not a write. Bumping `updated_at` for it
      // would make the note look freshly touched to anything sorting by it.
      if (changed.length === 0) {
        return toView(existing)
      }

      // No event. The catalog carries `note.added` and nothing for a note
      // changing or going away, and inventing one here would add a name the
      // webhooks engine has never been told about. Recorded as a follow-up.
      return dependencies.transaction(async ({ tx }) => {
        const updated = await repository.updateNote(tx, workspaceId, id, {
          ...columns,
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Note not found')
        }

        return toView(updated)
      })
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(async ({ tx }) => {
        await require(workspaceId, id)
        await repository.deleteNote(tx, workspaceId, id)

        // The `note_added` activity stays. It records something that did
        // happen, and rewriting history to match the present is what an
        // append-only table exists to prevent.
      })
    },
  }
}
