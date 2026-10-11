/**
 * Where a signed-out page sends the browser once it is signed in.
 *
 * Its own file rather than beside the form controls: a module exporting a
 * component and a function from one file loses Fast Refresh, and this is
 * exported to modules, which is the reason it is not page-local. A module
 * contributing a sign-in method is handed the result and has to be able to
 * rely on what it means.
 */

/**
 * A backslash, or a control character: U+0000 to U+001F and U+007F, which
 * are the ASCII ones, and U+0080 to U+009F, which the same Unicode class
 * holds. Neither has a place in a path this app makes.
 */
const REFUSED_CHARACTERS = /[\\\p{Cc}]/u

/**
 * Only a path within this app. An absolute URL in `?next=` would turn a
 * sign-in page into an open redirect.
 *
 * `//host` is another site, so the second character must not be a slash. A
 * browser also reads `\` as `/`, and it removes a tab or a line break from a
 * URL before it reads it. So `/\host` and `/<tab>/host` are another site too,
 * and a value with a backslash or a control character anywhere is refused.
 * The result may go to `window.location`, which applies those browser rules.
 */
export function safeNext(value: string | null): string {
  if (value === null || !value.startsWith('/') || value.startsWith('//') || REFUSED_CHARACTERS.test(value)) {
    return '/dashboard'
  }

  return value
}
