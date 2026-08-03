/**
 * The sentence an activity row carries.
 *
 * The timeline renders `<actor> <action>` with `detail` beneath it, so the
 * phrasing is data, not presentation, and it is decided here rather than in
 * five services. Pure functions with no database and no clock: what a person
 * sees on a timeline is worth a unit test, and this is the shape that gets one.
 *
 * The phrasings match the ones the mockup's seeded activity carries
 * (`mockups/src/data/seed.ts`), because that seed is what the panel was designed
 * against.
 */

/** What an activity says happened, ready to store. */
export interface ActivityWording {
  readonly action: string
  readonly detail: string | null
}

/** Human labels for the fields of one resource, keyed by their `camelCase` column name. */
export type FieldLabels = Readonly<Record<string, string>>

/**
 * A value fit to print inside `old → new`.
 *
 * Arrays and objects are excluded on purpose. A tags array rendered as JSON is
 * noise on a timeline, and there is no short honest rendering of "these five
 * social profiles became those four", so the change is reported without a
 * before-and-after rather than with an unreadable one.
 */
function printable(value: unknown): string | undefined {
  if (value === null) {
    return 'none'
  }

  if (typeof value === 'string') {
    return value.length === 0 ? 'none' : value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  return undefined
}

function labelFor(labels: FieldLabels, field: string): string {
  return labels[field] ?? field
}

/** `created Person`, `created Company`. */
export function describeCreation(objectLabel: string): ActivityWording {
  return { action: `created ${objectLabel}`, detail: null }
}

/**
 * One changed field reads as itself; several read as a count.
 *
 * `changed Influence` with `influencer → decision_maker` says more than
 * `changed 1 attribute`, and past one field the before-and-after stops fitting
 * on a line, so the detail becomes the list of what moved.
 *
 * @param changed The field names `changedKeys` returned, in `camelCase`.
 * @param before The stored record, for the single-field before-and-after.
 * @param after The values being written.
 */
export function describeUpdate(
  changed: readonly string[],
  labels: FieldLabels,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): ActivityWording {
  const first = changed[0]

  if (changed.length === 1 && first !== undefined) {
    const from = printable(before[first])
    const to = printable(after[first])

    return {
      action: `changed ${labelFor(labels, first)}`,
      detail: from === undefined || to === undefined ? null : `${from} → ${to}`,
    }
  }

  return {
    action: `changed ${String(changed.length)} attributes`,
    detail: changed.map((field) => labelFor(labels, field)).join(', '),
  }
}

/** `linked to company` with the far side's name beneath it. */
export function describeLink(relatedLabel: string, relatedName: string): ActivityWording {
  return { action: `linked to ${relatedLabel}`, detail: relatedName }
}

/**
 * `unlinked from company`, the mirror of `describeLink`.
 *
 * The far side is named for the same reason it is named on the link: the row
 * lands on each end's timeline, and `unlinked from company` alone leaves the
 * reader asking which one.
 */
export function describeUnlink(relatedLabel: string, relatedName: string): ActivityWording {
  return { action: `unlinked from ${relatedLabel}`, detail: relatedName }
}

/** `moved to Proposal`, with where it came from beneath. */
export function describeStageChange(fromStage: string, toStage: string): ActivityWording {
  return { action: `moved to ${toStage}`, detail: `${fromStage} → ${toStage}` }
}

/** How much of a note's body the timeline repeats before trailing off. */
const NOTE_EXCERPT_LENGTH = 120

/**
 * `added a note`, with the opening of the note beneath it.
 *
 * The excerpt is what makes the row worth reading without leaving the timeline.
 * It is truncated on a character count rather than a word boundary because a
 * note has no guaranteed whitespace.
 */
export function describeNote(body: string): ActivityWording {
  const trimmed = body.trim()
  const excerpt =
    trimmed.length > NOTE_EXCERPT_LENGTH
      ? `${trimmed.slice(0, NOTE_EXCERPT_LENGTH).trimEnd()}…`
      : trimmed

  return { action: 'added a note', detail: excerpt.length === 0 ? null : excerpt }
}
