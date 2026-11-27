import type { Activity, Note } from '@kelpie/schemas'

/**
 * Who a timeline row or a note is attributed to, when no member can be named.
 *
 * A member who leaves a workspace, or deletes their account, takes their
 * member row with them. What they wrote stays, and its member reference is
 * cleared, so the row names nobody. The other fields still say a member did
 * it: a note keeps `origin: 'member'`, and an activity has no label, which
 * only a member's activity lacks.
 */
export const FORMER_MEMBER_LABEL = 'Former member'

/**
 * The name to show beside a note, or undefined for none.
 *
 * A note an agent or the hosted AI wrote with no member behind it shows no
 * name: the origin label beside the date says what wrote it. One from before
 * origin was recorded has no such label, so a null author there still reads
 * as the workspace key it almost always was. A null author on a member's note
 * is a member who has since gone.
 */
export function noteAuthorName(
  note: Pick<Note, 'authorId' | 'origin'>,
  nameById: ReadonlyMap<string, string>,
): string | undefined {
  if (note.authorId !== null) {
    return nameById.get(note.authorId) ?? 'Unknown'
  }

  switch (note.origin) {
    case 'member':
      return FORMER_MEMBER_LABEL
    case 'unknown':
      return 'API key'
    case 'agent':
    case 'ai':
      return undefined
  }
}

/**
 * The name to show beside an activity.
 *
 * Exactly one of the two actor columns is set when the row is written.
 * `actorLabel` carries the display name when nothing on the team did it:
 * "Form", "Gmail", "API key". Both are null only once the member behind it
 * has gone.
 */
export function activityActorName(
  activity: Pick<Activity, 'actorMemberId' | 'actorLabel'>,
  nameById: ReadonlyMap<string, string>,
): string {
  if (activity.actorMemberId === null) {
    return activity.actorLabel ?? FORMER_MEMBER_LABEL
  }

  return nameById.get(activity.actorMemberId) ?? 'Unknown'
}
