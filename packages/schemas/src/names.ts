/**
 * Building a person's display name out of its parts.
 *
 * One direction only. A name is composed when a caller supplied parts and no
 * name; parts are never derived by splitting a name. Splitting is a guess, and a
 * stored guess is indistinguishable from something a person typed: "van der
 * Berg" is one surname written as three words, "Ursula K. Le Guin" is four
 * tokens over two names, a mononym is neither a first nor a last name, and half
 * the world writes the family name first. `name` stays the record's canonical
 * display string, which is why every consumer that renders a person keeps
 * reading it and nothing else.
 */

/**
 * The parts a display name is built from, in the order they are written.
 *
 * Each accepts `undefined` as well as `null` so that a caller holding either
 * shape — a nullable column, an absent CSV cell, an omitted request field — can
 * pass what it has without first flattening the two. Both mean the same thing
 * here: nothing to contribute.
 */
export interface NameParts {
  readonly firstName?: string | null | undefined
  readonly lastName?: string | null | undefined
  readonly suffix?: string | null | undefined
}

/**
 * The parts joined, single-spaced.
 *
 * `salutation` is deliberately not a parameter. "Mr" is a form of address rather
 * than part of the name, and a list of people reading "Mr John Smith" is a list
 * nobody asked for. vCard draws the same line: honorific prefixes sit in `N`,
 * away from the `FN` a client displays.
 *
 * The order is fixed rather than per-locale, because this composes a *fallback*
 * for a record that arrived without a display name. A workspace that writes the
 * family name first sets `name` itself, which is the whole reason that field is
 * the canonical one.
 *
 * @returns The composed name, or `''` when no part carried anything. An empty
 *   answer is the caller's signal that there is nothing here to fall back to.
 */
export function composeName(parts: NameParts): string {
  return [parts.firstName, parts.lastName, parts.suffix]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' ')
}
