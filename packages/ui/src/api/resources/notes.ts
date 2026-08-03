import { createNoteBody, noteBody, noteSchema } from '@kelpie/schemas'
import type { CreateNoteInput, Note, NoteInput, RecordTargetType } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type { MutationResult, RecordListResult, UpdateArguments } from '../resource.ts'

/**
 * `/v1/notes`, attachable to any CRM record.
 *
 * A note list always names its record. There is no workspace-wide note list on
 * the API, so there is no hook for one here.
 */

const notes = createResourceHooks<Note, CreateNoteInput, NoteInput>({
  name: 'notes',
  path: '/notes',
  decode: noteSchema.parse,
  createBody: createNoteBody,
  updateBody: noteBody,
  // Writing a note writes a `note_added` activity on the same record, so a
  // timeline rendered beside the panel is stale the moment a note is added.
  alsoInvalidates: ['activities'],
})

export interface NoteFilters {
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly pinned?: boolean
}

function noteQuery(filters: NoteFilters): QueryParameters {
  return {
    target_type: filters.targetType,
    target_id: filters.targetId,
    pinned: filters.pinned,
  }
}

export function useNotes(filters: NoteFilters): RecordListResult<Note> {
  return notes.useList(noteQuery(filters))
}

export function useCreateNote(): MutationResult<CreateNoteInput, Note> {
  return notes.useCreate()
}

export function useUpdateNote(): MutationResult<UpdateArguments<NoteInput>, Note> {
  return notes.useUpdate()
}

export function useDeleteNote(): MutationResult<string, void> {
  return notes.useRemove()
}
