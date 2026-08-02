/**
 * Which fields a PATCH actually changed.
 *
 * `record.updated` carries the changed fields, and a consumer that acts on
 * "summary changed" should not be woken by a request that resent the summary it
 * already had. A PATCH that changes nothing is also a write worth not doing:
 * bumping `updated_at` for it would make every record look freshly touched.
 */

/** Dates compare by instant. Everything else compares by its JSON form, which covers arrays and objects. */
function sameValue(before: unknown, after: unknown): boolean {
  if (before instanceof Date && after instanceof Date) {
    return before.getTime() === after.getTime()
  }

  return JSON.stringify(before) === JSON.stringify(after)
}

/**
 * @param before The stored record.
 * @param changes Partial by PATCH semantics: an absent key means "leave it", so
 *   only the keys present here are considered. A key `before` does not carry
 *   counts as a change, which is what a column added since the row was written
 *   should look like.
 */
export function changedKeys(
  before: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
): readonly string[] {
  const changed: string[] = []

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      continue
    }

    if (!sameValue(before[key], value)) {
      changed.push(key)
    }
  }

  return changed
}
