import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the notes module.
 *
 * `target` is the record the note attaches to (a person, company, deal, ...).
 * The note's own id lives in `data` so a consumer that watches records does
 * not need a second lookup to know which record the note landed on.
 */

export const notesEvents = {
  'notes.note.added': z.object({ noteId: z.string() }),
} satisfies ModuleEventCatalog

export interface NoteAddedData {
  readonly noteId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'notes.note.added': NoteAddedData
  }
}
