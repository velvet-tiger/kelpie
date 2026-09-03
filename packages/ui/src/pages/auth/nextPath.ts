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
 * Only a path within this app. An absolute URL in `?next=` would turn a
 * sign-in page into an open redirect.
 */
export function safeNext(value: string | null): string {
  return value !== null && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard'
}
