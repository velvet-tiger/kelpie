import type { Note } from '@kelpie/schemas'
import { useMemo } from 'react'

import { useCandidates } from '../api/resources/candidates.ts'
import { useNotes } from '../api/resources/notes.ts'
import { usePeople } from '../api/resources/people.ts'
import { useRoles } from '../api/resources/roles.ts'

/**
 * The counts and names the hiring pages need beside their own records.
 *
 * A candidacy carries two ids and no words, so every page showing one needs a
 * second resource to render it. `api.md` has no include-expansion; it has
 * repeatable id filters, so each of these asks about exactly the rows on screen:
 * one extra request for the page rather than one per row.
 */

/** `api.md`: `?limit=` and an id filter both max out at 200. */
const MAX_PAGE = 200

export interface RoleCandidateCounts {
  countFor(roleId: string): number
  readonly isLoading: boolean
  /**
   * False when these roles hold more candidacies than one page could return, so
   * the counts are floors rather than totals. The page says so instead of
   * printing a number it cannot stand behind.
   */
  readonly isComplete: boolean
}

export function useRoleCandidateCounts(roleIds: readonly string[]): RoleCandidateCounts {
  const candidates = useCandidates({ roleIds, limit: MAX_PAGE }, { enabled: roleIds.length > 0 })

  const countByRole = useMemo(() => {
    const counts = new Map<string, number>()

    for (const candidate of candidates.records) {
      counts.set(candidate.roleId, (counts.get(candidate.roleId) ?? 0) + 1)
    }

    return counts
  }, [candidates.records])

  return {
    countFor: (roleId) => countByRole.get(roleId) ?? 0,
    isLoading: candidates.isLoading,
    isComplete: !candidates.hasMore,
  }
}

export interface CandidateNotes {
  /** The candidate's most recent note, or undefined when they have none. */
  noteFor(candidateId: string): Note | undefined
  readonly isLoading: boolean
  /**
   * False when these candidates hold more notes than one page could return.
   *
   * A candidate whose note is in the answer is showing their newest one: the
   * list arrives newest first across the whole set, so a truncated page cannot
   * hold an older note of theirs without the newer one. Only an *absent*
   * candidate is ambiguous, and the caller says so rather than offering to
   * write a second note over the one it did not fetch.
   */
  readonly isComplete: boolean
}

/**
 * The most recent note on each candidate in a pipeline.
 *
 * One request for the whole list rather than one per row. `?target_id=` on notes
 * repeats to name a set, so a page rendering a note per candidate resolves them
 * the way every other related column here does.
 */
export function useCandidateNotes(candidateIds: readonly string[]): CandidateNotes {
  const notes = useNotes(
    { targetType: 'candidate', targetIds: candidateIds, limit: MAX_PAGE },
    { enabled: candidateIds.length > 0 },
  )

  const newestByCandidate = useMemo(() => {
    const newest = new Map<string, Note>()

    // `-created_at` is the default sort, so the first note seen for a candidate
    // is theirs to show and anything later is older.
    for (const note of notes.records) {
      if (!newest.has(note.targetId)) {
        newest.set(note.targetId, note)
      }
    }

    return newest
  }, [notes.records])

  return {
    noteFor: (candidateId) => newestByCandidate.get(candidateId),
    isLoading: notes.isLoading,
    isComplete: !notes.hasMore,
  }
}

export interface RoleTitles {
  titleFor(roleId: string): string | undefined
  readonly isLoading: boolean
}

/**
 * Titles for the roles a person is up for.
 *
 * The whole first page rather than an id filter, because `/v1/roles` has no
 * `?id=` and a workspace's open roles are few. A title missing past that page
 * falls back to the id, which is wrong-looking rather than silently blank.
 */
export function useRoleTitles(): RoleTitles {
  const roles = useRoles({ limit: MAX_PAGE })

  const titleById = useMemo(
    () => new Map(roles.records.map((role) => [role.id, role.title])),
    [roles.records],
  )

  return { titleFor: (roleId) => titleById.get(roleId), isLoading: roles.isLoading }
}

export interface PersonNames {
  nameFor(personId: string): string | undefined
  readonly isLoading: boolean
}

/**
 * Names for a set of people, from the directory's first page.
 *
 * `/v1/people` has no `?id=` filter, so this is the same compromise
 * `RaiseKeyPeople` makes: past the first page a name is missing rather than
 * wrong, and the caller falls back to the id instead of rendering a blank.
 */
export function usePersonNames(): PersonNames {
  const people = usePeople({ limit: MAX_PAGE })

  const nameById = useMemo(
    () => new Map(people.records.map((person) => [person.id, person.name])),
    [people.records],
  )

  return { nameFor: (personId) => nameById.get(personId), isLoading: people.isLoading }
}
