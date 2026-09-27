import { personIntakeDependencies } from '@kelpie/schemas'
import type { PersonIntakeItem } from '@kelpie/schemas'

/**
 * The items that can be written given what is ticked: an item whose
 * dependency is unticked, or cannot be written, drops out too.
 */
export function effectiveSelection(items: readonly PersonIntakeItem[], ticked: ReadonlySet<string>): ReadonlySet<string> {
  const keys = new Set(items.map((item) => item.key))
  const effective = new Set([...ticked].filter((key) => keys.has(key)))
  let changed = true

  while (changed) {
    changed = false
    for (const item of items) {
      if (effective.has(item.key) && personIntakeDependencies(item).some((key) => !effective.has(key))) {
        effective.delete(item.key)
        changed = true
      }
    }
  }

  return effective
}
